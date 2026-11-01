// ---------------------------------------------------------------------------
// MovieBox / OneRoom request-signing — faithful port of MovieBoxCrypto.kt
// (MD5 + HMAC-MD5 implemented in pure JS: the WebCrypto API has no MD5).
// ---------------------------------------------------------------------------

// ---- MD5 core ---------------------------------------------------------------

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
}

function md5Bytes(input) {
  const bytes = input instanceof Uint8Array ? input : new TextEncoder().encode(String(input));
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
  dv.setUint32(paddedLen - 4, Math.floor(bitLen / 4294967296) >>> 0, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let off = 0; off < paddedLen; off += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) M[j] = dv.getUint32(off + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);
  return out;
}

function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function md5Hex(data) {
  return bytesToHex(md5Bytes(data));
}

function hmacMd5Bytes(keyBytes, message) {
  const BLOCK = 64;
  let key = keyBytes;
  if (key.length > BLOCK) key = md5Bytes(key);
  const padded = new Uint8Array(BLOCK);
  padded.set(key);
  const ipad = new Uint8Array(BLOCK);
  const opad = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    ipad[i] = padded[i] ^ 0x36;
    opad[i] = padded[i] ^ 0x5c;
  }
  const msgBytes = message instanceof Uint8Array ? message : new TextEncoder().encode(String(message));
  const inner = new Uint8Array(BLOCK + msgBytes.length);
  inner.set(ipad);
  inner.set(msgBytes, BLOCK);
  const innerHash = md5Bytes(inner);
  const outer = new Uint8Array(BLOCK + 16);
  outer.set(opad);
  outer.set(innerHash, BLOCK);
  return md5Bytes(outer);
}

// ---- base64 helpers ---------------------------------------------------------

