import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Checks that the docs agree with the repository, so they cannot drift unnoticed. docs/semconv.md is checked
// against the attribute keys in semconv-doc.test.ts.

const root = resolve(new URL('../../../', import.meta.url).pathname);
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** Text as a literal in a regular expression. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Markdown files of the repository; generated changelogs and API reports (`pnpm api:update`) and local, git-ignored
 * notes are left out.
 */
function markdownFiles(dir = ''): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', 'dist', '.git'].includes(entry.name) ? [] : markdownFiles(path);
    }
    const skip =
      entry.name === 'CHANGELOG.md' ||
      entry.name.endsWith('.api.md') ||
      entry.name.endsWith('.local.md');
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

describe('TSDoc links', () => {
  // Doc comments ship in the packages' type declarations, where a repository path is not a link: they link to the
  // docs by absolute URL, pinned to the package's release by scripts/sync-version.mjs. `//` comments are not shipped.
  for (const pkg of packages) {
    const src = `packages/${pkg.dir}/src`;
    const comments = readdirSync(join(root, src), { recursive: true })
      .map(String)
      .filter((file) => file.endsWith('.ts'))
      .flatMap((file) =>
        [...read(`${src}/${file}`).matchAll(/\/\*\*[\s\S]*?\*\//g)].map((m) => ({
          file: `${src}/${file}`,
          text: m[0],
        })),
      );
    const urls = comments.flatMap(({ file, text }) =>
      [...text.matchAll(/https:\/\/github\.com\/selimaytac\/hashspan\/[^\s)`]*[^\s).,`]/g)].map(
        (m) => ({
          file,
          url: m[0],
        }),
      ),
    );

    it(`${pkg.name} names no repository path where a link belongs`, () => {
      const paths = comments.flatMap(({ file, text }) =>
        [...text.matchAll(/(?<![/\w.-])docs\/[\w./-]+/g)].map((m) => `${file}: ${m[0]}`),
      );
      expect(
        paths,
        'write the reference as https://github.com/selimaytac/hashspan/blob/main/<path>',
      ).toEqual([]);
    });

    it(`${pkg.name} links to files of the repository, pinned to its release`, () => {
      const ref = pkg.version === '0.0.0' ? 'main' : `${pkg.name}@${pkg.version}`;
      const wrong = urls
        .map(({ file, url }) => ({ file, url, problem: brokenLink(file, url) }))
        .filter(({ url, problem }) => problem !== undefined || repoLink.exec(url)?.[1] !== ref);
      expect(
        wrong,
        'run `node scripts/sync-version.mjs` to pin the links to the release tag',
      ).toEqual([]);
    });
  }

  it('finds the links it checks', () => {
    const shipped = read('packages/viem/src/index.ts');
    expect(shipped).toMatch(/\/\*\*[^/]*https:\/\/github\.com\/selimaytac\/hashspan\/blob\//);
  });
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

  it('gives every package, example and integrations/ an AGENTS.md, each imported by a CLAUDE.md next to it', () => {
    const examples = readdirSync(join(root, 'examples')).filter((dir) =>
      existsSync(join(root, 'examples', dir, 'package.json')),
    );
    const dirs = [
      '',
      ...packages.map(({ dir }) => `packages/${dir}`),
      ...examples.map((dir) => `examples/${dir}`),
      // A workspace of its own, not a member of the root one.
      ...(existsSync(join(root, 'integrations', 'package.json')) ? ['integrations'] : []),
    ];
    const agentsFiles = markdownFiles().filter((file) => file.endsWith('AGENTS.md'));
    expect(dirs.filter((dir) => !existsSync(join(root, dir, 'AGENTS.md')))).toEqual([]);
    expect(
      agentsFiles.filter((file) => {
        const claude = join(root, dirname(file), 'CLAUDE.md');
        return !existsSync(claude) || readFileSync(claude, 'utf8') !== '@AGENTS.md\n';
      }),
    ).toEqual([]);
  });

  it('lists the same commit scopes in AGENTS.md and CONTRIBUTING.md: one per package plus the shared ones', () => {
    const expected = [...packages.map(({ dir }) => dir), 'examples', 'docs', 'ci', 'lab'].sort();
    for (const file of ['AGENTS.md', 'CONTRIBUTING.md']) {
      const list = read(file).match(/Scopes:([^.;]+)/)?.[1] ?? '';
      expect({
        file,
        scopes: [...list.matchAll(/`([a-z][a-z0-9]*)`/g)].map((m) => m[1]).sort(),
      }).toEqual({
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

describe('code examples', () => {
  // Every TypeScript or JavaScript block in the docs is the `#region readme` of a file in packages/*/test/readme/,
  // which `pnpm typecheck` compiles: an example cannot stop compiling without failing CI.
  const blocks = markdownFiles().flatMap((file) =>
    [...read(file).matchAll(/^```(ts|typescript|tsx|js|javascript|jsx)\n([\s\S]*?)^```$/gm)].map(
      (m) => ({
        file,
        code: m[2] as string,
      }),
    ),
  );
  const examples = readdirSync(join(root, 'packages')).flatMap((dir) => {
    const folder = `packages/${dir}/test/readme`;
    if (!existsSync(join(root, folder))) return [];
    return readdirSync(join(root, folder)).map((name) => {
      const source = read(`${folder}/${name}`);
      return {
        path: `${folder}/${name}`,
        readme: source.match(/^\/\/ Example from (\S+)\.$/m)?.[1],
        regions: [...source.matchAll(/^\/\/ #region readme\n([\s\S]*?)^\/\/ #endregion$/gm)].map(
          (m) => m[1] as string,
        ),
      };
    });
  });

  it('finds the examples it checks', () => {
    expect(blocks.length).toBeGreaterThan(5);
    expect(examples.length).toBeGreaterThan(5);
  });

  it('keep one region per file and name an existing README', () => {
    const malformed = examples.filter(
      ({ readme, regions }) =>
        regions.length !== 1 || readme === undefined || !existsSync(join(root, readme)),
    );
    expect(malformed.map(({ path }) => path)).toEqual([]);
  });

  it('are shown in the docs exactly as compiled', () => {
    const unchecked = blocks.filter(
      ({ file, code }) =>
        !examples.some(({ readme, regions }) => readme === file && regions[0] === code),
    );
    expect(
      unchecked.map(({ file, code }) => `${file}: ${code.split('\n')[0]}`),
      'copy the block into the matching packages/*/test/readme/ file, or add one',
    ).toEqual([]);
  });

  it('are all still shown in the docs', () => {
    const unused = examples.filter(
      ({ readme, regions }) =>
        !blocks.some(({ file, code }) => file === readme && code === regions[0]),
    );
    expect(unused.map(({ path }) => path)).toEqual([]);
  });
});

describe('package README options', () => {
  /** Own properties of an exported interface in a source file, from its top-level members. */
  const optionsOf = (file: string, name: string) => {
    const body = read(file).match(
      new RegExp(`^export interface ${name}\\b[^{]*\\{\\n([\\s\\S]*?)^\\}`, 'm'),
    )?.[1];
    return [...(body ?? '').matchAll(/^ {2}(?:readonly )?(\w+)\??:/gm)]
      .map((m) => m[1] as string)
      .sort();
  };
  /** Option names in the first column of a README's `| Option | Default | Description |` table. */
  const tableOf = (readme: string) => {
    const table = read(readme).match(
      /^\| Option \| Default \| Description \|\n\|[-|]+\|\n((?:\|.*\n)+)/m,
    )?.[1];
    return [...(table ?? '').matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1] as string).sort();
  };

  it('finds the options it checks', () => {
    expect(optionsOf('packages/core/src/types.ts', 'TxTrackerOptions').length).toBeGreaterThan(5);
    expect(tableOf('packages/core/README.md').length).toBeGreaterThan(5);
  });

  it('list every option of the core tracker, and no other', () => {
    expect(tableOf('packages/core/README.md')).toEqual(
      optionsOf('packages/core/src/types.ts', 'TxTrackerOptions'),
    );
  });

  it('list every option the viem adapter adds, and no other', () => {
    expect(tableOf('packages/viem/README.md')).toEqual(
      optionsOf('packages/viem/src/index.ts', 'WithHashspanOptions'),
    );
  });

  it('name every option the x402 adapter adds', () => {
    const readme = read('packages/x402/README.md');
    const options = optionsOf('packages/x402/src/index.ts', 'WithHashspanX402Options');
    expect(options.length).toBeGreaterThan(0);
    expect(options.filter((option) => !readme.includes(`\`${option}\``))).toEqual([]);
  });

  it('name every option the cdp adapter adds', () => {
    const readme = read('packages/cdp/README.md');
    const options = optionsOf('packages/cdp/src/index.ts', 'WithHashspanCdpOptions');
    expect(options.length).toBeGreaterThan(0);
    expect(options.filter((option) => !readme.includes(`\`${option}\``))).toEqual([]);
  });
});
