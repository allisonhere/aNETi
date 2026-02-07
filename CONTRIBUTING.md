# Contributing

## Workflow

1. Create a branch from `main`.
2. Implement focused changes.
3. Run build before opening a PR.
4. Update docs/changelog when behavior changes.

## Minimum Quality Bar

- Keep changes scoped and reviewable
- Preserve existing UI patterns unless intentionally changing them
- Avoid introducing breaking IPC/API changes without documentation

## Local Checks

```bash
npm run build
```

## Pull Request Checklist

- [ ] Build passes locally
- [ ] User-visible behavior validated
- [ ] `CHANGELOG.md` updated (if applicable)
- [ ] Relevant docs updated
