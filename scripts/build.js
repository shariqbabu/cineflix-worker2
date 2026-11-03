import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const publicDir = path.join(rootDir, 'public');
const uiDir = path.join(rootDir, 'src', 'ui');

if (!fs.existsSync(uiDir)) {
  fs.mkdirSync(uiDir, { recursive: true });
}

console.log('🔄 Syncing UI assets from public/ to src/ui/ ...');

// 1. Sync index.html -> src/ui/html.js
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
fs.writeFileSync(path.join(uiDir, 'html.js'), `export const INDEX_HTML = ${JSON.stringify(html)};\n`);
console.log('  ✓ index.html -> src/ui/html.js');

// 2. Sync styles.css -> src/ui/css.js
const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
fs.writeFileSync(path.join(uiDir, 'css.js'), `export const STYLES_CSS = ${JSON.stringify(css)};\n`);
console.log('  ✓ styles.css -> src/ui/css.js');

// 3. Sync player.js -> src/ui/player.js
const player = fs.readFileSync(path.join(publicDir, 'player.js'), 'utf8');
fs.writeFileSync(path.join(uiDir, 'player.js'), `export const PLAYER_JS = ${JSON.stringify(player)};\n`);
console.log('  ✓ player.js -> src/ui/player.js');

console.log('✅ UI assets successfully compiled & synchronized into worker source!');
