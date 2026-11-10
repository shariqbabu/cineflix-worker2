// ---------------------------------------------------------------------------
// MovieBox / OneRoom API client — port of MovieBoxClient.kt
// (search + play-info + signed requests + CloudFront manifest extraction).
// ---------------------------------------------------------------------------

import {
  generateClientToken,
  generateSignature,
  generateClientInfoAndUa,
  randomSpoofedIp,
  resolveDashManifestFromPolicy,
  formatSignCookie,
} from './crypto.js';

const HOST_POOL = [
  'https://api6.aoneroom.com',
  'https://api5.aoneroom.com',
  'https://api4.aoneroom.com',
  'https://api4sg.aoneroom.com',
  'https://api3.aoneroom.com',
  'https://api6sg.aoneroom.com',
  'https://api.inmoviebox.com',
];

let _clientInfoCache = null;
function getClientInfo() {
  if (!_clientInfoCache) {
    _clientInfoCache = generateClientInfoAndUa();
  }
  return _clientInfoCache;
}

// Instance-cached visitor token (falls back to seeded token).
let cachedToken = null; // Obtain an independent visitor session; no baked-in token.

async function requestAcrossHosts(method, pathAndQuery, bodyStr, authToken) {
  const clientData = getClientInfo();
  for (const host of HOST_POOL) {
    const fullUrl = `${host}${pathAndQuery}`;
    const nowMs = Date.now();
    const clientToken = generateClientToken(nowMs);
    const signature = generateSignature(method, 'application/json', 'application/json', fullUrl, bodyStr, nowMs);

    const headers = {
      'User-Agent': clientData.userAgent,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Connection: 'keep-alive',
      'x-client-token': clientToken,
      'x-tr-signature': signature,
      'x-client-info': clientData.clientInfo,
      'x-client-status': '0',
      'x-forwarded-for': randomSpoofedIp(),
    };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;

    try {
      const resp = await fetch(fullUrl, {
        method,
        headers,
        body: method.toUpperCase() === 'POST' ? bodyStr || '{}' : undefined,
        redirect: 'follow',
        signal: AbortSignal.timeout(4500),
      });

      const xUser = resp.headers.get('x-user');
      if (xUser) {
        try {
          const parsed = JSON.parse(xUser);
          if (parsed.token) cachedToken = parsed.token;
        } catch (_) {}
      }

      if (!resp.ok) continue;
      return await resp.json();
    } catch (e) {
      console.warn(`MovieBox host ${host} failed: ${e.message}`);
    }
  }
  return null;
}

async function ensureSession() {
  if (cachedToken) return cachedToken;
  try {
    const json = await requestAcrossHosts('POST', '/wefeed-mobile-bff/user-api/visitor-login', '{}', null);
    const token = json?.data?.token || json?.token;
    if (token) cachedToken = token;
  } catch (_) {}
  return cachedToken;
}

async function executeApi(method, pathAndQuery, bodyStr = null) {
  const token = await ensureSession();
  return requestAcrossHosts(method, pathAndQuery, bodyStr, token);
}

export async function search(query, page = 1) {
  const payload = JSON.stringify({ keyword: query, page, perPage: 15, subjectType: 0 });
  const json = await executeApi('POST', '/wefeed-mobile-bff/subject-api/search/v2', payload);
  const results = json?.data?.results || json?.results || [];
  const subjects = [];
  for (const group of results) {
    for (const item of group.subjects || []) {
      const id = item.subjectId || item.id || '';
      const title = item.title || item.name || '';
      const stype = item.subjectType ?? item.stype ?? 1;
      const year = (item.releaseDate || item.year || '').slice(0, 4) || null;
      const poster =
        (item.cover && item.cover.url) ||
        item.coverUrl ||
        (typeof item.cover === 'string' && item.cover.startsWith('http') ? item.cover : null) ||
        item.poster ||
        null;
      if (id && title) subjects.push({ subjectId: id, title, subjectType: stype, year, posterUrl: poster });
    }
  }
  return subjects;
}

export async function getPlayInfo(subjectId, season = 0, episode = 0) {
  const path =
    season === 0 && episode === 0
      ? `/wefeed-mobile-bff/subject-api/play-info/v2?subjectId=${subjectId}`
      : `/wefeed-mobile-bff/subject-api/play-info/v2?subjectId=${subjectId}&se=${season}&ep=${episode}`;
  return executeApi('GET', path);
}

function isDeprecationNoticeUrl(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  return (
    lower.includes('80da52722ee7de7a4303290af6783424') ||
    lower.includes('1c7de0bd3393702d9191801f15f88f8d') ||
    lower.includes('9a0461bc39da389663bf3dbb17091d3f') ||
    lower.includes('/notice.mp4') ||
    lower.includes('notice')
  );
}

