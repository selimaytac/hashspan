# 0032. A JSON-RPC fault proxy as a published package

- Status: proposed
- Date: 2026-10-21

## Context

hashspan's integration tests put an HTTP proxy between a viem client and Anvil and make chosen JSON-RPC methods
fail: `packages/viem/test/fault-proxy.ts`. The `rpc-faults` tests of viem, cdp, x402 and mpp, the cdp smart account
and x402 settlement tests and the viem user operation and call batch tests import it, together with the span checks
of `packages/viem/test/fault-checks.ts`. The hashspan lab keeps a smaller copy of the proxy for its `faults`
scenario, which runs against a local Anvil. Two copies drift, and neither can be used outside these repositories.

The same proxy is useful to anyone who tests an EVM client library, a node, a bundler or a facilitator: a real HTTP
server exercises the client's own transport, retry and backoff, which a mocked transport does not. Testing other
projects this way, finding their bugs and fixing them upstream is a line of work hashspan already does by hand; the
findings so far, such as viem's concurrent waits and replacement detection and Anvil's nonce for concurrent sends,
are in [upstream-findings.md](../upstream-findings.md). A published fault proxy is the first tool of that line.

**Today's proxy** (`startFaultProxy(upstream)`) listens on a free port of `127.0.0.1` and applies rules per JSON-RPC
method. `set(rules)` replaces every rule and restarts the counts; a rule has a fault, `after` (requests passed on
before it applies) and `times`. Six kinds:

- `hang`: never answers;
- `http`: an HTTP status without a JSON-RPC body, such as 429;
- `rpc-error`: a JSON-RPC error with a code and an optional message;
- `reset`: the headers and part of the body, then a connection reset;
- `result`: the node's result replaced by a function of it and of the call count;
- `previous`: the result of this method's previous request, as a load balancer that mixes up answers.

Batches (JSON arrays) and bodies that are not JSON are passed on untouched. `requests(method)` counts one method
since the last `set()`. A failure while handling a request answers 502.

**The lab's copy** is a subset of it:

| | hashspan tests | lab |
|---|---|---|
| HTTP status | `http` | `status` |
| Connection reset | `reset`: headers and part of the body, then a reset | `reset`: the socket is destroyed before any byte |
| `hang`, `rpc-error`, `result`, `previous` | yes | no |
| Rules | `set(rules)` replaces all rules; `after` and `times` | `fail(method, fault, times)` adds one; `clear()` removes all |
| Counts | `requests(method)`, since the last `set()` | `requests()`, every method, since the start |
| A failure while handling | answers 502 | destroys the socket |
| Listen error | not handled | rejects |
| `stop()` | destroys the sockets it tracked | `closeAllConnections()` |

The lab reads counts as differences around one call, so where they start does not matter to it; it needs every
method's count at once, and the two resets as two kinds.

Constraints of the repository:

