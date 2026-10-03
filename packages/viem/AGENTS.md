# packages/viem

Capture adapter for viem clients. Root rules: [AGENTS.md](../../AGENTS.md).

- `src/index.ts` `withHashspan()`: a `client.extend()` extension wrapping `sendTransaction`, `writeContract` and
  `waitForTransactionReceipt` (with a transaction's EIP-7702 authorizations), a bundler client's
  `sendUserOperation` and `waitForUserOperationReceipt` (ADR 0021), and a wallet client's `sendCalls`,
  `waitForCallsStatus` and `sendCallsSync` (ADR 0022); it calls the base client's actions, so internal viem calls
  are not traced twice. It only wires the modules below; the public types the modules share are in `src/types.ts`.
  - State shared by every client extended with one `withHashspan()` result (tracker, ABIs, revert reasons) is built
    in that call and passed to the modules' factories; confirm deduplication lives in the tracker (ADR 0007).
  - One module per send path, each adding its traced actions for one client: `src/transaction.ts`,
    `src/user-operation.ts`, `src/call-batch.ts`; `src/send.ts` traces a send (also once a late chain id is known),
    `src/arguments.ts` reads call arguments from own data properties only.
  - `src/confirm/` is the confirmation work every EVM path needs (ADR 0001 amendment), and imports nothing from the
    extension: `confirmation.ts` (receipt, sealed receipt, revert reason, background limit), `watch.ts`,
    `pending.ts` (`track()`, `flush()`, ending a handle once), `receipt.ts` (normalising receipts, classifying
    rejections), `timing.ts`, `recent.ts`.
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
  in-process bundler, to a stand-in EntryPoint (`test/entry-point/`, compiled into `test-entry-point.ts`); every
  Anvil test starts on a free port (`test/free-port.ts`)
- `.github/workflows/viem-range.yml` runs the viem tests weekly against both ends of the viem peer range; a test that
  needs an action or a behaviour of a newer viem than the floor is gated by `test/viem-version.ts` (`viemHasAction()`,
  `viemAtLeast()`), with a comment naming the release that introduced it
- `test/real-bundler.int.test.ts` sends user operations through Alto, a real bundler, to the canonical EntryPoint
  v0.7, both installed outside the workspace by `scripts/install-bundler.sh` (GPL, pinned by
  `scripts/bundler/package-lock.json`); it runs in CI or with `HASHSPAN_REAL_BUNDLER=1`, since Alto listens on every
  network interface
