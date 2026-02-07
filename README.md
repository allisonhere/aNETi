# AnetI

AnetI is an Electron desktop app for realtime LAN discovery and device intelligence.

It continuously scans your local network, tracks device history, surfaces anomalies, and provides optional AI-generated summaries.

## Features

- Realtime network scanning with progressive discovery updates
- Device inventory with status, labels, vendor/hostname hints, and detail panels
- Device history from sightings (online/offline markers + timeline)
- Alert controls: startup warmup, global cooldown, per-device cooldown, per-device mute
- Security controls: trusted device marking and anomaly highlighting for untrusted discoveries
- AI brief panel with optional provider keys (OpenAI, Gemini, Claude)
- Local integration API for other apps (`/health`, `/stats`) protected by API token
- Theme accent presets in Settings

## Tech Stack

- Electron + electron-vite
- React + TypeScript
- better-sqlite3

## Project Structure

- `src/main` main process, scanner, DB, settings, AI client, IPC
- `src/preload` secure renderer bridge (`window.aneti`)
- `src/renderer/src` React UI and styles
- `docs` integration and development docs

## Getting Started

### Requirements

- Node.js 20+ recommended
- npm
- Linux/macOS/Windows network tools available to scanner (`ping`, ARP/neigh helpers where available)

### Install

```bash
npm install
```

### Run Dev

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Preview Build

```bash
npm run preview
```

## Settings Highlights

- Alert toggles and cooldown controls
- Device trust and mute actions
- AI provider key storage (local settings file)
- Integrations API controls: enable/disable, port setting, token copy/rotate

## Integration API

Base URL is local-only:

- `http://127.0.0.1:<port>`

Authentication:

- `Authorization: Bearer <token>`
- or `X-API-Token: <token>`

Endpoints:

- `GET /health`
- `GET /stats`

Full details: `docs/INTEGRATIONS_API.md`.

## Troubleshooting

For common issues (including `better-sqlite3` Node module version mismatch), see `docs/DEVELOPMENT.md`.

## Changelog

See `CHANGELOG.md`.

## License

MIT. See `LICENSE`.
