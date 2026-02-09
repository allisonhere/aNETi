# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Port scanning: TCP connect scan on 20 common ports per device, runs as background enrichment
- Wake-on-LAN: send magic packets to wake devices from the UI or API
- Persistent anomaly state: anomaly flags survive restarts and scan cycles
- Live network pulse graph with avg latency line and toggle controls
- Activity feed showing real-time network events (joins, departures, port changes, anomalies)
- Docker image published to GHCR (`ghcr.io/allisonhere/aneti`)
- Docker Compose quick start with copy-pasteable config in README
- Proxmox update instructions in README
- `POST /api/device/wake` endpoint for Wake-on-LAN via API
- Local integration API for external app consumption (`GET /health`, `GET /stats`) with token auth
- Integration settings for API enable/disable, port, token reveal/copy/rotate
- Device detail panel improvements: inline copy actions and collapsible sightings history
- Accent preset support in Settings

### Changed

- Switched from better-sqlite3 to sql.js (SQLite via WebAssembly) for cross-platform compatibility
- Notification behavior during initial scan and multi-device discovery updates
- Improved discovery UX by streaming progressive scan results
- Trusted/muted state presentation made more consistent across UI
- Pulse graph uses timer-based sampling for smoother updates

### Fixed

- Docker image missing sql.js dependency
- Copy actions in device details
- Rename flow and related toast feedback
- Notification test wiring and toast reliability

## [0.1.0] - 2026-02-06

### Added

- Initial Electron + React + TypeScript application scaffold
- Core network scanner and device inventory persistence
