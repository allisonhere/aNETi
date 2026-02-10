#!/bin/bash
set -euo pipefail

# ============================================================================
# AnetI release script
# Phase 1: build + GitHub release
# Phase 2 hook: AUR publish placeholder
# ============================================================================

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ============================================================================
# CONFIG
# ============================================================================

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_NAME="aneti"
DIST_DIR="$PROJECT_DIR/dist"
DEFAULT_BRANCH="main"
REMOTE_REPO="${REMOTE_REPO:-}"

# Optional external publish targets (phase 2)
PACKAGE_REPO_DIR="${PACKAGE_REPO_DIR:-$HOME/your-package-repo}"

# Runtime flags
DRY_RUN=0
AUTO_YES=0
GITHUB_ONLY=0
WITH_AUR=0
WAIT_INSTALLERS=0

# Runtime state
STEP_START=0
TOTAL_START=0
VERSION=""
NEXT_VERSION=""
RELEASE_ASSETS=()
NOTES_FILE=""
TAG=""

# ============================================================================
# UTILITIES
# ============================================================================

print_header() {
  clear
  echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║${NC}               ${BOLD}${CYAN}AnetI Release Builder${NC}                        ${BLUE}║${NC}"
  echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
  echo ""
}

print_step() {
  local step=$1
  local total=$2
  local msg=$3
  STEP_START=$(date +%s)
  echo ""
  echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}${CYAN}[$step/$total]${NC} ${BOLD}$msg${NC}"
  echo -e "${MAGENTA}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

print_substep() { echo -e "  ${DIM}→${NC} $1"; }
print_success() { echo -e "  ${GREEN}✓${NC} $1 ${DIM}($(($(date +%s) - STEP_START))s)${NC}"; }
print_error() { echo -e "  ${RED}✗${NC} $1"; }
print_warning() { echo -e "  ${YELLOW}⚠${NC} $1"; }
print_info() { echo -e "  ${BLUE}ℹ${NC} $1"; }

format_time() {
  local seconds=$1
  if [ "$seconds" -ge 60 ]; then
    echo "$((seconds / 60))m $((seconds % 60))s"
  else
    echo "${seconds}s"
  fi
}

print_file_size() {
  local file=$1
  [ -f "$file" ] || return 0
  echo -e "  ${GREEN}✓${NC} $(basename "$file") ${DIM}($(du -h "$file" | cut -f1))${NC}"
}

confirm_or_exit() {
  local prompt="$1"
  if [ "$AUTO_YES" -eq 1 ]; then
    return 0
  fi
  read -r -p "  $prompt [y/N]: " ans
  case "${ans:-}" in
  y | Y | yes | YES) ;;
  *)
    print_error "Aborted by user"
    exit 1
    ;;
  esac
}

run_cmd() {
  if [ "$DRY_RUN" -eq 1 ]; then
    print_info "[dry-run] $*"
    return 0
  fi
  "$@"
}

spinner() {
  local pid=$1
  local msg=$2
  local spin='|/-\'
  local i=0
  tput civis
  while kill -0 "$pid" 2>/dev/null; do
    i=$(((i + 1) % 4))
    printf "\r  ${CYAN}%s${NC} %s" "${spin:$i:1}" "$msg"
    sleep 0.1
  done
  tput cnorm
  printf "\r"
}

run_with_spinner() {
  local msg=$1
  shift
  if [ "$DRY_RUN" -eq 1 ]; then
    print_info "[dry-run] $*"
    print_success "$msg"
    return 0
  fi
  "$@" >/tmp/aneti_release_cmd.log 2>&1 &
  local pid=$!
  spinner "$pid" "$msg"
  wait "$pid" || {
    print_error "$msg"
    tail -20 /tmp/aneti_release_cmd.log
    return 1
  }
  print_success "$msg"
}

require_cli() {
  local cmd=$1
  command -v "$cmd" >/dev/null 2>&1 || {
    print_error "Missing required CLI: $cmd"
    return 1
  }
}