function generateSearchQueries(title) {
  const list = [];
  const cleaned = title
    .replace(/\[.*?\]|\(.*?\)|4k|1080p|720p|hdr|web-dl|hdrip|bluray|hindi|dubbed|dub/gi, '')
    .replace(/[:\-_.,!?/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned) list.push(cleaned);
  if (title.includes(':') || title.includes('-')) {
    const mainPart = title.split(/[:\-]/)[0].replace(/\[.*?\]|\(.*?\)/gi, '').trim();
    if (mainPart && !list.includes(mainPart)) list.push(mainPart);
  }
  const words = cleaned.split(' ').filter(Boolean);
  if (words.length > 2) {
    const two = words.slice(0, 2).join(' ');
    if (!list.includes(two)) list.push(two);
    if (words.length > 3) {
      const three = words.slice(0, 3).join(' ');
      if (!list.includes(three)) list.push(three);
    }
  }
  const raw = title.trim();
  if (!list.includes(raw)) list.push(raw);
  return list;
}

async function tmdbFind(imdbId, tmdbKey) {
  // Optional: set TMDB_API_KEY in wrangler.toml [vars] (or `wrangler secret put TMDB_API_KEY`)
  // to map IMDb ids (tt…) to titles when MovieBox search misses.
  const key = tmdbKey || '';
  if (!key) return null;
  try {
    const resp = await fetch(
      `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?external_source=imdb_id&api_key=${key}`
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    const movie = json.movie_results?.[0];
    if (movie?.title) return { title: movie.title, isSeries: false, year: (movie.release_date || '').slice(0, 4) };
    const tv = json.tv_results?.[0];
    if (tv?.name) return { title: tv.name, isSeries: true, year: (tv.first_air_date || '').slice(0, 4) };
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * High-level resolver — returns { streamUrl, signCookie, referer, format } or null.
 * Accepts subjectId ("mb_" prefix stripped), numeric id, "tt…" IMDb id, or a title.
 */
export async function resolveStream({ id, title, isSeries, season = 1, episode = 1, year = null, tmdbKey = '' }) {
  let targetSubjectId = null;
  let isSubjectSeries = isSeries;

  const cleanId = (id || '').replace(/^mb_/, '').trim();
  const looksLikeSubjectId = cleanId && /^\d+$/.test(cleanId);
  if (looksLikeSubjectId) {
    targetSubjectId = cleanId;
    isSubjectSeries = isSeries;
    console.log(`MovieBox resolveStream: explicit subjectId=${targetSubjectId}`);
  } else {
    // IMDb tt-id: try MovieBox search on the raw id, then TMDB find -> title
    let seed = title || (cleanId.startsWith('tt') ? cleanId : '');
    const candidates = generateSearchQueries(seed);
    let searchResults = [];
    for (const q of candidates) {
      searchResults = await search(q);
      if (searchResults.length > 0) break;
    }

    if (searchResults.length === 0 && /^tt\d+$/i.test(cleanId)) {
      const found = await tmdbFind(cleanId, tmdbKey);
      if (found?.title) {
        isSeries = found.isSeries || isSeries;
        seed = found.title;
        year = year || found.year;
        searchResults = await search(found.title);
      }
    }

    if (searchResults.length === 0) {
      console.warn(`MovieBox: no search results for '${seed}'`);
      return null;
    }
    const targetType = isSeries ? 2 : 1;
    const matched =
      searchResults.find((s) => (s.subjectType === targetType || s.subjectType === 0) && (!year || s.year === year)) ||
      searchResults.find((s) => s.subjectType === targetType || s.subjectType === 0) ||
      searchResults[0];
    targetSubjectId = matched.subjectId;
    isSubjectSeries = matched.subjectType === 2 || (isSeries && matched.subjectType !== 1);
    console.log(`MovieBox matched subject id=${targetSubjectId} title='${matched.title}' type=${matched.subjectType}`);
  }

  const se = isSubjectSeries ? (season > 0 ? season : 1) : 0;
  const ep = isSubjectSeries ? (episode > 0 ? episode : 1) : 0;
  const playInfoJson = await getPlayInfo(targetSubjectId, se, ep);
  if (!playInfoJson) return null;

  const data = playInfoJson.data || playInfoJson;
  const streams = data.streams;
  if (!streams || streams.length === 0) return null;

  for (const stream of streams) {
    const signCookie = stream.signCookie || '';
    const rawUrl = stream.url || '';
    const dashManifest = signCookie ? resolveDashManifestFromPolicy(signCookie) : null;

    let playableUrl = '';
    if (dashManifest) {
      playableUrl = dashManifest;
    } else if (/^https?:\/\//.test(rawUrl)) {
      if (!/\.(mpd|m3u8|mp4)$/.test(rawUrl)) {
        if (rawUrl.includes('/dash/')) playableUrl = `${rawUrl}/index.mpd`;
        else if (rawUrl.includes('/hls/')) playableUrl = `${rawUrl}/master.m3u8`;
        else playableUrl = `${rawUrl}.mpd`;
      } else {
        playableUrl = rawUrl;
      }
    }

    if (playableUrl && !isDeprecationNoticeUrl(playableUrl)) {
      const rawFormat = stream.format || '';
      const detectedFormat = /\.m3u8$|hls/i.test(playableUrl + rawFormat)
        ? 'HLS'
        : /\.mpd$|dash/i.test(playableUrl + rawFormat)
          ? 'DASH'
          : rawFormat || 'DASH';

      return {
        streamUrl: playableUrl,
        signCookie: formatSignCookie(signCookie),
        userAgent: getClientInfo().userAgent,
        referer: 'https://sportslive.wine',
        format: detectedFormat,
      };
    }
  }
  return null;
}
