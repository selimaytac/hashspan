# packages/faults

A JSON-RPC fault proxy for tests (ADR 0032), on a 0.x release line of its own. Root rules:
[AGENTS.md](../../AGENTS.md).

- `src/index.ts` `startFaultProxy(upstream, { allowRemoteUpstream })`: an HTTP server on a free port of `127.0.0.1`
  that injects faults per JSON-RPC method (`hang`, `http`, `rpc-error`, `reset`, `drop`, `truncate`, `result`,
  `previous`), with `set(rules)`, `requests(method?)` and `stop()`. A Node.js test tool, not instrumentation: the
  one package whose `src/` imports `node:http` (type-checked with Node types), and it rejects on a refused upstream
  or a failed bind. No dependencies.
- `reset` is an RST before any byte, `drop` a FIN before any byte: `reset` writes headers and part of a body, but
  they are still corked when the socket is reset. ADR 0032 describes `reset` as headers and part of a body; the old
  proxy of the viem tests never sent that, and the adapters' fault rows are pinned against what it sent. A reset after
  a partial body would be a new kind (an ADR change), not a change of `reset`.
- `truncate` is that kind (ADR 0032, 0.2.0): headers with a larger `content-length`, part of the body, then an RST
  5 ms after the write callback (`TRUNCATE_RESET_DELAY_MS`). Sent from the write callback itself, the RST was lost on
  macOS loopback once a keep-alive connection had carried a few dozen exchanges, and the client waited for the rest
  of the body; with a 0 or 1 ms timer it was still lost now and then when test files ran in parallel. The keep-alive
  rows of `test/proxy.test.ts` check that it arrives.
- Safety rules of ADR 0032 point 3, each with a unit test: loopback upstreams only unless `allowRemoteUpstream`,
  judged from the URL as written; only `http:` and `https:`; one upstream request per client request; redirects
  passed back, never followed. A change to them needs an ADR.
- `test/proxy.test.ts` every rule and kind against a local HTTP server as the node, in the order of ADR 0032 point 8
  (no Anvil); `test/quick-start.test.ts` runs the README's quick start (`test/readme/quick-start.ts`) as written
- The adapters' fault tests (`packages/*/test/*faults*.int.test.ts` and others) import it as `@hashspan/faults`,
  resolved from source by `vitest.config.ts`; a change of behaviour runs them too (`pnpm test:integration`)
