// ---------------------------------------------------------------------------
// CineFlix OTT — Cloudflare Worker (Production High-Resilience Edition)
//
// Key Capabilities:
//   1. 40+ Cloudflare Worker Equal Load-Balancing Pool for High-Speed Streaming
//   2. Disguised .woff / .woff2 Video Segment Decoding (forced video/mp4 MIME)
//   3. Full Auto-ClearKey DRM Detection for Live Cricket Channels (DASH CENC)
//   4. MovieBox Deprecation Guard + Transparent VPS MultiProvider Failover
//   5. Authenticated Cricket Live Scorecard Relay
//   6. Cross-Origin Resource Sharing (CORS) & Mixed Content Safe
// ---------------------------------------------------------------------------

import {
  proxyMedia,
  rewriteM3u8,
  corsHeaders,
  buildVirtualByteRangeHls,
  unwrapNestedProxyUrl,
  getProviderHeaders,
} from './playlist.js';
import { resolveStream } from './moviebox.js';
import { INDEX_HTML } from './ui/html.js';
import { STYLES_CSS } from './ui/css.js';
import { PLAYER_JS } from './ui/player.js';

const SELF_MIRRORS = [
"https://stream.nexplay01.workers.dev",
"https://stream.nexplay02.workers.dev",
"https://stream.nexplay03.workers.dev",
"https://stream.nexplay04.workers.dev",
"https://stream.nexplay05.workers.dev,
"https://stream.nexplay06.workers.dev",
"https://stream.nexplay07.workers.dev",
"https://stream.nexplay08.workers.dev",
"https://stream.nexplay09.workers.dev",
"https://stream.nexplay10.workers.dev",
"https://stream.nexplay11.workers.dev",
"https://stream.nexplay12.workers.dev",
"https://stream.nexplay13.workers.dev",
"https://stream.nexplay14.workers.dev",
"https://stream.nexplay15.workers.dev"
];

// ---------------------------------------------------------------------------
// 🏏 MHDTV / Touchcric / FreeCDN Auto-Resolver (Zero Manual URLs)
// ---------------------------------------------------------------------------
const MHDTV_CHANNELS = {
  fancode: { id: '343', name: 'FanCode HD Live' },
  sonyliv_hi: { id: '348', name: 'SonyLiv Hindi HD' },
  sonyliv_hindi: { id: '348', name: 'SonyLiv Hindi HD' },
  sonyliv_en: { id: '347', name: 'SonyLiv English HD' },
  sonyliv_eng: { id: '347', name: 'SonyLiv English HD' },
  sonyliv: { id: '348', name: 'SonyLiv Hindi HD' },
  astro2v: { id: '540', name: 'CricBuzz HD', streamName: 'csstream6' },
  cricbuzz: { id: '540', name: 'CricBuzz HD', streamName: 'csstream6' },
  willow: { id: '263', name: 'Willow Sport' },
};

const mhdtvCache = new Map();