resolve_remote_repo() {
  if [ -n "$REMOTE_REPO" ]; then
    return 0
  fi

  local remote_url
  remote_url=$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null || true)
  if [ -z "$remote_url" ]; then
    return 1
  fi

  # Supports:
  # git@github.com:owner/repo.git
  # https://github.com/owner/repo.git
  remote_url="${remote_url%.git}"
  REMOTE_REPO=$(echo "$remote_url" | sed -E 's#(git@github.com:|https://github.com/)##')
  [ -n "$REMOTE_REPO" ]
}

extract_release_notes() {
  local version="$1"
  local changelog="$PROJECT_DIR/CHANGELOG.md"
  [ -f "$changelog" ] || return 1

  local tmp
  tmp=$(mktemp)
  awk -v target="$version" '
    BEGIN { in_section=0 }
    $0 ~ "^## \\[" target "\\]" { in_section=1; next }
    in_section && $0 ~ "^## \\[" { in_section=0 }
    in_section { print }
  ' "$changelog" >"$tmp"

  if [ -s "$tmp" ]; then
    NOTES_FILE="$tmp"
    return 0
  fi

  awk '
    BEGIN { in_section=0 }
    $0 ~ "^## \\[Unreleased\\]" { in_section=1; next }
    in_section && $0 ~ "^## \\[" { in_section=0 }
    in_section { print }
  ' "$changelog" >"$tmp"

  if [ -s "$tmp" ]; then
    NOTES_FILE="$tmp"
    return 0
  fi

  rm -f "$tmp"
  return 1
}

# ============================================================================
# PREFLIGHT CHECKS
# ============================================================================

preflight_release() {
  print_substep "Running preflight checks..."

  [ -f "$PROJECT_DIR/package.json" ] || {
    print_error "package.json not found in $PROJECT_DIR"
    return 1
  }
  [ -f "$PROJECT_DIR/package-lock.json" ] || {
    print_error "package-lock.json not found in $PROJECT_DIR"
    return 1
  }
  [ -f "$PROJECT_DIR/.github/workflows/build-release-installers.yml" ] || {
    print_warning "Installer workflow missing: .github/workflows/build-release-installers.yml"
  }
  [ -f "$PROJECT_DIR/.github/workflows/docker-publish.yml" ] || {
    print_warning "Docker publish workflow missing: .github/workflows/docker-publish.yml"
  }

  require_cli git
  require_cli npm
  require_cli node
  require_cli gh
  require_cli tar
  require_cli sha256sum

  if [ "$DRY_RUN" -eq 0 ]; then
    gh auth status >/dev/null 2>&1 || {
      print_error "GitHub CLI not authenticated. Run: gh auth login"
      return 1
    }
  else
    print_info "[dry-run] skipping gh auth validation"
  fi

  resolve_remote_repo || {
    print_error "Could not resolve GitHub repo. Set REMOTE_REPO=owner/repo."
    return 1
  }
  print_info "Repo: $REMOTE_REPO"

  local branch
  branch=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD)
  if [ "$branch" != "$DEFAULT_BRANCH" ]; then
    print_warning "Current branch is '$branch' (expected '$DEFAULT_BRANCH')"
    confirm_or_exit "Continue anyway?"
  fi

  if [ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]; then
    print_warning "Working tree has uncommitted changes"
    confirm_or_exit "Continue with dirty working tree?"
  fi

  print_success "Preflight checks passed"
}

# ============================================================================
# VERSION MANAGEMENT
# ============================================================================

read_version() {
  VERSION=$(node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('$PROJECT_DIR/package.json','utf8'));process.stdout.write(String(p.version||''));")
  if [ -z "$VERSION" ]; then
    VERSION="0.0.0"
  fi
}

