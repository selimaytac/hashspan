# packages/core

The transaction lifecycle tracker: send, confirm, payment, user operation and call batch spans, links, fees,
privacy modes and metrics. It makes no network calls; adapters pass it hashes, metadata and receipts. Root rules:
[AGENTS.md](../../AGENTS.md).

- `src/tracker.ts` public `createTxTracker()`; `src/attributes.ts` attribute keys (mirror of docs/semconv.md, checked
  by `test/semconv-doc.test.ts`); `src/privacy.ts` address modes; `src/link-store.ts` send→confirm links;
  `src/confirm-registry.ts` one confirm span per transaction; `src/agent.ts` agent identity; `src/metrics.ts` the
  histograms (ADR 0020)
- `test/helpers.ts` registers an in-memory tracer provider for span assertions
- `test/docs.test.ts` checks the repository's documentation (links, ADR index, package table, scopes, code examples)
