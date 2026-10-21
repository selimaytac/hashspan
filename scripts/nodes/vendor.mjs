// Vendors the parts of the Ethereum execution-apis OpenRPC spec the dev-node matrix validates against, from one pinned
// commit, as data: the files of FILES under scripts/nodes/execution-apis/, byte for byte, with the spec's LICENSE
// (CC0-1.0) and a manifest that records the source, the commit and the git blob and SHA-256 of every file. Only the
// method files of the calls the flows make, the schemas they reference and the error groups are taken.
// Usage: node scripts/nodes/vendor.mjs --write   (needs the network; fetches by commit, so it rewrites the same bytes)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the spec comes from: repository, pinned commit (read 2026-10-21) and licence. */
export const SOURCE = {
  repo: 'https://github.com/ethereum/execution-apis',
  commit: '16caee274b0d4fb7a0316f294029adac88a75a09',
  license: 'CC0-1.0',
};

/** The vendored files, by their path in the execution-apis repository. */
export const FILES = [
  'LICENSE',
  'src/debug/trace.yaml',
  'src/error-groups/execution-errors.yaml',
  'src/error-groups/gas-errors.yaml',
  'src/error-groups/rpc-non-standard-errors.yaml',
  'src/error-groups/rpc-standard-errors.yaml',
  'src/error-groups/txpool-errors.yaml',
  'src/eth/block.yaml',
  'src/eth/execute.yaml',
  'src/eth/fee_market.yaml',
  'src/eth/filter.yaml',
  'src/eth/submit.yaml',
  'src/eth/transaction.yaml',
  'src/schemas/base-types.yaml',
  'src/schemas/block-access-list.yaml',
  'src/schemas/block.yaml',
  'src/schemas/execute.yaml',
  'src/schemas/filter.yaml',
  'src/schemas/opcode-tracer.yaml',
  'src/schemas/receipt.yaml',
  'src/schemas/transaction.yaml',
  'src/schemas/withdrawal.yaml',
];

/** Directory of the vendored files, relative to the repository root. */
export const VENDOR_DIR = 'scripts/nodes/execution-apis';
/** The manifest in that directory. */
export const MANIFEST = 'manifest.json';

/** The git blob id of a file's bytes, as `git hash-object` computes it. */
export const gitBlob = (bytes) =>
  createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest('hex');

/** The SHA-256 of a file's bytes, in hex. */
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The manifest of a set of fetched files (`path` to bytes). */
export function manifestOf(files) {
  return {
    source: SOURCE,
    note: 'Vendored by scripts/nodes/vendor.mjs from the commit above; do not edit, regenerate.',
    files: FILES.map((path) => ({
      path,
      gitBlob: gitBlob(files[path]),
      sha256: sha256(files[path]),
    })),
  };
}

async function write(root) {
  const api = `https://api.github.com/repos/ethereum/execution-apis/git/trees/${SOURCE.commit}?recursive=1`;
  const tree = await (await fetch(api)).json();
  const blobs = new Map((tree.tree ?? []).map((entry) => [entry.path, entry.sha]));
  const files = {};
  for (const path of FILES) {
    const url = `${SOURCE.repo.replace('https://github.com', 'https://raw.githubusercontent.com')}/${SOURCE.commit}/${path}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} for ${path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    // The bytes are the ones the commit's tree names, or nothing is written.
    if (blobs.get(path) !== gitBlob(bytes))
      throw new Error(`${path} differs from the tree of the commit`);
    files[path] = bytes;
  }
  const dir = join(root, VENDOR_DIR);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifestOf(files), null, 2)}\n`);
}

/** The vendored bytes of one file. */
export const readVendored = (root, path) => readFileSync(join(root, VENDOR_DIR, path));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--write')) {
    console.error('usage: node scripts/nodes/vendor.mjs --write');
    process.exit(1);
  }
  await write(fileURLToPath(new URL('../../', import.meta.url)));
}
