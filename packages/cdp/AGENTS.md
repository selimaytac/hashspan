# packages/cdp

Capture adapter for the Coinbase CDP SDK (ADR 0012). Root rules: [AGENTS.md](../../AGENTS.md).

- `src/index.ts` `withHashspan(cdp, { reader })` wraps `cdp.evm` and the accounts its factories return, in place;
  confirmations go through `@hashspan/viem`'s `watch()`; `src/networks.ts` maps CDP network names to chain ids;
  `src/user-operation.ts` user operations of smart accounts (ADR 0021), completed from the bundle receipt's
  `UserOperationEvent` with a reader; `src/own.ts` reads arguments without running getters
- `test/mock-cdp-api.ts` local stand-in for the CDP API that broadcasts on Anvil; tests never leave localhost
- `test/sdk-drift.test.ts` compares the adapter's copies of SDK rules with the installed SDK;
  `.github/workflows/cdp-sdk-latest.yml` runs the cdp tests weekly against the newest SDK in the peer range
