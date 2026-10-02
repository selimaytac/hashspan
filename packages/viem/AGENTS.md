# packages/viem

Capture adapter for viem clients. Root rules: [AGENTS.md](../../AGENTS.md).

- `src/index.ts` `withHashspan()`: a `client.extend()` extension wrapping `sendTransaction`, `writeContract` and
  `waitForTransactionReceipt`, and a bundler client's `sendUserOperation` and `waitForUserOperationReceipt`
  (ADR 0021); it calls the base client's actions, so internal viem calls are not traced twice.
  - State shared by every client extended with one `withHashspan()` result (tracker, ABIs, revert reasons) lives in
    that call's closure; confirm deduplication lives in the tracker (ADR 0007).
  - Background confirmation must never delay or fail the user's call, and nothing the telemetry needs is awaited
    before the call it traces (ADR 0009).
  - Work that outlives a traced call must be passed to `track()`, so `flush()` can await it (ADR 0010).
- `watch(client, { hash })` on the extension confirms a transaction sent elsewhere (a wallet API, another library);
  `@hashspan/cdp` and `@hashspan/x402` confirm through it
- `src/safe-tracker.ts` wraps the tracker so that no tracker, including a user-provided one, can throw into a call
- `src/transport.ts` `traceTransport()`: JSON-RPC requests as client spans (ADR 0019)
- `src/revert-reason.ts` replays reverted transactions and decodes the revert data (ADR 0005)
- `test/mock-transport.ts` EIP-1193 mock for unit tests (`test/mock-bundler.ts` for bundler clients);
  `test/*.int.test.ts` run against Anvil via prool; user operations go through `test/test-bundler.ts`, an
  in-process bundler, to a stand-in EntryPoint (`test/entry-point/`, compiled into `test-entry-point.ts`)
