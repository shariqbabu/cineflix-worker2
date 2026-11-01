# CineFlix Live Worker (Cloudflare)

Self-contained Cloudflare Worker that powers CineFlix OTT streaming:

| Route | Purpose |
|---|---|
| `GET /health` | Liveness probe |
| `GET /api/workers` | Mirror registry consumed by the app (`PlayerViewModel.fetchDynamicWorkersAsync`) |
| `GET /api/live/proxy.m3u8?url=…` | **Live channel HLS proxy** — rewrites every segment/variant URI so blocked origins (e.g. raw `http://51.x.x.x` IPTV boxes) play on Android |
| `GET /api/proxy?url=…` | Generic media proxy (segments, MP4, DASH manifests) |
| `GET /id/{id}/movie/index.m3u8` | **MovieBox movie resolver** — searches MovieBox/OneRoom, extracts the signed manifest and streams it through this worker |
| `GET /id/{id}/{season}/{episode}/index.m3u8` | MovieBox series/episode resolver |
| `GET /api/resolve/{title}` | Legacy HighXHD-style JSON resolver |

Everything is CORS-open and streams through the worker, so the Android app never
needs CloudFront cookies or origin referers.

## Deploy (2 commands)

```bash
cd worker
npx wrangler deploy
```

Wrangler will print your URL, e.g. `https://cineflix-live.<account>.workers.dev`.

> First time: `npx wrangler login` (browser) or set `CLOUDFLARE_API_TOKEN`.

## Point the app at your worker

1. `local.properties` (or GitHub Actions secrets):
   ```properties
   MOVIEBOX_API_URL=https://cineflix-live.<account>.workers.dev
   ```
2. Optional extra mirrors — add them to `SELF_MIRRORS` in `src/index.js`
   (returned by `/api/workers`) and to `STATIC_MIRRORS` in
   `app/src/main/java/com/cineflix/ott/data/player/StreamResolver.kt`.

The app automatically probes **every** mirror and plays the first one that
responds with a playable manifest — movies and live channels keep working even
when one worker is down.

## Local development

```bash
cd worker
npx wrangler dev   # http://127.0.0.1:8787
curl "http://127.0.0.1:8787/api/live/proxy.m3u8?url=https%3A%2F%2Fexample.com%2Flive.m3u8"
```

## Notes

- `src/crypto.js` is a faithful port of the app's `MovieBoxCrypto.kt`
  (HMAC-MD5 request signing + CloudFront policy decoding).
- `src/moviebox.js` ports `MovieBoxClient.kt` (visitor login, search,
  play-info, manifest extraction).
- Keep the app and worker in the same repo revision — route shapes must match
  `StreamResolver.kt`.
