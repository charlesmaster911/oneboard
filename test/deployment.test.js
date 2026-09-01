import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function renderEnvEntries() {
  const lines = readFileSync(join(projectRoot, 'render.yaml'), 'utf8').split(/\r?\n/);
  const entries = new Map();
  let currentKey;

  for (const line of lines) {
    const keyMatch = line.match(/^\s+- key:\s*(\S+)\s*$/);
    if (keyMatch) {
      currentKey = keyMatch[1];
      entries.set(currentKey, {});
      continue;
    }
    const syncMatch = line.match(/^\s+sync:\s*(true|false)\s*$/);
    if (currentKey && syncMatch) entries.get(currentKey).sync = syncMatch[1] === 'true';
    const valueMatch = line.match(/^\s+value:\s*(.*)\s*$/);
    if (currentKey && valueMatch) {
      entries.get(currentKey).value = valueMatch[1].replace(/^['"]|['"]$/g, '');
    }
  }

  return entries;
}

describe('Render public configuration boundary', () => {
  it('provisions both public runtime inputs without baking an environment-specific endpoint into source', () => {
    const entries = renderEnvEntries();

    expect(entries.get('GOOGLE_CLIENT_ID')).toEqual({ sync: false });
    expect(entries.get('ONEBOARD_API_BASE')).toEqual({ sync: false });
  });

  it('does not expose server-only credentials in the static service environment', () => {
    const keys = [...renderEnvEntries().keys()];
    const forbidden = [
      'DATABASE_URL',
      'JWT_SECRET',
      'ENCRYPTION_KEY',
      'BOOTSTRAP_OWNER_EMAIL',
      'LEGACY_SHEETS_WEBAPP_URL',
      'LEGACY_SHEETS_WEBAPP_TOKEN',
    ];

    expect(keys.filter((key) => forbidden.includes(key))).toEqual([]);
  });

  it('allows exactly the three public build environment keys with production mode fixed', () => {
    const entries = renderEnvEntries();

    expect([...entries.keys()].sort()).toEqual([
      'GOOGLE_CLIENT_ID',
      'NODE_ENV',
      'ONEBOARD_API_BASE',
    ]);
    expect(entries.get('NODE_ENV')).toEqual({ value: 'production' });
  });

  it('publishes a generated allowlisted directory instead of the repository root', () => {
    const render = readFileSync(join(projectRoot, 'render.yaml'), 'utf8');
    const build = readFileSync(join(projectRoot, 'scripts', 'build-config.js'), 'utf8');

    expect(render).toMatch(/staticPublishPath:\s*dist/);
    expect(build).toContain("const publicAssets = ['index.html', 'style.css', 'app.js'];");
    expect(build).toContain("const publicModules = ['api.js', 'auth.js', 'dom.js', 'main.js'];");
    expect(build).not.toMatch(/manuals|oneboard-backup-guide/);
  });
});
