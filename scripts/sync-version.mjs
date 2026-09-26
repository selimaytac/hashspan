// Writes each package's version into its src/version.ts. Runs after `changeset version`.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../packages/', import.meta.url).pathname;
for (const name of readdirSync(root)) {
  const versionFile = join(root, name, 'src', 'version.ts');
  if (!existsSync(versionFile)) continue;
  const { version } = JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8'));
  const source = readFileSync(versionFile, 'utf8');
  const updated = source.replace(/VERSION: string = '[^']*'/, `VERSION: string = '${version}'`);
  if (updated !== source) {
    writeFileSync(versionFile, updated);
    console.log(`${name}: ${version}`);
  }
}