suggest_next_patch() {
  NEXT_VERSION=""
  if [[ $VERSION =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    NEXT_VERSION="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] + 1))"
  fi
}

suggest_next_minor() {
  if [[ $VERSION =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "${BASH_REMATCH[1]}.$((BASH_REMATCH[2] + 1)).0"
  fi
}

suggest_next_major() {
  if [[ $VERSION =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "$((BASH_REMATCH[1] + 1)).0.0"
  fi
}

bump_version() {
  read_version
  suggest_next_patch
  local next_minor
  local next_major
  next_minor=$(suggest_next_minor)
  next_major=$(suggest_next_major)
  echo -e "\n  Current version: ${GREEN}v$VERSION${NC}"
  [ -n "$NEXT_VERSION" ] && echo -e "  Patch:          ${CYAN}v$NEXT_VERSION${NC}"
  [ -n "$next_minor" ] && echo -e "  Minor:          ${CYAN}v$next_minor${NC}"
  [ -n "$next_major" ] && echo -e "  Major:          ${CYAN}v$next_major${NC}"

  local target="$VERSION"
  if [ "$AUTO_YES" -eq 1 ]; then
    target="$NEXT_VERSION"
  else
    echo ""
    echo "  Select bump:"
    echo "   1) patch"
    echo "   2) minor"
    echo "   3) major"
    echo "   4) custom"
    echo "   5) keep current"
    read -r -p "  Choose [1-5]: " choice
    case "${choice:-1}" in
    1) target="$NEXT_VERSION" ;;
    2) target="$next_minor" ;;
    3) target="$next_major" ;;
    4)
      read -r -p "  Enter version (x.y.z): " target
      ;;
    5) target="$VERSION" ;;
    *)
      print_error "Invalid choice"
      return 1
      ;;
    esac
  fi

  if [ "$target" = "$VERSION" ]; then
    print_info "Version unchanged (v$VERSION)"
    print_success "Version bump step complete"
    return 0
  fi

  run_cmd npm -C "$PROJECT_DIR" version "$target" --no-git-tag-version >/dev/null
  VERSION="$target"
  print_success "Version set to v$VERSION"
}

# ============================================================================
# BUILD FUNCTIONS
# ============================================================================

clean_builds() {
  print_substep "Cleaning build artifacts..."
  for d in "$PROJECT_DIR/out" "$PROJECT_DIR/dist"; do
    [ -e "$d" ] || continue
    run_cmd rm -rf "$d" 2>/dev/null || {
      print_warning "Permission denied on $d (root-owned files from Docker?). Retrying with sudo..."
      run_cmd sudo rm -rf "$d"
    }
  done
  run_cmd mkdir -p "$DIST_DIR/release"
  print_success "Clean complete"
}

build_app() {
  print_substep "Building Electron app..."
  run_with_spinner "Electron build" npm -C "$PROJECT_DIR" run build

  print_substep "Building web app..."
  run_with_spinner "Web build" npm -C "$PROJECT_DIR" run build:web

  print_success "All builds complete"
}

build_packages() {
  print_substep "Building release artifacts..."
  TAG="v$VERSION"
  local release_dir="$DIST_DIR/release"
  local bundle="$release_dir/${PROJECT_NAME}-${TAG}-bundle.tar.gz"
  local web_bundle="$release_dir/${PROJECT_NAME}-${TAG}-web.tar.gz"
  local source="$release_dir/${PROJECT_NAME}-${TAG}-source.tar.gz"
  local sums="$release_dir/SHA256SUMS-${TAG}.txt"

  run_cmd mkdir -p "$release_dir"

  # Full runtime bundle (Electron + web)
  run_cmd tar -czf "$bundle" -C "$PROJECT_DIR" \
    dist out package.json package-lock.json README.md LICENSE CHANGELOG.md

  # Web-only bundle (Docker / bare-metal web mode)
  run_cmd tar -czf "$web_bundle" -C "$PROJECT_DIR" \
    out/web dist/renderer package.json package-lock.json README.md LICENSE CHANGELOG.md

  # Source archive from current commit
  run_cmd git -C "$PROJECT_DIR" archive --format=tar.gz --prefix="${PROJECT_NAME}-${TAG}/" -o "$source" HEAD

  run_cmd bash -lc "cd '$release_dir' && sha256sum \
    '$(basename "$bundle")' \
    '$(basename "$web_bundle")' \
    '$(basename "$source")' \
    > '$(basename "$sums")'"

  RELEASE_ASSETS=("$bundle" "$web_bundle" "$source" "$sums")

  print_file_size "$bundle"
  print_file_size "$web_bundle"
  print_file_size "$source"
  print_file_size "$sums"
  print_success "Package build complete"
}

# ============================================================================
# GIT & RELEASE FUNCTIONS
# ============================================================================

