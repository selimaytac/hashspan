# packages/cdp

Capture adapter for the Coinbase CDP SDK (ADR 0012). Root rules: [AGENTS.md](../../AGENTS.md).

- `src/index.ts` `withHashspan(cdp, { reader })` wraps `cdp.evm` and the accounts its factories return, in place;
  confirmations go through `@hashspan/viem`'s `watch()`. It only wires the modules below: the state of one call
  (tracker, network warnings, reader, pending work) is built there and passed to the modules' factories.
  - `src/evm.ts` wraps the methods of `cdp.evm`; `src/server-account.ts` server accounts, their network-scoped
    accounts and swap quotes (ADR 0012); `src/smart-account.ts` the same for smart accounts (ADR 0021)
  - `src/transaction-spans.ts` send spans of transactions and confirm spans of network-scoped waits;
    `src/user-operation-spans.ts` user operation send and confirm spans, completed from the bundle receipt's
    `UserOperationEvent` with a reader, through `src/user-operation.ts`
  - `src/wrap.ts` replaces a method in place (`replace`, the `WRAPPED` mark); `src/pending.ts` work `flush()` waits
    for; `src/chain.ts` chain ids of network names, with their warnings, and the reader for a chain;
    `src/receipt.ts` receipts of waits without a reader; `src/helpers.ts` shared value and error helpers
- `src/networks.ts` maps CDP network names to chain ids; `src/own.ts` reads arguments without running getters
- `test/mock-cdp-api.ts` local stand-in for the CDP API that broadcasts on Anvil; tests never leave localhost
- `test/rpc-faults.int.test.ts` puts the reader behind the viem tests' fault proxy (`../viem/test/fault-proxy.ts`)
- `test/sdk-drift.test.ts` compares the adapter's copies of SDK rules with the installed SDK;
  `.github/workflows/cdp-sdk-latest.yml` runs the cdp tests weekly against the newest SDK in the peer range
- `test/hostile-input.test.ts` applies the hostile-input table (`../core/test/hostile.ts`, ADR 0025) to the wrapped SDK
  methods, with hostile arguments, SDK results, reader, tracker and client; a new wrapped method adds rows there
