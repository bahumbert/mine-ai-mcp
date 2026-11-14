// `bun docker/download-server.mjs <version> <vanilla|paper> [<out dir>]` (out dir default /opt).
// vanilla: Mojang's server jar -> <out>/server.jar. paper: the pinned Paper build of packaging/manifest.json
// (`minecraft.paper`, sha256 checked) -> <out>/server.jar and Mojang's jar -> <out>/mojang_<version>.jar, which the
// entrypoint copies into the server folder's cache so Paperclip downloads nothing. Every jar is checked before any
// file is written. <out>/server-source.json names the program and what was downloaded.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');

async function get(fetchImpl, url) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

async function downloadMojangServer(fetchImpl, version) {
  const manifest = await (await get(fetchImpl, 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json();
  const entry = manifest.versions.find(item => item.id === version);
  if (!entry) throw new Error(`Unknown Minecraft version: ${version}`);
  const metadata = await (await get(fetchImpl, entry.url)).json();
  const server = metadata.downloads.server;
  const bytes = Buffer.from(await (await get(fetchImpl, server.url)).arrayBuffer());
  if (digest('sha1', bytes) !== server.sha1) throw new Error('Minecraft server checksum mismatch');
  return { bytes, server };
}

async function downloadPaperServer(fetchImpl, pin) {
  const bytes = Buffer.from(await (await get(fetchImpl, pin.url)).arrayBuffer());
  if (digest('sha256', bytes) !== pin.sha256 || bytes.length !== pin.bytes) throw new Error('Paper server checksum mismatch');
  return bytes;
}

/** Downloads the server of `program` for `version` into `outDir`; `manifest` is packaging/manifest.json. Nothing is written when any check fails. */
export async function downloadServer({ version, program, outDir = '/opt', fetchImpl = globalThis.fetch, manifest }) {
  if (program !== 'vanilla' && program !== 'paper') throw new Error(`The server program must be vanilla or paper, not ${program}`);
  if (program === 'vanilla') {
    const { bytes, server } = await downloadMojangServer(fetchImpl, version);
    await writeFile(join(outDir, 'server.jar'), bytes);
    await writeFile(join(outDir, 'server-source.json'), JSON.stringify({ program, version, ...server }, null, 2));
    return;
  }
  const pin = manifest.minecraft.paper;
  if (version !== manifest.minecraft.version) throw new Error(`Paper is pinned to Minecraft ${manifest.minecraft.version} (build ${pin.build}), not ${version}`);
  const paper = await downloadPaperServer(fetchImpl, pin);
  const { bytes: mojang, server } = await downloadMojangServer(fetchImpl, version);
  await writeFile(join(outDir, 'server.jar'), paper);
  await writeFile(join(outDir, `mojang_${version}.jar`), mojang);
  await writeFile(join(outDir, 'server-source.json'), JSON.stringify({
    program, version, build: pin.build, url: pin.url, sha256: pin.sha256, size: pin.bytes, mojang: server,
  }, null, 2));
}

if (import.meta.main) {
  const [version, program, outDir] = process.argv.slice(2);
  if (!version || !program) throw new Error('usage: bun docker/download-server.mjs <version> <vanilla|paper> [<out dir>]');
  const manifest = JSON.parse(await readFile(new URL('../packaging/manifest.json', import.meta.url), 'utf8'));
  await downloadServer({ version, program, outDir, manifest });
}
