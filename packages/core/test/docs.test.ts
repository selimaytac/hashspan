import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Checks that the docs agree with the repository, so they cannot drift unnoticed. docs/semconv.md is checked
// against the attribute keys in semconv-doc.test.ts.

const root = resolve(new URL('../../../', import.meta.url).pathname);
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** Text as a literal in a regular expression. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Markdown files of the repository; generated changelogs and local, git-ignored notes are left out. */
function markdownFiles(dir = ''): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', 'dist', '.git'].includes(entry.name) ? [] : markdownFiles(path);
    }
    const skip = entry.name === 'CHANGELOG.md' || entry.name.endsWith('.local.md');
    return entry.name.endsWith('.md') && !skip ? [path] : [];
  });
}

/** Markdown without fenced code blocks and inline code, where link syntax is not a link. */
const prose = (markdown: string) =>
  markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '');

/** Link targets in a markdown file, including images. */
const linkTargets = (markdown: string) =>
  [...prose(markdown).matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)].map((m) => m[1] as string);

/** Heading anchors as GitHub generates them, including the `-1` suffix of repeated headings. */
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  for (const [, heading] of prose(markdown.replace(/`([^`\n]*)`/g, '$1')).matchAll(
    /^#{1,6}\s+(.+?)\s*#*$/gm,
  )) {
    const slug = (heading as string)
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    result.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return result;
}

// A link to a file of this repository, on `main` or on a release tag.
const repoLink =
  /^https:\/\/github\.com\/selimaytac\/hashspan\/(?:blob|tree)\/(main|@hashspan\/[a-z0-9-]+@[^/]+)\/([^#?]*)(#.*)?$/;

/** Why a link target does not resolve in the working tree, or undefined if it does. */
function brokenLink(from: string, target: string): string | undefined {
  let path: string;
  let anchor: string | undefined;
  const repo = repoLink.exec(target);
  if (repo) {
    path = decodeURIComponent(repo[2] as string);
    anchor = repo[3]?.slice(1);
  } else if (/^[a-z]+:/i.test(target)) {
    return undefined; // Another site; not checked, since tests never depend on a public network.
  } else {
    const [file, hash] = target.split('#') as [string, string | undefined];
    path = file === '' ? from : join(dirname(from), decodeURIComponent(file));
    anchor = hash;
  }
  const absolute = join(root, path);
  if (!existsSync(absolute)) return 'no such file';
  if (anchor === undefined || anchor === '') return undefined;
  const page = statSync(absolute).isDirectory() ? join(absolute, 'README.md') : absolute;
  if (!page.endsWith('.md')) return undefined; // Line anchors of source files are not checked.
  if (!existsSync(page)) return 'anchor on a directory without README.md';
  return anchors(readFileSync(page, 'utf8')).has(anchor) ? undefined : `no heading for #${anchor}`;
}

const packages = readdirSync(join(root, 'packages'))
  .filter((dir) => existsSync(join(root, 'packages', dir, 'package.json')))
  .map((dir) => {
    const manifest = JSON.parse(read(`packages/${dir}/package.json`));
    return {
      dir,
      name: manifest.name as string,
      version: manifest.version as string,
      engines: manifest.engines,
    };
  });

describe('markdown links', () => {
  const files = markdownFiles();
  const links = files.flatMap((file) =>
    linkTargets(read(file)).map((target) => ({ file, target })),
  );

  it('finds the links it checks', () => {
    // Guards the extraction itself: a pattern that matches nothing would pass every other test.
    expect(files).toContain('README.md');
    expect(links.length).toBeGreaterThan(100);
    expect(links.filter((link) => repoLink.test(link.target)).length).toBeGreaterThan(5);
  });

  it('resolve to files and headings in the repository', () => {
    const broken = links
      .map((link) => ({ ...link, problem: brokenLink(link.file, link.target) }))
      .filter((link) => link.problem !== undefined);
    expect(broken).toEqual([]);
  });

  it('generate GitHub anchors for headings with code and repeated headings', () => {
    expect([...anchors('# `watch()` and `flush()`\n## Notes\n## Notes')]).toEqual([
      'watch-and-flush',
      'notes',
      'notes-1',
    ]);
    expect(linkTargets('[a](x.md) `[b](y.md)`\n```\n[c](z.md)\n```')).toEqual(['x.md']);
  });
});