async function resolveFreeCdnChannel(streamName, embedId = '1006') {
  const embedUrl = `https://freecdn.st/hembedplayer/${streamName}/1/960/540`;
  const res = await fetch(embedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: 'https://webcric.is/',
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const text = await res.text();
  const eaMatch = text.match(/ea\s*=\s*["']([^"']+)["']/i);
  const pkMatch = text.match(/var\s+pk\s*=\s*["']([^"']+)["']/i);
  const idMatch = text.match(/\?id=([0-9]+)/i);

  if (eaMatch && pkMatch) {
    const ea = eaMatch[1].trim();
    const pk = pkMatch[1].trim();
    const cleanPk = pk.length > 54 ? pk.substring(0, 54) + pk.substring(55) : pk;
    const cid = idMatch ? idMatch[1] : embedId;
    return {
      manifestUrl: `http://${ea}:8088/live/${streamName}/playlist.m3u8?id=${cid}&pk=${cleanPk}`,
      referer: 'https://webcric.is/',
      format: 'HLS',
      clearkey: '',
      kid: '',
      key: '',
    };
  }
  return null;
}

async function resolveMhdtvChannel(channelKey) {
  if (!channelKey) return null;
  const normKey = channelKey.toLowerCase().replace(/\.(mpd|m3u8)$/i, '').trim();
  const conf = MHDTV_CHANNELS[normKey];
  if (!conf) return null;

  const now = Date.now();
  const cached = mhdtvCache.get(normKey);
  if (cached && now < cached.expiresAt) {
    return cached;
  }

  // 1. If channel has streamName on FreeCDN (like csstream6 for astro2v)
  if (conf.streamName) {
    try {
      const freeCdn = await resolveFreeCdnChannel(conf.streamName);
      if (freeCdn && freeCdn.manifestUrl) {
        const result = {
          channelId: normKey,
          name: conf.name,
          manifestUrl: freeCdn.manifestUrl,
          kid: '',
          key: '',
          clearkey: '',
          referer: freeCdn.referer || 'https://webcric.is/',
          format: 'HLS',
          expiresAt: now + 5 * 60 * 1000,
        };
        mhdtvCache.set(normKey, result);
        return result;
      }
    } catch (_) {}
  }

  // 2. Touchcric Player Resolution (FanCode, SonyLiv, Willow, etc.)
  const url = `https://api.touchcric.vip/drm/player.php?id=${conf.id}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Referer: 'https://live.mhdtv.online/',
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`MHDTV returned HTTP ${res.status}`);
  }

  const html = await res.text();
  const manifestMatch = html.match(/const MANIFEST_URL\s*=\s*"([^"]+)"/i);
  const kidMatch = html.match(/const DRM_KID\s*=\s*"([^"]+)"/i);
  const keyMatch = html.match(/const DRM_KEY\s*=\s*"([^"]+)"/i);

  if (!manifestMatch) {
    throw new Error(`Failed to extract manifest for ${conf.name}`);
  }

  const manifest = manifestMatch[1].trim();
  const kid = kidMatch ? kidMatch[1].trim() : '';
  const keyVal = keyMatch ? keyMatch[1].trim() : '';
  const isHls = /\.m3u8(\?|$)/i.test(manifest);

  const result = {
    channelId: normKey,
    name: conf.name,
    manifestUrl: manifest,
    kid,
    key: keyVal,
    clearkey: kid && keyVal ? `${kid}:${keyVal}` : '',
    referer: 'https://live.mhdtv.online/',
    format: isHls ? 'HLS' : 'DASH',
    expiresAt: now + 5 * 60 * 1000, // 5 min cache
  };

  mhdtvCache.set(normKey, result);
  return result;
}

function selfBase(request) {
  return new URL(request.url).origin;
}

/**
 * Builds the comprehensive 40+ worker CDN load-balancing pool.
 */
function getWorkerPool(request, env) {
  const self = selfBase(request);
  const envWorkers = (env?.CLOUDFLARE_WORKERS || '')
    .split(',')
    .map((w) => w.trim().replace(/\/+$/, ''))
    .filter((w) => w.startsWith('http'));

  const pool = Array.from(new Set([self, ...envWorkers, ...SELF_MIRRORS])).filter(Boolean);
  return pool;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    }),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const workerPool = getWorkerPool(request, env);
    const vpsHost = (env?.VPS_HOST_URL || 'https://cineflix-cdn.duckdns.org').replace(/\/+$/, '');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      // ---- health ----------------------------------------------------------
      if (path === '/' || path === '/health') {
        return json({
          ok: true,
          service: 'cineflix-live-worker',
          workersInPool: workerPool.length,
          time: new Date().toISOString(),
        });
      }

      // ---- CineFlix OTT Full UI Web Player & Assets -----------------------
      if (
        path === '/player.js' ||
        path === '/player/player.js' ||
        path === '/play/player.js'
      ) {
        return new Response(PLAYER_JS, {
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
            ...corsHeaders(),
          },
        });
      }

      if (
        path === '/styles.css' ||
        path === '/player/styles.css' ||
        path === '/play/styles.css'
      ) {
        return new Response(STYLES_CSS, {
          headers: {
            'Content-Type': 'text/css; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
            ...corsHeaders(),
          },
        });
      }

      // Web Player Landing Pages (/player, /play, /play/:id)
      if (
        path === '/player' ||
        path === '/player/' ||
        (path.startsWith('/player/') && !path.includes('.')) ||
        path === '/play' ||
        path === '/play/' ||
        (path.startsWith('/play/') && !path.includes('.') && path !== '/play/hub')
      ) {
        return new Response(INDEX_HTML, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
            ...corsHeaders(),
          },
        });
      }

      // Forward legacy player hub or exoplayer to VPS
      if (path === '/play/hub' || path.startsWith('/exoplayer')) {
        const targetUrl = `${vpsHost}${path}${url.search}`;
        return await fetch(targetUrl, {
          method: request.method,
          headers: request.headers,
        });
      }

      // ---- Pre-roll Ad Configuration API (/api/preroll) ---------------------
      if (path === '/api/preroll' || path === '/api/ads') {
        try {
          const vpsRes = await fetch(`${vpsHost}/api/preroll${url.search}`, {
            headers: {
              'User-Agent': 'okhttp/4.12.0',
              'ngrok-skip-browser-warning': 'true',
              'x-app-key': env?.APP_SECRET_KEY || 'shrq6396827211&&shrq9808335538',
            },
          });
          if (vpsRes.ok) {
            const data = await vpsRes.json();
            return json(data);
          }
        } catch (_) {}
        return json({ enabled: false, title: '', videoUrl: '', skipAfterSec: 5 });
      }

      // ---- Cricket Scorecard API (/api/cricket/*) ---------------------------
      // ⚡ Authenticated Relay to VPS with correct bypass headers
      if (path.startsWith('/api/cricket/')) {
        const targetUrl = `${vpsHost}${path}${url.search}`;
        try {
          const vpsRes = await fetch(targetUrl, {
            headers: {
              'User-Agent': 'okhttp/4.12.0',
              'ngrok-skip-browser-warning': 'true',
              'x-app-key': env?.APP_SECRET_KEY || 'shrq6396827211&&shrq9808335538',
              'x-admin-token': env?.ADMIN_PIN || 'cineflix2026',
            },
          });
          if (vpsRes.ok) {
            const data = await vpsRes.json();
            return json(data);
          }
        } catch (_) {}
        // Clean 200 OK fallback so Network tab doesn't show 404
        return json({ success: true, live: false, matches: [], match: null });
      }

      // ---- 40+ Worker Pool Mirror Registry (/api/workers) -------------------
      if (path === '/api/workers') {
        return json({ success: true, workers: workerPool, count: workerPool.length });
      }

      // ---- MHDTV Live Channels List ----------------------------------------
      if (path === '/api/live/channels') {
        const primary = ['fancode', 'sonyliv_hi', 'sonyliv_en'];
        const list = primary.map((k) => {
          const c = MHDTV_CHANNELS[k];
          return {
            id: k,
            name: c.name,
            streamUrl: `${selfBase(request)}/api/live/${k}`,
            infoUrl: `${selfBase(request)}/api/live/${k}/info`,
          };
        });
        return json({ success: true, channels: list });
      }

      // ---- MHDTV Channel Info & ClearKey JSON (/api/live/:id/info) ----------
      const infoMatch = /^\/api\/live\/([^/]+)\/info$/.exec(path);
      if (infoMatch) {
        const chanKey = infoMatch[1];
        const mhdtv = await resolveMhdtvChannel(chanKey);
        if (mhdtv) {
          return json({
            success: true,
            id: mhdtv.channelId,
            name: mhdtv.name,
            streamUrl: `${selfBase(request)}/api/live/${mhdtv.channelId}`,
            manifestUrl: mhdtv.manifestUrl,
            clearkey: mhdtv.clearkey,
            kid: mhdtv.kid,
            key: mhdtv.key,
            referer: mhdtv.referer,
          });
        }
        return json({ success: false, error: 'channel not found' }, 404);
      }

      // ---- MHDTV Live Stream Auto-Route (/api/live/:channel) ----------------
      const liveChanMatch = /^\/api\/live\/([^/]+)$/.exec(path);
      if (liveChanMatch) {
        const chanKey = liveChanMatch[1];
        if (chanKey !== 'proxy.m3u8' && chanKey !== 'chunk' && chanKey !== 'channels') {
          const mhdtv = await resolveMhdtvChannel(chanKey);
          if (mhdtv) {
            const resp = await proxyMedia(
              mhdtv.manifestUrl,
              request,
              selfBase(request),
              false,
              mhdtv.referer,
              workerPool
            );
            const headers = new Headers(resp.headers);
            headers.set('X-DRM-ClearKey', mhdtv.clearkey);
            headers.set('X-DRM-KID', mhdtv.kid);
            headers.set('X-DRM-KEY', mhdtv.key);
            headers.set('Access-Control-Expose-Headers', '*');
            return new Response(resp.body, { status: resp.status, headers });
          }
        }
      }

      // ---- Live HLS Proxy with 40+ Worker Equal Load Balancing --------------
      if (path === '/api/live/proxy.m3u8') {
        const target = url.searchParams.get('url') || url.searchParams.get('u');
        if (!target) return json({ success: false, error: 'missing url parameter' }, 400);
        // Pass the ref parameter as defaultReferer so getProviderHeaders can use it
        const refParam = url.searchParams.get('ref') || url.searchParams.get('referer') || '';
        return proxyMedia(target, request, selfBase(request), true, refParam, workerPool);
      }

      // ---- Generic Media / Chunk Proxy (DASH, MPD, fMP4 .woff/.woff2) -------
      if (path === '/api/proxy' || path === '/api/mb') {
        const target = url.searchParams.get('url') || url.searchParams.get('u');
        if (!target) return json({ success: false, error: 'missing url parameter' }, 400);

        // Auto-extract if a channel key was passed in ?url=
        if (MHDTV_CHANNELS[target.toLowerCase()]) {
          const mhdtv = await resolveMhdtvChannel(target);
          if (mhdtv) {
            return proxyMedia(
              mhdtv.manifestUrl,
              request,
              selfBase(request),
              false,
              mhdtv.referer,
              workerPool
            );
          }
        }

        return proxyMedia(target, request, selfBase(request), false, '', workerPool);
      }

      // ---- MovieBox Pipeline: /id/{id}/movie/index.m3u8 --------------------
      //     MovieBox Pipeline: /id/{id}/{season}/{episode}/index.m3u8 ---------
      // ⚡ With Transparent MultiProvider VPS Failover
      const idMatch = /^\/id\/([^/]+)(?:\/(\d+)\/(\d+))?\/(?:movie\/)?index\.m3u8$/.exec(path);
      if (idMatch) {
        const [, id, seasonStr, episodeStr] = idMatch;
        const isSeries = Boolean(seasonStr && episodeStr);
        const season = isSeries ? parseInt(seasonStr, 10) : 0;
        const episode = isSeries ? parseInt(episodeStr, 10) : 0;

        let resolved = null;
        try {
          resolved = await resolveStream({
            id: decodeURIComponent(id),
            title: decodeURIComponent(id),
            isSeries,
            season,
            episode,
            tmdbKey: env?.TMDB_API_KEY,
          });
        } catch (_) {}

        let directMp4Url = null;
        let directMp4Ref = '';
        const movieTitle = decodeURIComponent(id);

        if (resolved && resolved.streamUrl) {
          const isHls = resolved.format === 'HLS' || /\.m3u8$/i.test(resolved.streamUrl);
          if (isHls) {
            const enc = encodeURIComponent(resolved.streamUrl);
            const base = selfBase(request);
            const refParam = resolved.referer ? `&ref=${encodeURIComponent(resolved.referer)}` : '';
            const cookieParam = resolved.signCookie ? `&cookie=${encodeURIComponent(resolved.signCookie)}` : '';
            return Response.redirect(`${base}/api/live/proxy.m3u8?url=${enc}${cookieParam}${refParam}`, 302);
          } else {
            directMp4Url = resolved.streamUrl;
            directMp4Ref = resolved.referer || '';
          }
        }

        // If local MovieBox resolution failed or gave deprecation notice, transparently fallback to VPS MultiProvider!
        if (!directMp4Url && (!resolved || !resolved.streamUrl)) {
          const vpsCandidates = Array.from(new Set([vpsHost, 'https://cineflix-cdn.duckdns.org', 'https://shariqbabu-cineflix-ott.hf.space'])).filter(Boolean);
          for (const host of vpsCandidates) {
            try {
              const vpsTarget = `${host}${path}${url.search}`;
              const vpsRes = await fetch(vpsTarget, {
                headers: {
                  'User-Agent': 'okhttp/4.12.0',
                  'x-app-key': env?.APP_SECRET_KEY || 'shrq6396827211&&shrq9808335538',
                  'ngrok-skip-browser-warning': 'true',
                },
                redirect: 'follow',
              });

              if (vpsRes.ok) {
                const manifestText = await vpsRes.text();
                if (manifestText.includes('#EXTM3U')) {
                  // Check if VPS returned a direct MP4/MKV video link inside the M3U8
                  const mLines = manifestText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                  const mp4Line = mLines.find((l) => (l.includes('.mp4') || l.includes('.mkv') || l.includes('.webm')) && l.startsWith('http'));
                  if (mp4Line) {
                    directMp4Url = unwrapNestedProxyUrl(mp4Line);
                    break;
                  }

                  const rewritten = rewriteM3u8(manifestText, vpsTarget, workerPool, selfBase(request));
                  return new Response(rewritten, {
                    status: 200,
                    headers: corsHeaders({
                      'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
                      'Cache-Control': 'no-cache, no-store, must-revalidate',
                    }),
                  });
                }
              }
            } catch (_) {}
          }
        }

        // ⚡ Virtual Byte-Range Multi-Worker Chunking for Direct MP4s (like Awarapan)
        // Splits 1 large MP4 file into 3MB virtual chunks load-balanced across 40+ workers!
        if (directMp4Url) {
          const cleanMp4 = unwrapNestedProxyUrl(directMp4Url);
          const pHeaders = getProviderHeaders(cleanMp4, directMp4Ref);
          let totalBytes = 0;
          try {
            const headRes = await fetch(cleanMp4, {
              method: 'HEAD',
              headers: pHeaders,
              signal: AbortSignal.timeout(4500),
            });
            if (headRes.ok) {
              totalBytes = parseInt(headRes.headers.get('content-length') || '0', 10);
            }
          } catch (_) {}

          // Fallback to estimated size (850MB) if HEAD times out so multi-chunking always activates!
          if (!totalBytes || totalBytes <= 0) {
            totalBytes = 850 * 1024 * 1024;
          }

          const byteRangeM3u8 = buildVirtualByteRangeHls({
            directVideoUrl: cleanMp4,
            totalBytes,
            totalDurationSec: 7200,
            workerPool,
            selfBase: selfBase(request),
            title: movieTitle,
            referer: directMp4Ref,
          });

          return new Response(byteRangeM3u8, {
            status: 200,
            headers: corsHeaders({
              'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
              'Cache-Control': 'no-cache, no-store, must-revalidate',
            }),
          });
        }

        return json({ success: false, error: 'no stream found for id ' + id }, 404);
      }

      // ---- Bhalocast / Playsza Live HLS (/hls/:id/playlist.m3u8, /hls/:id) ---
      const hlsPlMatch = /^\/hls\/([^/]+)(?:\/(?:playlist(?:\.m3u8)?|index\.m3u8))?$/.exec(path);
      if (hlsPlMatch && !path.endsWith('/resource')) {
        const rawChan = hlsPlMatch[1].replace(/\.m3u8$/i, '');
        const upstreamSources = [
          `https://live.betadda.workers.dev/hls/${rawChan}/playlist.m3u8`,
          `https://live.clineflix-e0d.workers.dev/hls/${rawChan}/playlist.m3u8`,
          `https://live-cdn.clineflix-73f.workers.dev/hls/${rawChan}/playlist.m3u8`,
          `https://cineflix-cdn.duckdns.org/hls/${rawChan}/playlist.m3u8`,
          `${vpsHost}/hls/${rawChan}/playlist.m3u8`,
        ];

        for (const upUrl of upstreamSources) {
          try {
            const upRes = await fetch(upUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Referer: 'https://playsza.st/',
              },
              signal: AbortSignal.timeout(4500),
            });
            if (upRes.ok) {
              const body = await upRes.text();
              if (body.includes('#EXTM3U')) {
                let segIdx = 0;
                const rewritten = body
                  .split('\n')
                  .map((line) => {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('http')) {
                      const balanced = workerPool[segIdx++ % workerPool.length] || selfBase(request);
                      try {
                        const u = new URL(trimmed);
                        const targetChunk = u.searchParams.get('url') || trimmed;
                        const ref = u.searchParams.get('ref') || 'https://playsza.st/';
                        return `${balanced}/hls/${rawChan}/resource?url=${encodeURIComponent(targetChunk)}&ref=${encodeURIComponent(ref)}`;
                      } catch (_) {
                        return trimmed;
                      }
                    }
                    return line;
                  })
                  .join('\n');

                return new Response(rewritten, {
                  status: 200,
                  headers: corsHeaders({
                    'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                  }),
                });
              }
            }
          } catch (_) {}
        }
        return json({ success: false, error: 'Channel ' + rawChan + ' unavailable' }, 404);
      }

      // ---- Bhalocast / Playsza Chunk Resource Relay (/hls/:id/resource) -----
      if (path.includes('/hls/') && path.endsWith('/resource')) {
        const target = url.searchParams.get('url') || url.searchParams.get('u');
        if (!target) return json({ success: false, error: 'missing url parameter' }, 400);
        const ref = url.searchParams.get('ref') || url.searchParams.get('referer') || 'https://playsza.st/';
        return proxyMedia(target, request, selfBase(request), false, ref, workerPool);
      }

      // ---- Primary Resolver API: /api/resolve/{titleOrId}[?s=&e=] -----------
      // ⚡ With Transparent MultiProvider VPS Failover
      const resolveMatch = /^\/api\/resolve\/(.+)$/.exec(path);
      if (resolveMatch) {
        const title = decodeURIComponent(resolveMatch[1]);
        const season = parseInt(url.searchParams.get('s') || '0', 10);
        const episode = parseInt(url.searchParams.get('e') || '0', 10);
        const isSeries = season > 0 || episode > 0;

        let resolved = null;
        try {
          resolved = await resolveStream({
            id: title,
            title,
            isSeries,
            season: isSeries ? season || 1 : 0,
            episode: isSeries ? episode || 1 : 0,
            tmdbKey: env?.TMDB_API_KEY,
          });
        } catch (_) {}

        // Fallback to VPS MultiProvider if MovieBox API returns deprecation or empty
        if (!resolved || !resolved.streamUrl) {
          const vpsCandidates = Array.from(new Set([vpsHost, 'https://cineflix-cdn.duckdns.org', 'https://cineflix-ott.duckdns.org'])).filter(Boolean);
          for (const host of vpsCandidates) {
            try {
              const vpsUrl = `${host}/api/resolve/${encodeURIComponent(title)}${url.search}`;
              const vpsRes = await fetch(vpsUrl, {
                headers: {
                  'User-Agent': 'okhttp/4.12.0',
                  'x-app-key': env?.APP_SECRET_KEY || 'shrq6396827211&&shrq9808335538',
                  'ngrok-skip-browser-warning': 'true',
                },
              });
              if (vpsRes.ok) {
                const vpsData = await vpsRes.json();
                if (vpsData && vpsData.success && vpsData.streamUrl) {
                  let finalRaw = vpsData.rawStreamUrl || vpsData.streamUrl;
                  if (finalRaw.includes('url=')) {
                    try {
                      const u = new URL(finalRaw);
                      finalRaw = u.searchParams.get('url') || finalRaw;
                    } catch (_) {}
                  }
                  const isHls = vpsData.format === 'HLS' || /\.m3u8(\?|$)/i.test(finalRaw);
                  const enc = encodeURIComponent(finalRaw);
                  const base = selfBase(request);
                  const refParam = vpsData.referer ? `&ref=${encodeURIComponent(vpsData.referer)}` : '';
                  const proxiedStream = isHls
                    ? `${base}/api/live/proxy.m3u8?url=${enc}${refParam}`
                    : `${base}/api/proxy?url=${enc}${refParam}`;

                  return json(
                    {
                      success: true,
                      provider: vpsData.provider || 'vps-multiprovider',
                      streamUrl: proxiedStream,
                      proxyUrl: proxiedStream,
                      rawStreamUrl: finalRaw,
                      referer: vpsData.referer || '',
                      userAgent: vpsData.headers?.['User-Agent'] || 'okhttp/4.12.0',
                      format: isHls ? 'HLS' : (vpsData.format || 'MP4'),
                    },
                    200,
                    { 'Cache-Control': 'public, max-age=180' }
                  );
                }
              }
            } catch (_) {}
          }
          return json({ success: false, error: 'not resolved' }, 404);
        }

        const enc = encodeURIComponent(resolved.streamUrl);
        const cookieQs = resolved.signCookie ? `&cookie=${encodeURIComponent(resolved.signCookie)}` : '';
        const refererQs = resolved.referer ? `&ref=${encodeURIComponent(resolved.referer)}` : '';
        const base = selfBase(request);
        return json(
          {
            success: true,
            provider: 'moviebox',
            streamUrl: `${base}/api/proxy?url=${enc}${cookieQs}${refererQs}`,
            proxyUrl: `${base}/api/proxy?url=${enc}${cookieQs}${refererQs}`,
            rawStreamUrl: resolved.streamUrl,
            signCookie: resolved.signCookie || '',
            referer: resolved.referer || '',
            userAgent: resolved.userAgent || '',
            format: resolved.format || 'DASH',
          },
          200,
          { 'Cache-Control': 'public, max-age=120' }
        );
      }

      // ---- VPS / Worker Secure Chunk Relay (range-preserving) ---------------
      if (path === '/api/live/chunk') {
        const target = url.searchParams.get('url') || url.searchParams.get('u');
        if (!target) return json({ success: false, error: 'missing url parameter' }, 400);
        return proxyMedia(target, request, selfBase(request), false, '', workerPool);
      }

      return json({ success: false, error: 'unknown route: ' + path }, 404);
    } catch (e) {
      return json({ success: false, error: e.message || 'worker error' }, 500);
    }
  },
};