check_large_files() {
  local limit_mb=50
  local limit_bytes=$((limit_mb * 1024 * 1024))
  local large_files
  large_files=$(git -C "$PROJECT_DIR" diff --cached --diff-filter=d --name-only -z |
    xargs -0 -I{} sh -c '
      f="'"$PROJECT_DIR"'/{}"; [ -f "$f" ] && size=$(wc -c < "$f") && [ "$size" -gt '"$limit_bytes"' ] && echo "  $(( size / 1024 / 1024 ))MB  {}"
    ' 2>/dev/null || true)
  if [ -n "$large_files" ]; then
    print_error "Staged files exceed ${limit_mb}MB limit:"
    echo "$large_files"
    print_info "Add these paths to .gitignore or unstage them before committing."
    run_cmd git -C "$PROJECT_DIR" reset HEAD -- .
    return 1
  fi
}

commit_changes() {
  if [ -z "$(git -C "$PROJECT_DIR" status --porcelain)" ]; then
    print_info "No changes to commit"
    return 0
  fi

  local default_msg="chore: release v$VERSION"
  local msg="$default_msg"
  if [ "$AUTO_YES" -eq 0 ]; then
    read -r -p "  Commit message [$default_msg]: " msg
    msg=${msg:-$default_msg}
  fi

  # Stage all changes (tracked, modified, and untracked)
  run_cmd git -C "$PROJECT_DIR" add -A

  # Abort if any staged file exceeds the size limit
  check_large_files || return 1

  run_cmd git -C "$PROJECT_DIR" commit -m "$msg"
  print_success "Changes committed"
}

push_changes() {
  print_substep "Pushing to $DEFAULT_BRANCH..."
  run_with_spinner "Pushing commits..." git -C "$PROJECT_DIR" push origin "$DEFAULT_BRANCH"
}

create_remote_release() {
  TAG="v$VERSION"
  local title="AnetI $TAG"

  print_substep "Creating/pushing tag $TAG..."
  if git -C "$PROJECT_DIR" rev-parse "$TAG" >/dev/null 2>&1; then
    print_warning "Local tag $TAG already exists"
  else
    run_cmd git -C "$PROJECT_DIR" tag -a "$TAG" -m "Release $TAG"
  fi

  run_with_spinner "Pushing tag..." git -C "$PROJECT_DIR" push origin "$TAG"

  print_substep "Creating GitHub release..."
  local notes_args=()
  if extract_release_notes "$VERSION"; then
    notes_args+=(--notes-file "$NOTES_FILE")
  else
    notes_args+=(--generate-notes)
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    print_info "[dry-run] gh release create '$TAG' --title '$title' --repo '$REMOTE_REPO' ..."
    print_success "Remote release step complete"
    return 0
  fi

  # If release exists, upload assets to existing release.
  if gh release view "$TAG" --repo "$REMOTE_REPO" >/dev/null 2>&1; then
    print_warning "Release $TAG already exists. Uploading assets with --clobber."
    gh release upload "$TAG" "${RELEASE_ASSETS[@]}" --clobber --repo "$REMOTE_REPO"
  else
    gh release create "$TAG" "${RELEASE_ASSETS[@]}" --title "$title" --repo "$REMOTE_REPO" "${notes_args[@]}"
  fi

  # Tag push triggers docker-publish.yml which builds versioned image tags
  print_info "Docker image build triggered (tag push -> ghcr.io)"
  print_info "Image tags: latest, $VERSION, ${VERSION%.*}, $(git -C "$PROJECT_DIR" rev-parse --short HEAD)"

  print_success "Remote release step complete"
}

publish_packages() {
  if [ "$GITHUB_ONLY" -eq 1 ]; then
    print_info "GitHub-only mode: skipping package publish"
    print_success "Package publish step complete"
    return 0
  fi

  TAG="${TAG:-v$VERSION}"
  if [ -z "$REMOTE_REPO" ]; then
    resolve_remote_repo || true
  fi

  if [ -n "$REMOTE_REPO" ]; then
    print_substep "Triggering installer workflow (deb) for $TAG..."
    if [ "$DRY_RUN" -eq 1 ]; then
      print_info "[dry-run] gh workflow run build-release-installers.yml --repo '$REMOTE_REPO' -f tag='$TAG' -f package_targets='deb'"
    else
      gh workflow run build-release-installers.yml \
        --repo "$REMOTE_REPO" \
        -f tag="$TAG" \
        -f package_targets="deb"

      local run_id
      run_id=$(gh run list \
        --repo "$REMOTE_REPO" \
        --workflow build-release-installers.yml \
        --limit 1 \
        --json databaseId \
        --jq '.[0].databaseId' 2>/dev/null || true)

      if [ -n "$run_id" ]; then
        print_info "Workflow run queued: $run_id"
        print_info "View run: https://github.com/$REMOTE_REPO/actions/runs/$run_id"
        if [ "$WAIT_INSTALLERS" -eq 1 ]; then
          print_substep "Waiting for installer workflow completion..."
          gh run watch "$run_id" --repo "$REMOTE_REPO"
        fi
      else
        print_warning "Workflow triggered, but run id could not be resolved immediately."
      fi
    fi
  else
    print_warning "REMOTE_REPO not resolved; skipping installer workflow trigger."
  fi

  if [ "$WITH_AUR" -eq 1 ]; then
    print_warning "AUR publish is a phase-2 hook and is not implemented yet."
    print_info "Planned target dir: $PACKAGE_REPO_DIR"
    print_info "Next: wire PKGBUILD/.SRCINFO generation and AUR git push."
  else
    print_info "No external package publish target selected."
  fi
  print_success "Package publish step complete"
}

# ============================================================================
# FULL RELEASE WORKFLOW
# ============================================================================

full_release() {
  TOTAL_START=$(date +%s)
  local total_steps=8

  print_step 1 $total_steps "Preflight checks"
  preflight_release

  print_step 2 $total_steps "Version bump"
  bump_version

  print_step 3 $total_steps "Clean old builds"
  clean_builds

  print_step 4 $total_steps "Build app"
  build_app

  print_step 5 $total_steps "Build packages"
  build_packages

  print_step 6 $total_steps "Commit and push"
  commit_changes
  push_changes

  print_step 7 $total_steps "Create remote release"
  create_remote_release

  print_step 8 $total_steps "Publish packages"
  publish_packages

  local total_time
  total_time=$(($(date +%s) - TOTAL_START))
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}${GREEN}  Release workflow complete${NC} ${DIM}($(format_time "$total_time"))${NC}"
  echo ""
  echo -e "  ${BOLD}Version:${NC}  ${CYAN}v$VERSION${NC}"
  echo -e "  ${BOLD}Release:${NC}  ${DIM}https://github.com/$REMOTE_REPO/releases/tag/$TAG${NC}"
  echo -e "  ${BOLD}Docker:${NC}   ${DIM}ghcr.io/${REMOTE_REPO,,}:$VERSION${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# ============================================================================
# MENU + ARGS
# ============================================================================

show_status() {
  read_version
  suggest_next_patch
  local branch
  local upstream
  local ahead_behind
  local changed_count
  local staged_count
  local unstaged_count
  local untracked_count
  local status_preview

  branch=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  upstream=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
  if [ -n "$upstream" ]; then
    ahead_behind=$(git -C "$PROJECT_DIR" rev-list --left-right --count "$upstream...HEAD" 2>/dev/null || echo "0 0")
  else
    ahead_behind="0 0"
  fi

  changed_count=$(git -C "$PROJECT_DIR" status --porcelain | wc -l | tr -d ' ')
  staged_count=$(git -C "$PROJECT_DIR" diff --cached --name-only | wc -l | tr -d ' ')
  unstaged_count=$(git -C "$PROJECT_DIR" diff --name-only | wc -l | tr -d ' ')
  untracked_count=$(git -C "$PROJECT_DIR" ls-files --others --exclude-standard | wc -l | tr -d ' ')
  status_preview=$(git -C "$PROJECT_DIR" status --short | sed -n '1,8p')

  echo -e "  ${BOLD}Version:${NC}  ${GREEN}v$VERSION${NC}"
  [ -n "$NEXT_VERSION" ] && echo -e "  ${BOLD}Next:${NC}     ${DIM}v$NEXT_VERSION${NC}"
  echo -e "  ${BOLD}Branch:${NC}   ${CYAN}${branch}${NC}"
  if [ -n "$upstream" ]; then
    local behind
    local ahead
    behind=$(echo "$ahead_behind" | awk '{print $1}')
    ahead=$(echo "$ahead_behind" | awk '{print $2}')
    echo -e "  ${BOLD}Sync:${NC}     ${DIM}${upstream}${NC} ${DIM}(ahead ${ahead}, behind ${behind})${NC}"
  else
    echo -e "  ${BOLD}Sync:${NC}     ${YELLOW}no upstream tracking branch${NC}"
  fi
  if [ "$changed_count" -eq 0 ]; then
    echo -e "  ${BOLD}Worktree:${NC} ${GREEN}clean${NC}"
  else
    echo -e "  ${BOLD}Worktree:${NC} ${YELLOW}${changed_count} changed${NC} ${DIM}(staged ${staged_count}, unstaged ${unstaged_count}, untracked ${untracked_count})${NC}"
    echo -e "  ${BOLD}Uncommitted:${NC}"
    echo "$status_preview" | sed 's/^/    /'
    if [ "$changed_count" -gt 8 ]; then
      echo -e "    ${DIM}... and $((changed_count - 8)) more${NC}"
    fi
  fi
  echo -e "  ${BOLD}Repo:${NC}     ${DIM}${REMOTE_REPO:-auto-detect}${NC}"
  [ "$DRY_RUN" -eq 1 ] && echo -e "  ${BOLD}Mode:${NC}     ${YELLOW}dry-run${NC}"
  echo ""
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --yes)
      AUTO_YES=1
      ;;
    --github-only)
      GITHUB_ONLY=1
      ;;
    --with-aur)
      WITH_AUR=1
      ;;
    --wait-installers)
      WAIT_INSTALLERS=1
      ;;
    --repo)
      shift
      REMOTE_REPO="${1:-}"
      ;;
    --help | -h)
      cat <<EOF