- `src/` must not use Node.js-only APIs at import time and is type-checked without Node types
  ([AGENTS.md](../../AGENTS.md#conventions)). A proxy is an HTTP server and needs `node:http`.
- `packages/core/test/docs.test.ts` treats every directory of `packages/` with a `package.json` as a package: it
  needs a row in the README's package table, a line in AGENTS.md, an `AGENTS.md` with a `CLAUDE.md`, a commit
  scope in AGENTS.md and CONTRIBUTING.md, and the shared `engines.node`.
- core, viem, cdp, x402 and the examples are a linked changesets group; `@hashspan/mpp` is outside it, on a 0.x line
  of its own ([releasing.md](../releasing.md#versions), [ADR 0029](0029-mpp-payments.md)).
- A new npm name needs a placeholder and a trusted publisher before its first release
  ([releasing.md](../releasing.md#one-time-setup)).

## Decision

**1. Placement: `packages/faults`, a Node.js package, with the exception stated in AGENTS.md.**

Options considered:

- *A subpath of an adapter, such as `@hashspan/viem/faults`*: no new name, but it puts `node:http` into a package
  that runs in browsers and edge runtimes, and ties the tool to viem, which it does not use.
- *A directory outside `packages/`, such as `tools/faults`*: the rule needs no exception, but the workspace glob,
  the docs checks, the API reports, publint, the smoke test and coverage all enumerate `packages/*`, so each would
  need a second list.
- *A Node-free core with the server injected*: keeps the rule, but adds an abstraction for one runtime nobody asked
  for.
- *`packages/faults`, type-checked with Node types* (chosen): every existing check covers it as it covers the other
  packages.

`packages/faults/tsconfig.json` sets `"types": ["node"]`; `tsconfig.test.json` is as in the other packages. The
AGENTS.md rule becomes: `src/` must not use Node.js-only APIs at import time, except in `packages/faults`, a Node.js
test tool that imports `node:http`. The package README says it runs on Node.js only. It is not instrumentation: the
rule that instrumentation never throws into the user's call does not apply, and `startFaultProxy()` rejects on a
refused upstream or a port it cannot bind.

**2. Versioning: its own 0.x line, outside the linked group.** Like `@hashspan/mpp`, it is not listed in
`linked` in `.changeset/config.json`, starts at 0.1.0 and stays 0.x while its fault model settles. It depends on no
other hashspan package, so a core release never moves it and it never moves the others.

**3. Safety, enforced in code.** The tool must not become a way to hit someone else's endpoint.

- It listens on `127.0.0.1` only, on a free port. There is no host option.
- `startFaultProxy(upstream, options)` refuses an upstream that is not loopback unless
  `allowRemoteUpstream: true` is passed. Loopback is decided from the URL as written, without DNS resolution, so
  name tricks cannot pass the check: an IPv4 address in `127.0.0.0/8`, `[::1]` or `localhost`. Any other host,
  including a compose service name such as `anvil`, needs the opt-in. Only `http:` and `https:` upstreams are
  accepted.
- It sends at most one upstream request per client request: no retries, no fan-out, no repetition, no rate or
  concurrency settings. Load generation is out of scope, with or without the opt-in.
- Each rule has a unit test, written before the code (point 8).

**4. Fault model: today's kinds, the lab's needs, a short list for later.**

Version 1 has the six kinds of today, unchanged in name and meaning, so the existing tests move without edits to
their rules: `hang`, `http`, `rpc-error`, `reset`, `result`, `previous`. The lab's `status` maps to `http`. The
lab's reset, which destroys the socket before any byte, is a different fault from ours, which sends part of a body:
it gets its own kind, `drop`, named now and added first after version 1 (below), and `reset` keeps its meaning.

`requests()` without an argument returns every method's count as a record, and `requests(method)` stays.

Deferred, in this order:

1. `drop`, and `latency` (a delay before the node's answer is passed on);
2. faults on single requests of a JSON-RPC batch; until then a batch is passed on untouched;
3. a scenario file format, with named result built-ins (a receipt that stays `null`, a preconfirmed receipt that is
   later sealed with other values, a chain id that changes) in place of closures;
4. an optional log of injected faults, as spans or JSON lines;
5. a CLI that reads a scenario file, for compose setups and clients not written in TypeScript.

Out of scope: faults a real node can produce. Reorgs, dropped and replaced transactions come from the node (Anvil's
`anvil_reorg`, `anvil_dropTransaction`, a replacement sent with the same nonce) in the lab and in differential
tests. The proxy fakes only what a node cannot be made to do, such as a preconfirmed receipt that later changes;
`result` with the call count covers that in version 1.

**5. API surface: a library, no runtime dependencies.** The package exports `startFaultProxy()` and the types
`Fault`, `FaultRule`, `FaultProxy` and `FaultProxyOptions`. The `FaultProxy` it returns has `url`, `set(rules)`,
`requests(method?)` and `stop()`. No CLI in version 1: `result` takes a function, which a file cannot hold, so a
file format waits for named built-ins (point 4). No dependencies and no peer dependencies: it uses `node:http`,
`node:net` and the global `fetch`.

The span checks of `fault-checks.ts` stay test helpers in `packages/viem/test/`: they import vitest and the
OpenTelemetry SDK and check hashspan's own span endings, which a user of the proxy does not need.

**6. Migration.**

- hashspan: the test files import `@hashspan/faults`, resolved from source by an alias in `vitest.config.ts` as the
  other packages are, and `packages/viem/test/fault-proxy.ts` is removed. `fault-checks.ts` imports the types
  from the package. Each adapter that uses it gets it as a `workspace:*` dev dependency.
- The lab: one change replaces its copy with the published package, pinned to an exact version as its other
  hashspan dependencies are: `fail(method, fault, times)` becomes `set({ [method]: { fault, times } })`, `clear()`
  becomes `set({})`, and `{ kind: 'status', status }` becomes `{ kind: 'http', status }`. Its upstream is a local
  Anvil on `127.0.0.1`, so the loopback check does not affect it. Its `faults` scenario is run again after the change.

**7. Repository work of the implementation.** Adding `packages/faults/package.json` makes these checks fail until
each is done, so the first implementation change does all of them:

- commit scope `faults` in AGENTS.md and CONTRIBUTING.md;
- a row in the README's package table, with the status "in the next release" while the version is 0.0.0;
- a `` - `packages/faults` → `` line in AGENTS.md, `packages/faults/AGENTS.md` and a `CLAUDE.md` that only imports it;
- the AGENTS.md exception of point 1;
- `engines.node` `>=22.3.0`, the shared minimum;
- README and TSDoc links by absolute URL on the release tag, and every `ts` block of the README as a region of a file
  in `packages/faults/test/readme/`;
- the API Extractor report `packages/faults/etc/faults.api.md`, publint and arethetypeswrong;
- `faults` in the package list of `scripts/smoke-packages.mjs`, with a check of its own (start the proxy in front
  of a small local server, pass one request on, inject one `rpc-error`), since the existing checks are about spans;
- `docs/releasing.md`: the package is outside the linked group, as `@hashspan/mpp`;
- a changeset for 0.1.0.

`scripts/publish-in-order.mjs` and `scripts/check-published.mjs` read the packages from the changesets plan and the
release output, so they need no change. Before the release that publishes it, the maintainer runs steps 1, 3 and 4 of
the [one-time setup](../releasing.md#one-time-setup) for `@hashspan/faults`: the placeholder publish, the trusted
publisher and the token lockdown.

**8. Tests first.** Unit tests, against a small local HTTP server as the node, in this order:

1. the upstream check: `127.0.0.1`, another address of `127.0.0.0/8`, `[::1]` and `localhost` are accepted; a
   public address, a private address, a hostname and a non-HTTP URL are refused; `allowRemoteUpstream: true`
   accepts a hostname;
2. the proxy listens on `127.0.0.1` only;
3. exactly one upstream request per client request, for every kind that calls the node;
4. each kind of point 4, with `after` and `times`, and the first matching rule of several;
5. `requests()` with and without a method, and both restarting on `set()`;
6. a node answer that is not JSON under `result` or `previous` is answered with 502, and the proxy keeps serving;
7. `stop()` closes hanging connections; a port that cannot be bound rejects.

The existing integration tests then run on the package unchanged, which checks the migration.

## Consequences

- One fault proxy for hashspan's tests, the lab and anyone testing an EVM client, node, bundler or facilitator.
- `packages/faults` is the one package whose `src/` may use Node.js APIs; the exception is stated once, in
  AGENTS.md.
- A new 0.x release line to maintain, and a new npm name that needs the maintainer's one-time setup.
- A remote upstream needs a deliberate opt-in, and the tool has no load features even then.
- Batch faults, latency, a scenario file and a CLI come in later minor releases of the 0.x line, each with its own
  tests; reorgs and replacements stay with the node.