function b64ToBytes(b64) {
  const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function utf8ToBytes(s) {
  return new TextEncoder().encode(s);
}

// ---- signing API (mirrors MovieBoxCrypto.kt) --------------------------------

const SECRET_KEY_DEFAULT = '76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O';
const SIGNATURE_BODY_MAX_BYTES = 102400;

let cachedSecret = null;
function secretBytes() {
  if (!cachedSecret) {
    const pad = SECRET_KEY_DEFAULT + '='.repeat((4 - (SECRET_KEY_DEFAULT.length % 4)) % 4);
    cachedSecret = b64ToBytes(pad);
  }
  return cachedSecret;
}

export function generateClientToken(timestampMs) {
  const tsStr = String(timestampMs);
  const reversed = tsStr.split('').reverse().join('');
  return `${tsStr},${md5Hex(reversed)}`;
}

export function buildCanonicalString(method, accept, contentType, url, body, timestampMs) {
  let path, query = null;
  if (url.includes('://')) {
    const withoutScheme = url.substring(url.indexOf('://') + 3);
    const slashIdx = withoutScheme.indexOf('/');
    if (slashIdx !== -1) {
      const pathAndQuery = withoutScheme.substring(slashIdx);
      const qIdx = pathAndQuery.indexOf('?');
      if (qIdx !== -1) {
        path = pathAndQuery.substring(0, qIdx);
        query = pathAndQuery.substring(qIdx + 1);
      } else {
        path = pathAndQuery;
      }
    } else {
      path = '/';
    }
  } else {
    const qIdx = url.indexOf('?');
    if (qIdx !== -1) {
      path = url.substring(0, qIdx);
      query = url.substring(qIdx + 1);
    } else {
      path = url;
    }
  }

  const sortedQuery = query
    ? query.split('&').filter((s) => s).sort().join('&')
    : '';
  const canonicalUrl = sortedQuery ? `${path}?${sortedQuery}` : path;

  let bodyHash = '';
  let bodyLen = '';
  if (body) {
    const bytes = utf8ToBytes(body);
    const truncated = bytes.length > SIGNATURE_BODY_MAX_BYTES ? bytes.slice(0, SIGNATURE_BODY_MAX_BYTES) : bytes;
    bodyHash = md5Hex(truncated);
    bodyLen = String(bytes.length);
  }

  return `${String(method).toUpperCase()}\n${accept || ''}\n${contentType || ''}\n${bodyLen}\n${timestampMs}\n${bodyHash}\n${canonicalUrl}`;
}

export function generateSignature(method, accept, contentType, url, body, timestampMs) {
  const canonical = buildCanonicalString(method, accept, contentType, url, body, timestampMs);
  const signed = hmacMd5Bytes(secretBytes(), canonical);
  const sigB64 = bytesToB64(signed);
  return `${timestampMs}|2|${sigB64}`;
}

export function generateClientInfoAndUa() {
  const versionCode = 50020117;
  const androidVersion = '11';
  const androidBuild = 'RP1A.200720.011';
  const deviceModel = '2201117TY';
  const brand = 'Redmi';
  const hex = '0123456789abcdef';
  let deviceId = '';
  for (let i = 0; i < 32; i++) deviceId += hex[Math.floor(Math.random() * 16)];
  const gaid = crypto.randomUUID();

  const userAgent = `com.community.oneroom/${versionCode} (Linux; U; Android ${androidVersion}; en_US; ${brand} ${deviceModel}; Build/${androidBuild}; Cronet/135.0.7012.3)`;
  const clientInfo = JSON.stringify({
    package_name: 'com.community.oneroom',
    version_name: '4.0.01.0813.03',
    version_code: versionCode,
    os: 'android',
    os_version: androidVersion,
    install_ch: 'ps',
    device_id: deviceId,
    install_store: 'ps',
    gaid,
    brand,
    model: deviceModel,
    system_language: 'en',
    net: 'NETWORK_WIFI',
    region: 'US',
    timezone: 'Asia/Kolkata',
    sp_code: '40401',
    'X-Play-Mode': '2',
  });
  return { userAgent, clientInfo };
}

export function randomSpoofedIp() {
  const prefixes = ['103.241', '49.36', '117.195', '106.198', '122.162', '157.32', '182.70', '103.58', '27.60'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  return `${prefix}.${1 + Math.floor(Math.random() * 253)}.${1 + Math.floor(Math.random() * 253)}`;
}

// ---- CloudFront policy decoding (resolveDashManifestFromPolicy) -------------

function decodePolicyJson(raw) {
  const strategies = [
    (s) => s.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'),
    (s) => s.replace(/-/g, '+').replace(/_/g, '/'),
    (s) => s,
  ];
  for (const strat of strategies) {
    try {
      let norm = strat(raw);
      norm += '='.repeat((4 - (norm.length % 4)) % 4);
      const decoded = new TextDecoder().decode(b64ToBytes(norm));
      if (decoded.includes('Statement') && decoded.includes('Resource')) return decoded;
    } catch (_) {}
  }
  return null;
}

function normalizeManifestUrl(clean) {
  if (/\.mpd$/i.test(clean) || /\.m3u8$/i.test(clean) || /\.mp4$/i.test(clean)) return clean;
  if (/\/dash\//i.test(clean)) return `${clean}/index.mpd`;
  if (/\/hls\//i.test(clean)) return `${clean}/master.m3u8`;
  return `${clean}/index.mpd`;
}

export function resolveDashManifestFromPolicy(signCookie) {
  if (!signCookie) return null;

  const edge = /urlprefix=([A-Za-z0-9+/=_-]+)/.exec(signCookie);
  if (edge) {
    try {
      const decoded = new TextDecoder().decode(b64ToBytes(edge[1])).trim().replace(/\/+$/, '');
      if (/^https?:\/\//.test(decoded)) return normalizeManifestUrl(decoded);
    } catch (_) {}
  }

  for (const part of signCookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('CloudFront-Policy=')) {
      const jsonStr = decodePolicyJson(trimmed.substring('CloudFront-Policy='.length).trim());
      if (!jsonStr) continue;
      try {
        const root = JSON.parse(jsonStr);
        const resource = root?.Statement?.[0]?.Resource;
        if (resource) {
          const clean = String(resource).replace(/\*+$/, '').replace(/\/+$/, '');
          if (/^https?:\/\//.test(clean)) return normalizeManifestUrl(clean);
        }
      } catch (_) {}
    }
  }
  return null;
}

export function formatSignCookie(signCookie) {
  return (signCookie || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('; ');
}

export { md5Hex };