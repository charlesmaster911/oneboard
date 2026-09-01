import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const production = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const googleClientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const apiBase = String(process.env.ONEBOARD_API_BASE || '').trim();

if (production && !googleClientId) {
  console.error('GOOGLE_CLIENT_ID is required for a production build.');
  process.exit(1);
}
if (production && !apiBase) {
  console.error('ONEBOARD_API_BASE is required for a production build.');
  process.exit(1);
}
if (apiBase && !/^https?:\/\//i.test(apiBase)) {
  console.error('ONEBOARD_API_BASE must be an HTTP(S) URL.');
  process.exit(1);
}

const distRoot = resolve('dist');
const modulesRoot = join(distRoot, 'modules');
const publicAssets = ['index.html', 'style.css', 'app.js'];
const publicModules = ['api.js', 'auth.js', 'dom.js', 'main.js'];
rmSync(distRoot, { recursive: true, force: true });
mkdirSync(modulesRoot, { recursive: true });
for (const asset of publicAssets) copyFileSync(resolve(asset), join(distRoot, asset));
for (const moduleName of publicModules) {
  copyFileSync(resolve('modules', moduleName), join(modulesRoot, moduleName));
}

const output = resolve(process.env.ONEBOARD_CONFIG_OUTPUT || join(distRoot, 'config.js'));
const config = { googleClientId, apiBase };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `window.ONEBOARD_CONFIG = Object.freeze(${JSON.stringify(config, null, 2)});\n`, { mode: 0o644 });
