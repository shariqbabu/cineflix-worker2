const BASE = 'https://backend.betadda.workers.dev';

async function testAll() {
  const results = [];

  async function check(name, path, validate) {
    const url = BASE + path;
    const start = Date.now();
    try {
      const res = await fetch(url, { redirect: 'manual' });
      const duration = Date.now() - start;
      const contentType = res.headers.get('content-type') || '';
      let bodyText = '';
      let json = null;
      if (contentType.includes('application/json')) {
        json = await res.json().catch(() => null);
      } else {
        bodyText = await res.text().catch(() => '');
      }

      const valResult = validate ? validate(res, json || bodyText) : { ok: res.ok };
      results.push({
        name,
        path,
        status: res.status,
        duration: duration + 'ms',
        contentType: contentType.split(';')[0],
        ok: valResult.ok,
        details: valResult.details || (json ? JSON.stringify(json).slice(0, 80) : bodyText.slice(0, 80))
      });
    } catch (err) {
      results.push({ name, path, ok: false, error: err.message });
    }
  }

  console.log('Testing live endpoints on:', BASE);

  // 1. Health
  await check('Health Check', '/health', (res, data) => ({
    ok: res.ok && data?.ok === true,
    details: 'Service: ' + data?.service + ', Workers: ' + (data?.workersInPool || data?.workers?.length || 'N/A')
  }));

  // 2. Workers Pool
  await check('Workers Pool Registry', '/api/workers', (res, data) => ({
    ok: res.ok && Array.isArray(data?.workers),
    details: 'Pool count: ' + (data?.count || data?.workers?.length || 0)
  }));

  // 3. Live Channels List
  await check('Live Channels List', '/api/live/channels', (res, data) => ({
    ok: res.ok && Array.isArray(data?.channels),
    details: 'Channels: ' + (data?.channels?.map(c => c.id).join(', ') || 'none')
  }));

  // 4. MHDTV FanCode DRM Info
  await check('FanCode ClearKey Info', '/api/live/fancode/info', (res, data) => ({
    ok: res.ok && !!data?.clearkey,
    details: 'ClearKey: ' + (data?.clearkey || 'missing')
  }));

  // 5. MHDTV SonyLiv DRM Info
  await check('SonyLiv ClearKey Info', '/api/live/sonyliv_hi/info', (res, data) => ({
    ok: res.ok && !!data?.clearkey,
    details: 'ClearKey: ' + (data?.clearkey || 'missing')
  }));

  // 6. MHDTV FanCode Manifest Stream & Headers
  await check('FanCode Live Manifest', '/api/live/fancode', (res, text) => {
    const hasDrm = !!res.headers.get('x-drm-clearkey');
    const isXml = typeof text === 'string' && (text.includes('<MPD') || res.headers.get('content-type')?.includes('dash'));
    return {
      ok: res.ok && isXml,
      details: 'DASH MPD: ' + isXml + ', X-DRM-ClearKey: ' + (res.headers.get('x-drm-clearkey') || 'missing')
    };
  });

  // 7. Resolver (Avatar)
  await check('Stream Resolver (Avatar)', '/api/resolve/avatar', (res, data) => ({
    ok: res.ok && data?.success && !!data?.streamUrl,
    details: 'Provider: ' + (data?.provider || 'N/A') + ', Format: ' + (data?.format || 'N/A')
  }));

  // 8. MovieBox / VPS HLS Manifest
  await check('Movie Stream (/id/avatar/movie/index.m3u8)', '/id/avatar/movie/index.m3u8', (res, text) => {
    const isM3u = typeof text === 'string' && text.includes('#EXTM3U');
    return {
      ok: res.ok && isM3u,
      details: 'M3U8 valid: ' + isM3u + ', lines: ' + (typeof text === 'string' ? text.split('\n').length : 0)
    };
  });

  // 9. Cricket Live API
  await check('Cricket Live API', '/api/cricket/live', (res, data) => ({
    ok: res.ok && data?.success === true,
    details: 'Match: ' + (data?.match?.title || data?.data?.title || 'No live match right now')
  }));

  // 10. Cricket Matches List API
  await check('Cricket Matches API', '/api/cricket/matches', (res, data) => ({
    ok: res.ok && data?.success === true,
    details: 'Matches count: ' + (data?.matches?.length || 0)
  }));

  // 11. Pre-roll Ad API
  await check('Preroll API', '/api/preroll', (res, data) => ({
    ok: res.ok,
    details: 'Enabled: ' + data?.enabled
  }));

  // 12. Static Web Player UI
  await check('Web Player HTML (/player)', '/player', (res, text) => ({
    ok: res.ok && typeof text === 'string' && text.includes('CineFlix OTT'),
    details: 'HTML title: CineFlix OTT'
  }));

  // 13. Player JS
  await check('Player Script (/player.js)', '/player.js', (res, text) => ({
    ok: res.ok && typeof text === 'string' && text.includes('CINEFLIX OTT ENGINE'),
    details: 'Size: ' + (typeof text === 'string' ? text.length : 0) + ' bytes'
  }));

  // 14. Stylesheet
  await check('Styles (/styles.css)', '/styles.css', (res, text) => ({
    ok: res.ok && typeof text === 'string' && text.includes('CineFlix Dark Cinema Theme'),
    details: 'Size: ' + (typeof text === 'string' ? text.length : 0) + ' bytes'
  }));

  // 15. Subpath Static Assets (/play/player.js)
  await check('Subpath Script (/play/player.js)', '/play/player.js', (res, text) => ({
    ok: res.ok && typeof text === 'string' && text.includes('CINEFLIX OTT ENGINE'),
    details: 'Size: ' + (typeof text === 'string' ? text.length : 0) + ' bytes'
  }));

  // 16. Disguised .woff Video Segment Proxy
  await check('Disguised .woff Segment Proxy', '/api/proxy?url=https%3A%2F%2Fotte.cache.aiv-cdn.net%2Fvideo%2Finit-f1-v1-a1.woff', (res) => {
    const mime = res.headers.get('content-type');
    const isNormalized = mime === 'video/mp4';
    return {
      ok: isNormalized,
      details: 'Normalized MIME: ' + mime
    };
  });

  // 17. WOFF Stream Master Playlist with Audio Tracks
  const woffMaster = 'https://wts.itsnitrox.tech/pitro/3455334d743569636c5233636831324c334d544e3541444d79637a4c344d444d784d6a4e7a6b7a4e7838695a6b6857616e68576470685759316c47616f7032617645565549356b51695246616b3555595664455370646d59694645613346314c7446575a79523363763032626a354365704a585a754647617638694f7a424864306857656c7432586c4a58646a56326366686e62/master.m3u8';
  await check('WOFF Stream with Audio Tracks', '/api/live/proxy.m3u8?url=' + encodeURIComponent(woffMaster) + '&ref=' + encodeURIComponent('https://nxsha.space/'), (res, text) => {
    const hasAudio = typeof text === 'string' && text.includes('TYPE=AUDIO');
    const hasVideo = typeof text === 'string' && text.includes('#EXT-X-STREAM-INF');
    const hasHindi = typeof text === 'string' && text.includes('हिन्दी');
    return {
      ok: res.ok && hasAudio && hasVideo,
      details: 'Audio track: ' + hasAudio + ' (Hindi: ' + hasHindi + '), Video track: ' + hasVideo
    };
  });

  // 18. Star4b Live Channel
  await check('Star4b Live HLS Stream', '/hls/star4b/playlist.m3u8', (res, text) => {
    const isM3u = typeof text === 'string' && text.includes('#EXTM3U');
    return {
      ok: res.ok && isM3u,
      details: 'M3U8 valid: ' + isM3u + ', lines: ' + (typeof text === 'string' ? text.split('\n').length : 0)
    };
  });

  console.log('\n======================================================');
  console.log('             ENDPOINT TEST RESULTS REPORT             ');
  console.log('======================================================\n');
  let passed = 0;
  for (const r of results) {
    const symbol = r.ok ? '✅' : '❌';
    if (r.ok) passed++;
    console.log(`${symbol} [${r.status || 'ERR'}] ${r.name.padEnd(38)} (${r.duration || '-'})`);
    if (r.details) console.log(`   └─ ${r.details}`);
    if (r.error) console.log(`   └─ Error: ${r.error}`);
  }
  console.log(`\nScore: ${passed}/${results.length} endpoints passed.`);
}

testAll();
