// Runs after `changeset version`. For each package it writes the version into src/version.ts, pins the repository
// links in its README.md and in its source comments to the git tag of that version, so the README on npm and the
// TSDoc in its type declarations link to the docs of the release they came with, and updates the package's status
// in the package table of the root README.md.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = new URL('../', import.meta.url).pathname;
// A link to this repository on `main` or on a release tag, up to the path inside the repository.
const repoLink =
  /https:\/\/github\.com\/selimaytac\/hashspan\/(blob|tree)\/(?:main|@hashspan\/[a-z0-9-]+@[^/]+)\//g;

for (const dir of readdirSync(join(repo, 'packages'))) {
  const manifest = join(repo, 'packages', dir, 'package.json');
  if (!existsSync(manifest)) continue;
  const { name, version } = JSON.parse(readFileSync(manifest, 'utf8'));
  // Never released: there is no tag to link to yet.
  const released = version !== '0.0.0';
  const ref = released ? `${name}@${version}` : 'main';
  const pin = (source) =>
    source.replace(repoLink, (_, kind) => `https://github.com/selimaytac/hashspan/${kind}/${ref}/`);
  update(join('packages', dir, 'README.md'), pin);
  const src = join(repo, 'packages', dir, 'src');
  if (existsSync(src)) {
    for (const file of readdirSync(src, { recursive: true })) {
      if (String(file).endsWith('.ts')) update(join('packages', dir, 'src', String(file)), pin);
    }
  }
  update(join('packages', dir, 'src', 'version.ts'), (source) =>
    source.replace(/VERSION: string = '[^']*'/, `VERSION: string = '${version}'`),
  );
  const status = released
    ? `[![npm](https://img.shields.io/npm/v/${name}?label=)](https://www.npmjs.com/package/${name})`
    : 'in the next release';
  update('README.md', (source) =>
    source.replace(
      new RegExp(`^(\\| \\[\`${name}\`\\]\\(packages/${dir}\\) \\| [^|\\n]+ \\| ).*( \\|)$`, 'm'),
      (_, row, end) => `${row}${status}${end}`,
    ),
  );
}

function update(file, rewrite) {
  const path = join(repo, file);
  if (!existsSync(path)) return;
  const source = readFileSync(path, 'utf8');
  const updated = rewrite(source);
  if (updated !== source) {
    writeFileSync(path, updated);
    console.log(`${file} updated`);
  }
}
