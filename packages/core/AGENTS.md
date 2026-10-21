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
    (ADR 0007); `values.ts` validating chain ids, hashes, addresses, quantities, names and identifiers
- `src/attributes.ts` attribute keys (mirror of docs/semconv.md, checked by `test/semconv-doc.test.ts`);
  `src/privacy.ts` address modes; `src/link-store.ts` send→confirm links; `src/confirm-registry.ts` one confirm span
  per transaction; `src/agent.ts` agent identity; `src/metrics.ts` the histograms (ADR 0020)
- `test/helpers.ts` registers an in-memory tracer provider for span assertions
- `test/docs.test.ts` checks the repository's documentation (links, ADR index, package table, scopes, code examples)
- `test/backends-*.test.ts` test the backend matrix of `scripts/backends/` without Docker: its corpus and encoding,
  normalizers, diff and result files; `test/fixtures/backends-e7/` holds the spans experiment E7 sent and read back
  (already normalized, no raw responses), from which the seeded results are computed
- `test/facilitators-*.test.ts` test the facilitator matrix of `scripts/facilitators/` without Docker: the corpus and
  its expired committed signatures, the targets and their docker run arguments, the Dockerfiles, the config files and
  bearer token of the Rust targets, a `--ref` run, the proxy runner's scenario, the diff, the invariants, the result files and the tables; `test/facilitators-corpus.int.test.ts` checks
  the committed corpus on Anvil with the matrix's chain setup
- `test/nodes-*.test.ts` test the dev-node matrix of `scripts/nodes/` without Docker: the vendored execution-apis
  files and the validator, the targets and their docker run arguments, the contract and the blob transaction of the
  flows, the rows, the candidate rule, the result files and the tables; `test/nodes-flows.int.test.ts` runs the flows
  on Anvil and checks its receipts and fee history against the schemas
- `test/hostile.ts` the hostile-input table of ADR 0025 (hostile values, documented bounds, the checks of rules 1 to 6
  and the untraced-versus-traced runner of the adapters), imported by every package's `test/hostile-input.test.ts`;
  `test/hostile-input.test.ts` applies it to every `TxTracker` method, handle method and option. A new entry point adds
  rows there; a rule that does not hold yet is an `it.fails` row tagged `// finding: <tag>`
- `.github/workflows/otel-api-floor.yml` runs every package's tests weekly against the oldest `@opentelemetry/api` of
  the peer range