Usage: scripts/release.sh [options]

Options:
  --dry-run        Print commands without executing
  --yes            Non-interactive defaults where possible
  --repo OWNER/REPO
                   Override GitHub repo target
  --github-only    Skip external package publish phase
  --with-aur       Enable AUR publish hook (phase-2 placeholder)
  --wait-installers
                   Wait for installer workflow completion after triggering
  --help           Show this help
EOF
      exit 0
      ;;
    *)
      print_error "Unknown argument: $1"
      exit 1
      ;;
    esac
    shift
  done
}

main_menu() {
  while true; do
    print_header
    show_status
    echo -e "  ${BOLD}${CYAN}Actions${NC}"
    echo -e "  ${DIM}─────────────────────────────${NC}"
    echo -e "   ${GREEN}1)${NC} Commit changes"
    echo -e "   ${GREEN}2)${NC} Push changes"
    echo -e "   ${BLUE}3)${NC} Preflight checks"
    echo -e "   ${CYAN}4)${NC} Bump version"
    echo -e "   ${YELLOW}5)${NC} Clean builds"
    echo -e "   ${YELLOW}6)${NC} Build app"
    echo -e "   ${YELLOW}7)${NC} Build packages"
    echo -e "   ${MAGENTA}8)${NC} Create remote release"
    echo -e "   ${MAGENTA}9)${NC} Publish packages"
    echo -e "  ${BOLD}${CYAN}10)${NC} ${BOLD}Full release${NC}"
    echo -e "   ${DIM}0) Exit${NC}"
    echo ""

    read -r -p "  Choose [0-10]: " choice
    case $choice in
    1) commit_changes ;;
    2) push_changes ;;
    3) preflight_release ;;
    4) bump_version ;;
    5) clean_builds ;;
    6) build_app ;;
    7) build_packages ;;
    8) create_remote_release ;;
    9) publish_packages ;;
    10) full_release ;;
    0)
      echo ""
      exit 0
      ;;
    *) print_error "Invalid choice" ;;
    esac
    echo ""
    read -r -p "  Press Enter to continue..." _
  done
}

parse_args "$@"
main_menu
