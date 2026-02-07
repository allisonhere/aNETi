# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Local integration API for external app consumption (`GET /health`, `GET /stats`) with token auth
- Integration settings for API enable/disable, port, token reveal/copy/rotate
- Device detail panel improvements: inline copy actions and collapsible sightings history
- Realtime pulse UI at top of dashboard: network pulse ribbon, anomaly sparkline, series toggles
- Accent preset support in Settings

### Changed

- Notification behavior during initial scan and multi-device discovery updates
- Improved discovery UX by streaming progressive scan results
- Trusted/muted state presentation made more consistent across UI

### Fixed

- Copy actions in device details
- Rename flow and related toast feedback
- Notification test wiring and toast reliability

## [0.1.0] - 2026-02-06

### Added

- Initial Electron + React + TypeScript application scaffold
- Core network scanner and device inventory persistence
