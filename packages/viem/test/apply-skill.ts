// Applies skills/hashspan/SKILL.md to a copy of a project that sends with viem and has no hashspan, as a coding agent
// following it would, and runs the result in a process of its own that exports over OTLP to a receiver here. The code
// written into the copy is taken from SKILL.md as it is, so the skill cannot drift from what the tests run; every
// literal the steps below insert is checked to be in SKILL.md. Used by examples/*/test/skill.int.test.ts.
import { type ChildProcess, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const skillText = readFileSync(join(root, 'skills/hashspan/SKILL.md'), 'utf8');

/** Fails with `message` unless `condition` holds. */
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`skills/hashspan/SKILL.md: ${message}`);
}

/** A literal the steps insert, after checking that SKILL.md shows it in inline code. */
function shown(code: string): string {
  check(skillText.includes(`\`${code}\``), `does not show \`${code}\``);
  return code;
}

/** The packages of the skill's `npm install` lines. */
export function skillPackages(): string[] {
  const block = skillText.match(/^```sh\n([\s\S]*?)^```$/m)?.[1] ?? '';
  const packages = [...block.matchAll(/^npm install ([^\n#]+)/gm)].flatMap((m) =>
    (m[1] as string).trim().split(/\s+/),
  );
  check(packages.length > 0, 'has no npm install line');
  return packages;
}

/** The skill's `instrumentation.ts`: its one `ts` block, which starts the SDK. */
function instrumentationSource(): string {
  const blocks = [...skillText.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((m) => m[1] as string);
  const sdk = blocks.filter((block) => block.includes('new NodeSDK('));
  check(sdk.length === 1, 'has one ts block that starts the SDK');
  return sdk[0] as string;
}

/** Replaces the one occurrence of `search` in `text`. */
function replaceOnce(text: string, search: string, replacement: string): string {
  const parts = text.split(search);
  check(parts.length === 2, `the instrumentation file names ${search} once`);
  return parts.join(replacement);
}

/** `source` with `.extend(hashspan)` after every viem client it creates (step 4), and the number of clients. */
function extendClients(source: string): { source: string; count: number } {
  let result = '';
  let count = 0;
  let index = 0;
  const factory = /\bcreate(?:Wallet|Public)Client\(/g;
  for (let match = factory.exec(source); match; match = factory.exec(source)) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      if (source[end] === ')' && --depth === 0) break;
    }
    result += `${source.slice(index, end + 1)}${shown('.extend(hashspan)')}`;
    index = end + 1;
    factory.lastIndex = index;
    count++;
  }
  return { source: result + source.slice(index), count };
}

/** Whether `name` is installed for a file in `directory`, as a package manager would have placed it. */
function installed(directory: string, name: string): boolean {
  for (let dir = directory; dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return true;
  }
  return false;
}

export interface ApplyOptions {
  /** The folder of the project before hashspan, copied next to itself. */
  fixture: string;
  /** Its entry point, relative to the folder. */
  entry: string;
  /** The project's name, which the skill says to give the SDK as `serviceName`. */
  serviceName: string;
  /** A script exits by itself and ends with `shutdown()`; a service is stopped with a signal (step 5). */
  kind: 'script' | 'service';
}

/** Copies the fixture and applies the skill's steps to the copy; returns the copy's entry point. */
export function applySkill({ fixture, entry, serviceName, kind }: ApplyOptions): string {
  const copy = mkdtempSync(join(dirname(fixture), 'skill-run-'));
  cpSync(fixture, copy, { recursive: true });

  // Step 2: the packages to install are those the project resolves.
  const missing = skillPackages().filter((name) => !installed(copy, name));
  check(
    missing.length === 0,
    `installs packages the project cannot resolve: ${missing.join(', ')}`,
  );

  const files = readdirSync(copy).filter((name) => name.endsWith('.ts'));
  const sources = new Map(files.map((name) => [name, readFileSync(join(copy, name), 'utf8')]));
  const waits = [...sources.values()].some((source) =>
    source.includes('waitForTransactionReceipt'),
  );

  // Step 3: the instrumentation file, named for the project, with background confirmation if nothing waits.
  let instrumentation = replaceOnce(instrumentationSource(), "'my-service'", `'${serviceName}'`);
  if (!waits) {
    const background = skillText.match(
      /`(withHashspan\(\{ confirm: \{ mode: 'background'[^`]*\))`/,
    )?.[1];
    check(background, 'names no background confirmation');
    instrumentation = replaceOnce(instrumentation, 'withHashspan()', background);
  }
  writeFileSync(join(copy, 'instrumentation.ts'), instrumentation);

  // Steps 3 to 5: extend the clients, import the instrumentation file first, end a script with shutdown().
  const first = shown("import { shutdown } from './instrumentation.js';");
  for (const [name, original] of sources) {
    const { source, count } = extendClients(original);
    const imports: string[] = [];
    if (name === entry) imports.push(first);
    if (count > 0) imports.push("import { hashspan } from './instrumentation.js';");
    const end = name === entry && kind === 'script' ? `\n${shown('await shutdown();')}\n` : '';
    writeFileSync(join(copy, name), `${imports.join('\n')}\n${source}${end}`);
  }

  // Workspace packages from their sources, as the vitest config maps them, so that no build is needed first.
  writeFileSync(
    join(copy, 'tsconfig.json'),
    JSON.stringify({
      extends: '../../tsconfig.json',
      compilerOptions: {
        paths: {
          '@hashspan/core': [join(root, 'packages/core/src/index.ts')],
          '@hashspan/viem': [join(root, 'packages/viem/src/index.ts')],
        },
      },
    }),
  );
  return join(copy, entry);
}

export interface ReceivedSpan {
  service: string | undefined;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** `2` is an error. */
  status?: { code?: number };
  /** As OTLP/JSON encodes them: an `intValue` arrives as a string. */
  attributes?: {
    key: string;
    value: { stringValue?: string; intValue?: string; boolValue?: boolean };
  }[];
  links?: { traceId: string; spanId: string }[];
}

type OtlpTraces = {
  resourceSpans: {
    resource: { attributes: { key: string; value: { stringValue?: string } }[] };
    scopeSpans: { spans: Omit<ReceivedSpan, 'service'>[] }[];
  }[];
};

/** An OTLP/HTTP JSON receiver on localhost that keeps the spans it receives. */
export async function startReceiver(): Promise<{
  endpoint: string;
  spans: ReceivedSpan[];
  close: () => Promise<void>;
}> {
  const spans: ReceivedSpan[] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      if (request.url === '/v1/traces') {
        for (const { resource, scopeSpans } of (JSON.parse(body) as OtlpTraces).resourceSpans) {
          const service = resource.attributes.find((a) => a.key === 'service.name')?.value
            .stringValue;
          for (const scope of scopeSpans) {
            for (const span of scope.spans) spans.push({ ...span, service });
          }
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    spans,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Starts the instrumented entry point with tsx, exporting to `endpoint`, with the chain at `rpcUrl`. */
export function runProject(file: string, endpoint: string, rpcUrl: string): ChildProcess {
  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  return spawn(
    process.execPath,
    [tsx, '--tsconfig', join(dirname(file), 'tsconfig.json'), basename(file)],
    {
      cwd: dirname(file),
      env: {
        ...process.env,
        RPC_URL: rpcUrl,
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        // JSON instead of the default protobuf, so that the receiver can read what arrives.
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

/** Collects a process's output until it exits. */
export function outcome(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) =>
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })),
  );
}
