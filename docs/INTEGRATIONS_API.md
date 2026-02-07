# Integrations API

AnetI exposes a local read-only API so other apps can consume live network stats.

## Base URL

- `http://127.0.0.1:<apiPort>`

Default port is `8787`.

The server binds to localhost only.

Headless web mode (`npm run start:web`) exposes browser/API endpoints on:

- `http://<host>:<port>/app`
- `GET /api/health`
- `GET /api/stats`
- `GET /api/diagnostics`

## Authentication

Every request must include a valid API token.

Supported headers:

- `Authorization: Bearer <token>`
- `X-API-Token: <token>`

API token lifecycle:

- Token is generated automatically if missing
- Token can be copied or rotated from Settings

## Endpoints

### `GET /health`

Returns service health and scanner status.

Example response:

```json
{
  "ok": true,
  "generatedAt": 1738920000000,
  "scannerRunning": true,
  "deviceCount": 42
}
```

### `GET /stats`

Returns aggregated scanner/alert stats and a device list snapshot.

Example response shape:

```json
{
  "generatedAt": 1738920000000,
  "scanner": {
    "scanning": true,
    "totalDevices": 42,
    "onlineDevices": 39,
    "offlineDevices": 3,
    "trustedDevices": 18,
    "anomalyDevices": 2
  },
  "alerts": {
    "last24h": 10,
    "securityLast24h": 2,
    "aiSummaryLast24h": 5
  },
  "devices": [
    {
      "id": "192.168.1.10::aa:bb:cc:dd:ee:ff",
      "ip": "192.168.1.10",
      "hostname": "tv.lan",
      "vendor": "Samsung",
      "label": "Living Room TV",
      "status": "online",
      "firstSeen": 1738919000000,
      "lastSeen": 1738920000000,
      "trusted": true
    }
  ]
}
```

## Error Responses

- `401` invalid/missing token
- `404` endpoint not found
- `405` method not allowed
- `503` settings not ready

## cURL Examples

```bash
curl -s \
  -H "Authorization: Bearer <token>" \
  http://127.0.0.1:8787/health
```

```bash
curl -s \
  -H "Authorization: Bearer <token>" \
  http://127.0.0.1:8787/stats
```