describe('package READMEs', () => {
  for (const pkg of packages) {
    // Published to npm without the rest of the repository: relative links would not resolve there.
    it(`${pkg.name} links to the repository only by absolute URL, pinned to its release`, () => {
      const targets = linkTargets(read(`packages/${pkg.dir}/README.md`));
      expect(targets.filter((target) => !/^(https?:|mailto:|#)/.test(target))).toEqual([]);
      const fix = 'run `node scripts/sync-version.mjs` to pin the links to the release tag';
      const unpinnable = targets.filter(
        (target) =>
          /^https:\/\/github\.com\/selimaytac\/hashspan\/(blob|tree)\//.test(target) &&
          !repoLink.test(target),
      );
      expect(unpinnable, 'repository links must be on `main` or a release tag').toEqual([]);
      // scripts/sync-version.mjs rewrites the ref when the version changes.
      const ref = pkg.version === '0.0.0' ? 'main' : `${pkg.name}@${pkg.version}`;
      const refs = targets.flatMap((target) => repoLink.exec(target)?.[1] ?? []);
      expect(
        refs.filter((r) => r !== ref),
        fix,
      ).toEqual([]);
    });
  }
});

describe('docs/adr/README.md', () => {
  const index = read('docs/adr/README.md');
  const rows = [
    ...index.matchAll(
      /^\| \[(.+?)\]\((\d{4}-[a-z0-9-]+\.md)\) \| ([a-z ]+?|superseded by \d{4}) \|/gm,
    ),
  ];

  it('lists every ADR once, in order', () => {
    const files = readdirSync(join(root, 'docs/adr'))
      .filter((file) => /^\d{4}-.+\.md$/.test(file) && !file.startsWith('0000-'))
      .sort();
    expect(rows.map((row) => row[2])).toEqual(files);
  });

  it('matches the title and status of each ADR', () => {
    for (const [, title, file, status] of rows) {
      const adr = read(`docs/adr/${file}`);
      expect({
        file,
        title: adr.match(/^# (.+)$/m)?.[1],
        status: adr.match(/^- Status: (.+)$/m)?.[1],
      }).toEqual({
        file,
        title,
        status,
      });
    }
  });
});

describe('repository docs', () => {
  it('README.md links every package in its package table', () => {
    const rows = [
      ...read('README.md').matchAll(
        /^\| \[`(@hashspan\/[a-z0-9-]+)`\]\(packages\/([a-z0-9-]+)\) \|/gm,
      ),
    ];
    const listed = rows.map(([, name, dir]) => `${name} packages/${dir}`).sort();
    expect(listed).toEqual(packages.map(({ name, dir }) => `${name} packages/${dir}`).sort());
  });

  it('README.md gives each package the status scripts/sync-version.mjs writes', () => {
    const table = read('README.md');
    for (const { name, dir, version } of packages) {
      const status =
        version === '0.0.0'
          ? 'in the next release'
          : `[![npm](https://img.shields.io/npm/v/${name}?label=)](https://www.npmjs.com/package/${name})`;
      expect(table, 'run `node scripts/sync-version.mjs`').toMatch(
        new RegExp(
          `^\\| \\[\`${name}\`\\]\\(packages/${dir}\\) \\| [^|\\n]+ \\| ${literal(status)} \\|$`,
          'm',
        ),
      );
    }
  });

  it('AGENTS.md describes every package', () => {
    const agents = read('AGENTS.md');
    expect(packages.filter(({ dir }) => !agents.includes(`- \`packages/${dir}\` →`))).toEqual([]);
  });

  it('lists the same commit scopes in AGENTS.md and CONTRIBUTING.md: one per package plus the shared ones', () => {
    const expected = [...packages.map(({ dir }) => dir), 'examples', 'docs', 'ci', 'lab'].sort();
    for (const file of ['AGENTS.md', 'CONTRIBUTING.md']) {
      const list = read(file).match(/Scopes:([^.;]+)/)?.[1] ?? '';
      expect({ file, scopes: [...list.matchAll(/`([a-z]+)`/g)].map((m) => m[1]).sort() }).toEqual({
        file,
        scopes: expected,
      });
    }
  });

  it('states the Node.js versions of package.json', () => {
    const minimum = (range: string) => range.match(/^>=(\d+\.\d+)\.0$/)?.[1];
    const published = new Set(packages.map((pkg) => minimum(pkg.engines.node)));
    const development = minimum(JSON.parse(read('package.json')).engines.node);
    expect(published.size).toBe(1);
    const [runtime] = published;
    const stated = markdownFiles().flatMap((file) =>
      [...read(file).matchAll(/Node\.js (\d+\.\d+)\s+or later/g)].map((m) => ({
        file,
        version: m[1],
      })),
    );
    expect(stated.length).toBeGreaterThan(0);
    const allowed = [runtime, development];
    expect(stated.filter(({ version }) => !allowed.includes(version))).toEqual([]);
    expect(read('CONTRIBUTING.md')).toContain(`development needs Node.js ${development}`);
  });
});
