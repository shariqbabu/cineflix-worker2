// ---------------------------------------------------------------------------
// CineFlix OTT — High-Performance Playlist & Media Proxy Engine
// Features:
//  1. Equal Load-Balancing across 40+ Cloudflare Worker CDN Pool
//  2. Disguised .woff / .woff2 Video Segment Decoding (forced video/mp4 MIME)
//  3. Smart Provider Rules (NxSha/Nitro, MovieBox okhttp, Live Sports, MHDTV)
//  4. HLS (.m3u8) & MPEG-DASH (.mpd) Manifest Rewriting with Token Preservation
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-DRM-ClearKey, X-DRM-KID, X-DRM-KEY',
};

export function corsHeaders(extra = {}) {
  return { ...CORS_HEADERS, ...extra };
}

function absUrl(base, relative) {
  try {
    return new URL(relative, base).toString();
  } catch (_) {
    return relative;
  }
}

/**
 * Unwraps nested proxy URLs (e.g. VPS /api/live/chunk?url=...) so workers connect
 * DIRECTLY to the origin CDN, reducing VPS bandwidth and load to 0%.
 */
export function unwrapNestedProxyUrl(uri) {
  if (!uri || typeof uri !== 'string') return uri;
  try {
    if (uri.includes('/api/live/chunk?url=') || uri.includes('/api/proxy?url=') || uri.includes('chunk?url=')) {
      const u = new URL(uri);
      const inner = u.searchParams.get('url');
      if (inner && inner.startsWith('http')) {
        return unwrapNestedProxyUrl(inner);
      }
    }
  } catch (_) {}
  return uri;
}

/**
 * Returns the best worker origin from the pool in a round-robin / distributed fashion.
 * @param {string[]} workerPool list of worker origins
 * @param {string} fallbackOrigin self origin
 * @param {number} index chunk index
 */
export function getBalancedWorker(workerPool, fallbackOrigin, index = 0) {
  if (Array.isArray(workerPool) && workerPool.length > 0) {
    const valid = workerPool.filter((w) => typeof w === 'string' && w.startsWith('http'));
    if (valid.length > 0) {
      const idx = Math.abs(index) % valid.length;
      return valid[idx].replace(/\/+$/, '');
    }
  }
  return (fallbackOrigin || '').replace(/\/+$/, '');
}

/**
 * Builds a multi-worker Byte-Range HLS playlist for direct MP4/MKV video files.
 * Splits a single large MP4 file into 3MB virtual chunks load-balanced across 40+ workers.
 */
export function buildVirtualByteRangeHls({
  directVideoUrl,
  totalBytes,
  totalDurationSec = 7200,
  workerPool = [],
  selfBase = '',
  title = 'Movie Stream',
  referer = '',
}) {
  const pool = Array.isArray(workerPool) && workerPool.length > 0 ? workerPool : [selfBase];
  const cleanUrl = unwrapNestedProxyUrl(directVideoUrl);
  const refParam = referer ? `&ref=${encodeURIComponent(referer)}` : '';

  const CHUNK_SIZE = 3 * 1024 * 1024; // 3 MB virtual chunks
  const fileSize = Number(totalBytes) || 0;

  // Fallback to single chunk if fileSize is unknown
  if (fileSize <= 0 || fileSize < CHUNK_SIZE) {
    const targetWorker = getBalancedWorker(pool, selfBase, 0);
    const chunkUrl = `${targetWorker}/api/live/chunk?url=${encodeURIComponent(cleanUrl)}${refParam}`;
    return `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${Math.ceil(totalDurationSec)}\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:${totalDurationSec.toFixed(3)},${title}\n${chunkUrl}\n#EXT-X-ENDLIST\n`;
  }

  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  const chunkDur = totalDurationSec / totalChunks;
  const targetDur = Math.ceil(chunkDur) + 1;

  let m3u8 = `#EXTM3U\n`;
  m3u8 += `#EXT-X-VERSION:4\n`;
  m3u8 += `#EXT-X-TARGETDURATION:${targetDur}\n`;
  m3u8 += `#EXT-X-MEDIA-SEQUENCE:1\n`;
  m3u8 += `#EXT-X-PLAYLIST-TYPE:VOD\n`;

  for (let i = 0; i < totalChunks; i++) {
    const offset = i * CHUNK_SIZE;
    const len = Math.min(CHUNK_SIZE, fileSize - offset);
    const dur = (i === totalChunks - 1 && (totalDurationSec % chunkDur !== 0))
      ? (totalDurationSec - i * chunkDur).toFixed(3)
      : chunkDur.toFixed(3);

    const targetWorker = getBalancedWorker(pool, selfBase, i);
    const chunkUrl = `${targetWorker}/api/live/chunk?url=${encodeURIComponent(cleanUrl)}${refParam}`;

    m3u8 += `#EXTINF:${dur},${title} - Part ${i + 1}\n`;
    m3u8 += `#EXT-X-BYTERANGE:${len}@${offset}\n`;
    m3u8 += `${chunkUrl}\n`;
  }

  m3u8 += `#EXT-X-ENDLIST\n`;
  return m3u8;
}

