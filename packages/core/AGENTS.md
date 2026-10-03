# packages/core

The transaction lifecycle tracker: send, confirm, payment, user operation and call batch spans, links, fees,
privacy modes and metrics. It makes no network calls; adapters pass it hashes, metadata and receipts. Root rules:
[AGENTS.md](../../AGENTS.md).

- `src/tracker.ts` public `createTxTracker()` and `TxTracker`: creates the stores, options and metrics of one tracker
  and wires the span kinds of `src/tracker/`, which never import `tracker.ts`:
  - `transaction.ts` send and confirm spans of transactions, replaced transactions, fees, authorizations
  - `payment.ts` payment spans (ADR 0013, ADR 0017)
  - `user-operation.ts` user operation spans (ADR 0021); `call-batch.ts` call batch spans (ADR 0022)
  - `spans.ts` `createSpanRecording()`: redaction, errors, ending a span once, address and metric attributes
  - `handles.ts` `safely()`, error types and handle options; `confirm-claim.ts` handles sharing one confirm span
    (ADR 0007); `values.ts` validating hashes, addresses and quantities
- `src/attributes.ts` attribute keys (mirror of docs/semconv.md, checked by `test/semconv-doc.test.ts`);
  `src/privacy.ts` address modes; `src/link-store.ts` send→confirm links; `src/confirm-registry.ts` one confirm span
  per transaction; `src/agent.ts` agent identity; `src/metrics.ts` the histograms (ADR 0020)
- `test/helpers.ts` registers an in-memory tracer provider for span assertions
- `test/docs.test.ts` checks the repository's documentation (links, ADR index, package table, scopes, code examples)
