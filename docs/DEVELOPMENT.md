# Development Notes

## Local Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Common Issues

### `better-sqlite3` NODE_MODULE_VERSION mismatch

Symptom example:

- module compiled for one Node/Electron ABI but current runtime expects another

Fix:

```bash
npm rebuild better-sqlite3
```

If needed, reinstall:

```bash
rm -rf node_modules package-lock.json
npm install
npm rebuild better-sqlite3
```

### Dev terminal feels "stuck" after `npm run dev`

`npm run dev` runs Electron/Vite in a long-lived foreground process.

Use one of these:

- open a second terminal tab for normal shell commands
- stop dev server with `Ctrl+C`
- run from a terminal multiplexer pane/session

### No desktop notifications

Check:

- OS notifications permission for Electron app/session
- Settings > Alert Settings > Enable OS notifications
- Use `Test notification` in Settings

### No devices discovered

Check:

- machine has active IPv4 interface/subnet
- scanner diagnostics card in app
- local network tooling availability (`ping`, ARP/neigh helpers)
- host firewall/network isolation settings

## Docs Index

- `README.md` project overview and quick start
- `CHANGELOG.md` release history
- `docs/INTEGRATIONS_API.md` local stats API contract
