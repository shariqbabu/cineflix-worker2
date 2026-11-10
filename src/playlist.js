import { fetchPublic, readBounded, normalizeSegment, byteRange } from './media.js';
let activeSegments = 0;
// ---------------------------------------------------------------------------
// HLS / DASH manifest proxy with URI rewriting.
// Every playlist line (and every URI="..." attribute) is re-pointed through this
// worker so relative segment URLs and geo-blocked origins keep working.
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
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

function proxied(selfBase, targetUrl, playlistMode, suffix = '') {
  const enc = encodeURIComponent(targetUrl);
  return playlistMode
    ? `${selfBase}/api/live/proxy.m3u8?url=${enc}${suffix}`
    : `${selfBase}/api/proxy?url=${enc}${suffix}`;
}

/**
 * Rewrites an m3u8 playlist so every media/variant URI routes through this worker.
 * @param {string} text playlist body
 * @param {string} baseUrl absolute URL of the playlist (for resolving relatives)
 * @param {string} selfBase worker origin
 * @param {string} suffix extra query params (cookie/referer) to inherit
 */
export function rewriteM3u8(text, baseUrl, selfBase, suffix = '') {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // URI="..." inside tags (#EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF…)
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/gi, (match, uri) => {
          const abs = absUrl(baseUrl, uri);
          const isPlaylist = /\.m3u8(\?|$)/i.test(abs);
          return `URI="${proxied(selfBase, abs, isPlaylist, suffix)}"`;
        });
      }

      // Plain URI line (variant playlist or media segment)
      const abs = absUrl(baseUrl, trimmed);
      const isPlaylist = /\.m3u8(\?|$)/i.test(abs);
      return proxied(selfBase, abs, isPlaylist, suffix + (isPlaylist ? '' : '&segment=1'));
    })
    .join('\n');
}

/**
 * Rewrites an MPD manifest's URLs through this worker:
 *  - <BaseURL>text</BaseURL> elements (Representation/AdaptationSet level)
 *  - SegmentTemplate media=/initialization= attributes (token templates survive —
 *    ExoPlayer expands $Number$/$Time$ in the query string client-side)
 *  - SegmentList/SegmentBase sourceURL= + SegmentURL media= attributes
 *
 * [suffix] (cookie/referer query params) MUST be inherited by every proxied URI,
 * otherwise signed CloudFront DASH segments 403 after the manifest itself loaded.
 */
export function rewriteMpd(text, baseUrl, selfBase, suffix = '') {
  let out = text.replace(
    /<(BaseURL|BaseUrl)>[\s]*?([^<>]+?)[\s]*?<\/\1>/gi,
    (match, tag, uri) => {
      const abs = absUrl(baseUrl, uri.trim());
      if (!/^https?:\/\//i.test(abs)) return match;
      return `<${tag}>${proxied(selfBase, abs, false, suffix)}</${tag}>`;
    }
  );
  out = out.replace(
    /\b(media|initialization|indexRange|sourceURL)="([^"]+)"/gi,
    (match, attr, uri) => {
      if (attr.toLowerCase() === 'indexrange') return match;
      if (/^https?:\/\//i.test(uri) || uri.includes('/')) {
        const abs = absUrl(baseUrl, uri);
        return `${attr}="${proxied(selfBase, abs, false, suffix)}"`;
      }
      // Relative template values (e.g. media="00000$Number$.m4s") — proxy them too:
      if (/\$Number\$|\$Time\$|\$RepresentationID\$|\.m4s|\.m4v|\.m4a|\.m3u8|\.mp4/i.test(uri)) {
        const abs = absUrl(baseUrl, uri);
        return `${attr}="${proxied(selfBase, abs, false, suffix)}"`;
      }
      return match;
    }
  );
  return out;
}

/**
 * Proxies any media URL: playlists are rewritten, everything else is streamed
 * through with original headers (Range, content-type…).
 * Optional query params: `cookie` (CloudFront sign cookie) and `referer`.
 */
