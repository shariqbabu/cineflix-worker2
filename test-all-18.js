import { pathToFileURL } from 'url';
import path from 'path';

const fileUrl = pathToFileURL(path.resolve('src/index.js')).href;
const mod = await import(fileUrl);
const worker = mod.default;

const env = {
  VPS_HOST_URL: process.env.VPS_HOST_URL || 'https://cineflix-ott.duckdns.org',
  APP_SECRET_KEY: process.env.APP_SECRET_KEY || 'shrq6396827211&&shrq9808335538',
  ADMIN_PIN: process.env.ADMIN_PIN || 'cineflix2026',
  CLOUDFLARE_WORKERS: process.env.CLOUDFLARE_WORKERS || ''
};

const woffMaster = 'https://s6-s251765.97bf1.com/hls/oekJglSpXzayhayFzjbXdmwFuGXa4GzH/master.m3u8?token=09806789773f3df612bc6cea80f905d2-1793619275-2a09%3Abac1%3A27c0%3Af0%3A%3A3a5%3A2-7aedbe4e770e5b83611e0b43083bc0069c826f91b766c9854a05f07180826c1b';

const tests = [
  { name: 'Health Check', path: '/health' },
  { name: 'Workers Pool Registry', path: '/api/workers' },
  { name: 'Live Channels List', path: '/api/live/channels' },
  { name: 'FanCode ClearKey Info', path: '/api/live/fancode/info' },
  { name: 'SonyLiv ClearKey Info', path: '/api/live/sonyliv_hi/info' },
  { name: 'FanCode Live Manifest', path: '/api/live/fancode' },
  { name: 'Stream Resolver (Avatar)', path: '/api/resolve/avatar' },
  { name: 'Movie Stream (/id/avatar/movie/index.m3u8)', path: '/id/avatar/movie/index.m3u8' },
  { name: 'Cricket Live API', path: '/api/cricket/live' },
  { name: 'Cricket Matches API', path: '/api/cricket/matches' },
  { name: 'Preroll API', path: '/api/preroll' },
  { name: 'Web Player HTML (/player)', path: '/player' },
  { name: 'Player Script (/player.js)', path: '/player.js' },
  { name: 'Styles (/styles.css)', path: '/styles.css' },
  { name: 'Subpath Script (/play/player.js)', path: '/play/player.js' },
  { name: 'Disguised .woff Proxy', path: '/api/proxy?url=https%3A%2F%2Fotte.cache.aiv-cdn.net%2Fvideo%2Finit-f1-v1-a1.woff' },
  { name: 'Star4b Live HLS Stream', path: '/hls/star4b/playlist.m3u8' },
  { name: 'WOFF Master Playlist with Audio', path: '/api/live/proxy.m3u8?url=' + encodeURIComponent(woffMaster) + '&ref=https%3A%2F%2Fnxsha.space%2F' },
];

console.log('Testing worker 2 across all 18 endpoints...\n');
let passed = 0;
for (const t of tests) {
  const res = await worker.fetch(new Request('https://worker2.dev' + t.path), env);
  const isOk = res.status >= 200 && res.status < 400;
  const symbol = isOk ? '✅' : '❌';
  if (isOk) passed++;
  const ct = (res.headers.get('content-type') || '-').split(';')[0];
  console.log(`${symbol} [${res.status}] ${t.name.padEnd(38)} (${ct})`);
}
console.log(`\nLocal Score: ${passed}/${tests.length} endpoints passed!`);