/**
 * Proxies a target URL through a balanced worker.
 */
function proxied(workerBase, targetUrl, playlistMode, suffix = '') {
  const cleanTarget = unwrapNestedProxyUrl(targetUrl);
  let enc = encodeURIComponent(cleanTarget);
  // Unescape DASH template tokens so ExoPlayer / Dash.js / Shaka can expand them client-side
  enc = enc
    .replace(/%24Number%24/gi, '$Number$')
    .replace(/%24Number%2505d%24/gi, '$Number%05d$')
    .replace(/%24Time%24/gi, '$Time$')
    .replace(/%24RepresentationID%24/gi, '$RepresentationID$')
    .replace(/%24Bandwidth%24/gi, '$Bandwidth$');

  return playlistMode
    ? `${workerBase}/api/live/proxy.m3u8?url=${enc}${suffix}`
    : `${workerBase}/api/live/chunk?url=${enc}${suffix}`;
}

/**
 * Detects if a segment URL or header represents disguised video (e.g. .woff / .woff2 / .m4s).
 */
export function isDisguisedVideoSegment(urlStr, contentType = '') {
  const lowerUrl = (urlStr || '').toLowerCase();
  const lowerCt = (contentType || '').toLowerCase();

  const hasVideoExtension =
    lowerUrl.includes('.woff') ||
    lowerUrl.includes('.woff2') ||
    lowerUrl.includes('.m4s') ||
    lowerUrl.includes('.m4v') ||
    lowerUrl.includes('.mp4') ||
    lowerUrl.includes('/init-') ||
    lowerUrl.includes('/seg-') ||
    lowerUrl.includes('chunk-');

  const hasFontMime =
    lowerCt.includes('font/') ||
    lowerCt.includes('application/font') ||
    lowerCt.includes('application/x-font') ||
    lowerCt.includes('octet-stream');

  return hasVideoExtension && (hasFontMime || !lowerCt || lowerCt.includes('text/'));
}

/**
 * Resolves upstream headers based on provider anti-hotlink & CDN rules.
 */