export async function proxyMedia(targetUrl, request, selfBase, forcePlaylist = false) {
  const reqUrl = new URL(request.url);
  const extraCookie = reqUrl.searchParams.get('cookie') || '';
  const extraReferer = reqUrl.searchParams.get('ref') || reqUrl.searchParams.get('referer') || '';
  const extraUa = reqUrl.searchParams.get('ua') || '';
  const segment = reqUrl.searchParams.get('segment') === '1';

  const forwardHeaders = new Headers();
  const passThrough = ['range', 'if-range', 'if-none-match', 'if-modified-since', 'accept', 'accept-encoding'];
  for (const h of passThrough) {
    const v = request.headers.get(h);
    if (v && !(segment && ['range','if-range'].includes(h))) forwardHeaders.set(h, v);
  }
  forwardHeaders.set('User-Agent', extraUa || 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  forwardHeaders.set('Referer', extraReferer || (() => { try { return new URL(targetUrl).origin + '/'; } catch (_) { return 'https://sportslive.wine/'; } })());
  if (extraCookie) forwardHeaders.set('Cookie', extraCookie);

  const {response:upstream,url:finalUrl} = await fetchPublic(targetUrl, {
    method: request.method === 'HEAD' && !segment ? 'HEAD' : 'GET',
    headers: forwardHeaders,
    signal: AbortSignal.timeout(20000),
  });
  if (!upstream.ok) {
    await upstream.body?.cancel();
    return new Response(`Upstream media HTTP ${upstream.status}`, {status:upstream.status,headers:corsHeaders({'Cache-Control':'no-store'})});
  }

  const contentType = upstream.headers.get('content-type') || '';
  const isPlaylist =
    forcePlaylist ||
    contentType.includes('mpegurl') ||
    /\.m3u8(\?|$)/i.test(targetUrl) ||
    contentType.includes('dash+xml') ||
    /\.mpd(\?|$)/i.test(targetUrl);

  if (isPlaylist && upstream.ok) {
    const bodyText = await upstream.text();
    const suffix =
      (extraCookie ? `&cookie=${encodeURIComponent(extraCookie)}` : '') +
      (extraReferer ? `&ref=${encodeURIComponent(extraReferer)}` : '') +
      (extraUa ? `&ua=${encodeURIComponent(extraUa)}` : '');
    let out = bodyText;
    if (contentType.includes('dash') || /\.mpd(\?|$)/i.test(targetUrl)) {
      out = rewriteMpd(bodyText, finalUrl, selfBase, suffix);
    } else {
      out = rewriteM3u8(bodyText, finalUrl, selfBase, suffix);
    }
    return new Response(out, {
      status: upstream.status,
      headers: corsHeaders({
        'Content-Type': contentType || 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      }),
    });
  }

  if (segment) {
    if (activeSegments >= 2) { await upstream.body?.cancel(); return new Response('Segment capacity reached; retry', {status:429,headers:corsHeaders({'Retry-After':'1','Cache-Control':'no-store'})}); }
    activeSegments++;
    try {
      const media = normalizeSegment(await readBounded(upstream),contentType);
      const total=media.bytes.length, range=byteRange(request.headers.get('range'),total);
      const headers=corsHeaders({'Content-Type':media.type,'Accept-Ranges':'bytes','X-Media-Prefix-Removed':String(media.removed),'Cache-Control':'private, max-age=60'});
      if (range===false) return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${total}`}});
      const bytes=range?media.bytes.subarray(range.start,range.end+1):media.bytes;
      headers['Content-Length']=String(bytes.length);
      if(range)headers['Content-Range']=`bytes ${range.start}-${range.end}/${total}`;
      return new Response(request.method==='HEAD'?null:bytes,{status:range?206:200,headers});
    } catch(e) { return new Response(e.message,{status:502,headers:corsHeaders({'Cache-Control':'no-store'})}); }
    finally { activeSegments--; }
  }

  // Binary segment / progressive file: stream through verbatim
  const headers = corsHeaders();
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control']) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
