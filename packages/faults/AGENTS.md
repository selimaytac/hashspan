# packages/faults

A JSON-RPC fault proxy for tests (ADR 0032), on a 0.x release line of its own. Root rules:
[AGENTS.md](../../AGENTS.md).

- `src/index.ts` `startFaultProxy(upstream, { allowRemoteUpstream })`: an HTTP server on a free port of `127.0.0.1`
  that injects faults per JSON-RPC method (`hang`, `http`, `rpc-error`, `reset`, `drop`, `result`, `previous`), with
  `set(rules)`, `requests(method?)` and `stop()`. A Node.js test tool, not instrumentation: the one package whose
  `src/` imports `node:http` (type-checked with Node types), and it rejects on a refused upstream or a failed bind.
  No dependencies.
- Safety rules of ADR 0032 point 3, each with a unit test: loopback upstreams only unless `allowRemoteUpstream`,
  judged from the URL as written; only `http:` and `https:`; one upstream request per client request; redirects
  passed back, never followed. A change to them needs an ADR.
- `test/proxy.test.ts` every rule and kind against a local HTTP server as the node, in the order of ADR 0032 point 8
  (no Anvil); `test/quick-start.test.ts` runs the README's quick start (`test/readme/quick-start.ts`) as written
- The adapters' fault tests (`packages/*/test/*faults*.int.test.ts` and others) import it as `@hashspan/faults`,
  resolved from source by `vitest.config.ts`; a change of behaviour runs them too (`pnpm test:integration`)