export function getProviderHeaders(targetUrlStr, customReferer = '') {
  let target;
  try {
    target = new URL(targetUrlStr);
  } catch (_) {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };
  }

  const host = target.hostname.toLowerCase();
  const path = target.pathname.toLowerCase();

  // 1. NxSha / ShowNitro / Pitro / Aurorion / 97bf1 / s1q2105 (.woff / .woff2 / .image disguised chunks)
  // MUST have Referer: https://nxsha.space/ and Origin: https://nxsha.space
  if (
    host.includes('aurorionbranding.site') ||
    host.includes('itsnitrox.tech') ||
    host.includes('nxsha') ||
    host.includes('97bf1.com') ||
    host.includes('s1q2105.com') ||
    host.includes('nxstreamhub') ||
    host.includes('tiktokcdn.com') ||
    path.includes('/nitro/') ||
    path.includes('/pitro/') ||
    path.includes('/meb/')
  ) {
    const ref = customReferer || 'https://nxsha.space/';
    let origin;
    try { origin = new URL(ref).origin; } catch (_) { origin = 'https://nxsha.space'; }
    return {
      Referer: ref,
      Origin: origin,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: '*/*',
    };
  }

  // 2. MovieBox Native CDN (HakunaMatata / Aoneroom)
  // Strictly requires okhttp/4.12.0 AND NO Referer (Referer causes 403 Forbidden)
  if (
    host.includes('hakunaymatata.com') ||
    host.includes('aoneroom.com') ||
    host.includes('inmoviebox.com')
  ) {
    return {
      'User-Agent': 'okhttp/4.12.0',
      Accept: '*/*',
    };
  }

  // 3. VidSrc / VidSrc Buzz / 2embed
  if (host.includes('vidsrc') || host.includes('2embed')) {
    return {
      Referer: 'https://vidsrc.buzz/',
      Origin: 'https://vidsrc.buzz',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: '*/*',
    };
  }

  // 4. Live Cricket / Sports (MHDTV, TouchCric, SportsLive, WebCric, SmartPlayTV)
  if (
    host.includes('touchcric') ||
    host.includes('mhdtv') ||
    host.includes('sportslive.wine') ||
    host.includes('smartplaytv.in') ||
    host.includes('1freecdn') ||
    host.includes('finalspot') ||
    host.includes('myturn1.top') ||
    host.includes('aiv-cdn.net')
  ) {
    const isWebCric = host.includes('1freecdn') || host.includes('finalspot');
    const ref = customReferer || (isWebCric ? 'https://webcric.is/' : 'https://live.mhdtv.online/');
    let origin;
    try { origin = new URL(ref).origin; } catch (_) { origin = 'https://live.mhdtv.online'; }
    return {
      Referer: ref,
      Origin: origin,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: '*/*',
    };
  }

  // 5. Custom Referer provided by caller
  if (customReferer) {
    let origin;
    try { origin = new URL(customReferer).origin; } catch (_) { origin = `${target.protocol}//${target.host}`; }
    return {
      Referer: customReferer,
      Origin: origin,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: '*/*',
    };
  }

  // 6. Default Fallback: Self-Origin Referer
  return {
    Referer: `${target.protocol}//${target.host}/`,
    Origin: `${target.protocol}//${target.host}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: '*/*',
  };
}

/**
 * Rewrites an m3u8 playlist so every media segment is equally load-balanced across 40+ workers.
 */
export function rewriteM3u8(text, baseUrl, workerPool, selfBase, suffix = '') {
  const pool = Array.isArray(workerPool) && workerPool.length > 0 ? workerPool : [selfBase];
  let segmentIndex = 0;
  let nextIsVariantPlaylist = false;

  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Tag line
      if (trimmed.startsWith('#')) {
        // Tag indicates next line is a media/variant playlist
        if (trimmed.startsWith('#EXT-X-STREAM-INF') || trimmed.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
          nextIsVariantPlaylist = true;
        }

        if (trimmed.includes('URI="')) {
          return trimmed.replace(/URI="([^"]+)"/gi, (match, uri) => {
            const abs = absUrl(baseUrl, uri);
            const isMap = trimmed.startsWith('#EXT-X-MAP');
            const isMedia = trimmed.startsWith('#EXT-X-MEDIA');
            const isPlaylist = !isMap && (isMedia || /\.m3u8(\?|$)/i.test(abs));
            const targetWorker = getBalancedWorker(pool, selfBase, segmentIndex++);
            return `URI="${proxied(targetWorker, abs, isPlaylist, suffix)}"`;
          });
        }
        return line;
      }

      // Plain URI line (variant playlist or media segment)
      const abs = absUrl(baseUrl, trimmed);
      const isPlaylist = nextIsVariantPlaylist || /\.m3u8(\?|$)/i.test(abs);
      nextIsVariantPlaylist = false;
      const targetWorker = getBalancedWorker(pool, selfBase, segmentIndex++);
      return proxied(targetWorker, abs, isPlaylist, suffix);
    })
    .join('\n');
}

/**
 * Rewrites an MPD manifest's URLs across the worker pool:
 *  - <BaseURL> elements
 *  - SegmentTemplate media=/initialization= attributes
 *  - SegmentList/SegmentBase sourceURL= + SegmentURL media= attributes
 */
export function rewriteMpd(text, baseUrl, workerPool, selfBase, suffix = '') {
  const pool = Array.isArray(workerPool) && workerPool.length > 0 ? workerPool : [selfBase];
  let segmentIndex = 0;

  let out = text.replace(
    /<(BaseURL|BaseUrl)>[\s]*?([^<>]+?)[\s]*?<\/\1>/gi,
    (match, tag, uri) => {
      const abs = absUrl(baseUrl, uri.trim());
      if (!/^https?:\/\//i.test(abs)) return match;
      const targetWorker = getBalancedWorker(pool, selfBase, segmentIndex++);
      return `<${tag}>${proxied(targetWorker, abs, false, suffix)}</${tag}>`;
    }
  );

  out = out.replace(
    /\b(media|initialization|indexRange|sourceURL)="([^"]+)"/gi,
    (match, attr, uri) => {
      if (attr.toLowerCase() === 'indexrange') return match;
      if (/^https?:\/\//i.test(uri) || uri.includes('/')) {
        const abs = absUrl(baseUrl, uri);
        const targetWorker = getBalancedWorker(pool, selfBase, segmentIndex++);
        return `${attr}="${proxied(targetWorker, abs, false, suffix)}"`;
      }
      if (/\$Number\$|\$Time\$|\$RepresentationID\$|\.m4s|\.m4v|\.m4a|\.m3u8|\.mp4|\.woff/i.test(uri)) {
        const abs = absUrl(baseUrl, uri);
        const targetWorker = getBalancedWorker(pool, selfBase, segmentIndex++);
        return `${attr}="${proxied(targetWorker, abs, false, suffix)}"`;
      }
      return match;
    }
  );

  // XML requires all ampersands in attributes and URLs to be &amp;
  return out.replace(/&(?!(amp|lt|gt|quot|apos);)/g, '&amp;');
}

/**
 * Proxies any media URL with intelligent provider headers, disguised woff handling,
 * and Range/partial-content streaming.
 */
export async function proxyMedia(
  targetUrl,
  request,
  selfBase,
  forcePlaylist = false,
  defaultReferer = '',
  workerPool = []
) {
  const actualTarget = unwrapNestedProxyUrl(targetUrl);
  const reqUrl = new URL(request.url);
  const extraCookie = reqUrl.searchParams.get('cookie') || '';
  const extraReferer = reqUrl.searchParams.get('ref') || reqUrl.searchParams.get('referer') || defaultReferer || '';

  // Get provider-specific headers
  const providerHeaders = getProviderHeaders(actualTarget, extraReferer);

  const forwardHeaders = new Headers();
  for (const [k, v] of Object.entries(providerHeaders)) {
    if (v) forwardHeaders.set(k, v);
  }

  // Pass through client headers (Range is crucial for scrubbing)
  const passThrough = ['range', 'if-range', 'if-none-match', 'if-modified-since', 'accept', 'accept-encoding'];
  for (const h of passThrough) {
    const v = request.headers.get(h);
    if (v) forwardHeaders.set(h, v);
  }

  if (extraCookie) forwardHeaders.set('Cookie', extraCookie);

  const upstream = await fetch(actualTarget, {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: forwardHeaders,
    redirect: 'follow',
  });

  const rawContentType = (upstream.headers.get('content-type') || '').toLowerCase();
  const isPlaylist =
    forcePlaylist ||
    rawContentType.includes('mpegurl') ||
    /\.m3u8(\?|$)/i.test(targetUrl) ||
    rawContentType.includes('dash+xml') ||
    /\.mpd(\?|$)/i.test(targetUrl);

  // 1. Manifest Rewriting (m3u8 / mpd) with 40+ Worker Equal Load Balancing
  if (isPlaylist && upstream.ok) {
    const bodyText = await upstream.text();
    const isHtmlError = bodyText.trim().startsWith('<!DOCTYPE') || bodyText.trim().startsWith('<html');

    if (!isHtmlError && (bodyText.includes('#EXTM3U') || bodyText.includes('<MPD') || forcePlaylist)) {
      const suffix =
        (extraCookie ? `&cookie=${encodeURIComponent(extraCookie)}` : '') +
        (extraReferer ? `&ref=${encodeURIComponent(extraReferer)}` : '');

      let out = bodyText;
      if (rawContentType.includes('dash') || /\.mpd(\?|$)/i.test(targetUrl) || bodyText.includes('<MPD')) {
        out = rewriteMpd(bodyText, targetUrl, workerPool, selfBase, suffix);
      } else {
        out = rewriteM3u8(bodyText, targetUrl, workerPool, selfBase, suffix);
      }

      const manifestContentType =
        rawContentType.includes('dash') || /\.mpd(\?|$)/i.test(targetUrl) || bodyText.includes('<MPD')
          ? 'application/dash+xml; charset=utf-8'
          : 'application/vnd.apple.mpegurl; charset=utf-8';

      return new Response(out, {
        status: upstream.status,
        headers: corsHeaders({
          'Content-Type': manifestContentType,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        }),
      });
    }

    // Upstream returned HTML instead of real media manifest
    if (isHtmlError) {
      return new Response(bodyText, {
        status: 502,
        headers: corsHeaders({
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        }),
      });
    }
  }

  // 2. Binary Media Segment / Chunk Proxy
  const headers = corsHeaders();
  for (const h of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
    'cache-control',
  ]) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }

  // Ensure Accept-Ranges is always exposed for scrubbing
  if (!headers['accept-ranges']) {
    headers['accept-ranges'] = 'bytes';
  }

  // ⚡ FIX: Smart Disguised Video Segment Decoding (.woff, .woff2, .image, .m4s)
  // Inspects container byte signature: 0x47 = MPEG-TS (video/mp2t), others = fMP4 (video/mp4)
  const isDisguised =
    isDisguisedVideoSegment(targetUrl, rawContentType) ||
    /\.(woff|woff2|image|png|jpg|m4s|m4v|mp4|ts)(\?|$)/i.test(targetUrl);

  if (isDisguised) {
    if (/\.ts(\?|$)/i.test(targetUrl)) {
      headers['content-type'] = 'video/mp2t';
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    if (targetUrl.includes('init-') || targetUrl.includes('/init')) {
      headers['content-type'] = 'video/mp4';
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    if (upstream.body) {
      try {
        const reader = upstream.body.getReader();
        const firstChunk = await reader.read();
        if (!firstChunk.done && firstChunk.value && firstChunk.value.length > 0) {
          const isMpegTs = firstChunk.value[0] === 0x47;
          headers['content-type'] = isMpegTs ? 'video/mp2t' : 'video/mp4';

          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(firstChunk.value);
              function pump() {
                return reader.read().then(({ done, value }) => {
                  if (done) {
                    controller.close();
                    return;
                  }
                  controller.enqueue(value);
                  return pump();
                });
              }
              return pump();
            },
          });
          return new Response(stream, { status: upstream.status, headers });
        }
      } catch (_) {}
    }

    headers['content-type'] = 'video/mp2t';
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}
