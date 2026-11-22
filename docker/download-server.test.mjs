import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadServer } from './download-server.mjs';

const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const vanillaBytes = Buffer.from('vanilla jar bytes');
const paperBytes = Buffer.from('paper jar bytes');
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const pin = (bytes = paperBytes) => ({
  minecraft: { version: '1.21.4', paper: { build: 232, url: 'https://fill-data.example/paper.jar', sha256: hash('sha256', bytes), bytes: bytes.length } },
});

/** A fetch that serves Mojang's two metadata documents, the vanilla jar and the Paper jar; `requests` lists every URL asked. */
function fakeFetch({ vanilla = vanillaBytes, paper = paperBytes } = {}) {
  const requests = [];
  const json = body => new Response(JSON.stringify(body));
  const answers = {
    [manifestUrl]: () => json({ versions: [{ id: '1.21.4', url: 'https://meta.example/1.21.4.json' }] }),
    'https://meta.example/1.21.4.json': () => json({ downloads: { server: { url: 'https://data.example/server.jar', sha1: hash('sha1', vanillaBytes), size: vanillaBytes.length } } }),
    'https://data.example/server.jar': () => new Response(vanilla),
    'https://fill-data.example/paper.jar': () => new Response(paper),
  };
  const fetchImpl = async url => { requests.push(url); const answer = answers[url]; return answer ? answer() : new Response('', { status: 404 }); };
  return { fetchImpl, requests };
}

async function outDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mine-ai-download-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Plan tests: "paper writes the pinned jar after its sha256", "paper writes the mojang jar beside it" and
// "server-source.json names program and build" are one download with three asserts.
test('paper writes the pinned jar after its sha256, the mojang jar beside it, and server-source.json naming program and build', async (t) => {
  const out = await outDir(t);
  const { fetchImpl } = fakeFetch();
  await downloadServer({ version: '1.21.4', program: 'paper', outDir: out, fetchImpl, manifest: pin() });
  assert.deepEqual(await readFile(join(out, 'server.jar')), paperBytes);
  assert.deepEqual(await readFile(join(out, 'mojang_1.21.4.jar')), vanillaBytes);
  const sourceText = await readFile(join(out, 'server-source.json'), 'utf8');
  // entrypoint's minecraft-folder.sh greps this exact form to learn the program.
  assert.match(sourceText, /"program": "paper"/);
  const source = JSON.parse(sourceText);
  assert.equal(source.version, '1.21.4');
  assert.equal(source.build, 232);
  assert.equal(source.sha256, hash('sha256', paperBytes));
});

const refusals = [
  ['a paper hash mismatch writes nothing', { paper: Buffer.from('another jar of the same length') }, { version: '1.21.4', program: 'paper' }, /Paper server checksum mismatch/],
  ['a vanilla hash mismatch with paper writes nothing', { vanilla: Buffer.from('a damaged vanilla jar') }, { version: '1.21.4', program: 'paper' }, /Minecraft server checksum mismatch/],
  ['paper refuses a version other than the pinned one before any request', {}, { version: '1.21.5', program: 'paper' }, /Paper is pinned to Minecraft 1\.21\.4/],
  ['an unknown program is refused before any request', {}, { version: '1.21.4', program: 'spigot' }, /program must be vanilla or paper/],
];
for (const [name, jars, args, message] of refusals) {
  test(name, async (t) => {
    const out = await outDir(t);
    const { fetchImpl, requests } = fakeFetch(jars);
    await assert.rejects(downloadServer({ ...args, outDir: out, fetchImpl, manifest: pin() }), message);
    assert.deepEqual(await readdir(out), []);
    if (!('paper' in jars) && !('vanilla' in jars)) assert.deepEqual(requests, []);
  });
}

test('vanilla unchanged', async (t) => {
  const out = await outDir(t);
  const { fetchImpl } = fakeFetch();
  await downloadServer({ version: '1.21.4', program: 'vanilla', outDir: out, fetchImpl, manifest: pin() });
  assert.deepEqual(await readFile(join(out, 'server.jar')), vanillaBytes);
  assert.deepEqual((await readdir(out)).sort(), ['server-source.json', 'server.jar']);
  const source = JSON.parse(await readFile(join(out, 'server-source.json'), 'utf8'));
  assert.deepEqual(source, { program: 'vanilla', version: '1.21.4', url: 'https://data.example/server.jar', sha1: hash('sha1', vanillaBytes), size: vanillaBytes.length });
});
