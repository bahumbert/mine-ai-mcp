import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = file => readFileSync(join(root, file), 'utf8');

// What the entrypoint and download-server.mjs read inside the image (spec 2026-11-14 D9): the .dockerignore is an allow-list.
const pathsTheImageReads = [
  'packaging/manifest.json',
  'packaging/paper-settings.json',
  'launcher/src/install/paper-settings.ts',
  'launcher/src/install/paper-settings-cli.ts',
];

test('the build context allows the files the Paper image reads', () => {
  const allowed = read('.dockerignore').split('\n').filter(line => line.startsWith('!')).map(line => line.slice(1));
  for (const path of pathsTheImageReads) {
    assert.ok(existsSync(join(root, path)), `${path} does not exist`);
    assert.ok(allowed.includes(path), `.dockerignore does not allow ${path}`);
  }
});

// `bun install --frozen-lockfile` in the image applies every patch package.json names, so each patch file must reach the build context.
test('the build context allows every patch file of package.json', () => {
  const allowed = read('.dockerignore').split('\n').filter(line => line.startsWith('!')).map(line => line.slice(1));
  const patches = Object.values(JSON.parse(read('package.json')).patchedDependencies ?? {});
  assert.ok(patches.length > 0, 'package.json names no patch file');
  for (const path of patches) {
    assert.ok(existsSync(join(root, path)), `${path} does not exist`);
    assert.ok(allowed.some(entry => path === entry || (entry.endsWith('/') && path.startsWith(entry))), `.dockerignore does not allow ${path}`);
  }
});

test('both Dockerfiles pass MINECRAFT_SERVER (default paper) to the download', () => {
  for (const file of ['Dockerfile', 'Dockerfile.beatthegame']) {
    const text = read(file);
    assert.match(text, /^ARG MINECRAFT_SERVER=paper$/m, `${file} lacks ARG MINECRAFT_SERVER=paper`);
    assert.match(text, /bun docker\/download-server\.mjs \$\{MINECRAFT_VERSION\} \$\{MINECRAFT_SERVER\}$/m, `${file} does not pass the program`);
  }
});

test('the entrypoint refuses before docker/prepare.mjs, prepares the folder, then launches through minecraft-folder.sh', () => {
  const text = read('docker/entrypoint.sh');
  const at = pattern => text.search(pattern);
  const steps = [/^source \/opt\/mine-ai-mcp\/docker\/minecraft-folder\.sh$/m, /^refuse_vanilla_on_paper_world \|\| exit 1$/m,
    /^launch=\$\(bun docker\/prepare\.mjs\)$/m, /^prepare_minecraft_folder \|\| exit 1$/m, /^launch_minecraft$/m];
  for (const step of steps) assert.ok(at(step) >= 0, `entrypoint.sh lacks ${step}`);
  assert.deepEqual(steps.map(at), steps.map(at).sort((a, b) => a - b), 'entrypoint.sh runs these steps out of order');
  assert.doesNotMatch(text, /^java /m);
});
