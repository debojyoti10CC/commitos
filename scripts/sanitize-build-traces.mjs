import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const buildDirectory = path.resolve(process.cwd(), '.next');
const forbiddenRuntimeAsset = (entry) => {
  const segments = entry.replaceAll('\\', '/').split('/');
  return segments.some(segment => segment === '.data' || segment === '.demo-data' || segment === '.voice' || segment.startsWith('.env'));
};
async function traceFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await traceFiles(filename));
    else if (entry.name.endsWith('.nft.json')) result.push(filename);
  }
  return result;
}
const manifests = await traceFiles(buildDirectory);
let removed = 0;
for (const filename of manifests) {
  const trace = JSON.parse(await readFile(filename, 'utf8'));
  if (!Array.isArray(trace.files) || !trace.files.every(entry => typeof entry === 'string')) {
    throw new Error(`Invalid deployment trace: ${path.relative(buildDirectory, filename)}`);
  }
  const prohibited = trace.files.map(forbiddenRuntimeAsset);
  const count = prohibited.filter(Boolean).length;
  if (!count) continue;
  // Next's route exclusions currently omit Turbopack's root Proxy entry.
  // Remove exactly the same private runtime assets, leaving all code dependencies intact.
  if (!['middleware.js.nft.json', 'proxy.js.nft.json'].includes(path.basename(filename))) {
    throw new Error(`Private runtime data appeared in deployment trace: ${path.relative(buildDirectory, filename)}`);
  }
  if (trace.fileHashes !== undefined) {
    if (!Array.isArray(trace.fileHashes) || trace.fileHashes.length !== trace.files.length) {
      throw new Error('Proxy deployment trace has inconsistent file hashes');
    }
    trace.fileHashes = trace.fileHashes.filter((_, index) => !prohibited[index]);
  }
  trace.files = trace.files.filter((_, index) => !prohibited[index]);
  await writeFile(filename, JSON.stringify(trace));
  removed += count;
}
// Every manifest must pass, including route entries already handled by next.config.ts.
for (const filename of manifests) {
  const trace = JSON.parse(await readFile(filename, 'utf8'));
  if (trace.files.some(forbiddenRuntimeAsset)) throw new Error('Private runtime records must not be deployment assets');
}
console.info(`Verified ${manifests.length} deployment traces; excluded ${removed} private runtime assets from Proxy.`);
