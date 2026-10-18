# packages/mpp

Adapter for MPP payments made with mppx (ADR 0029). Root rules: [AGENTS.md](../../AGENTS.md).

- `src/index.ts` `withHashspan(mppx, { reader })` registers observers with `on()` on the client `Mppx.create()`
  returns: each Tempo `charge` becomes a `payment` span (`sender: 'payer'`, with the payer's own hash when the
  credential determines it); confirmations and the check of `blockchain.payment.verified` go through
  `@hashspan/viem`'s `watch()`. Observers never throw or return a value; payments are followed by `challenge.id`,
  since every event gets copies, and end as `timeout` when no outcome event comes, bounded in time and number.
  `payment.failed` is observed only with `observeFailures`, since observing it makes mppx buffer 5xx bodies. mppx is
  never imported at runtime: the credential and the `Payment-Receipt` header are decoded here, so the CommonJS build
  works.
- `test/fake-mppx.ts` a real mppx client and a real mppx server's challenges, offline: the payer's viem client talks
  to a JSON-RPC stand-in, so push and pull credentials are real; the paid API answers as each test says
- `test/hash.test.ts` checks the payer's hash against mppx's own `PaymentOutcomeUnknownError.transactionHash`;
  `test/mcp.test.ts` shows that `McpClient.wrap` fires no client event (a known limit)
- `test/charge.int.test.ts` settles real charges on Anvil in Tempo mode (`../viem/test/start-anvil.ts` with
  `network: 'tempo'`) through an mppx server in the same process: push on a shared and on a separate tracker,
  unsponsored and sponsored pull, splits, `verified` true and false, a sponsored pull whose reported transaction is
  not the payer's signed one (no verdict), a 4xx and a 5xx after payment;
  `test/quick-start.int.test.ts` runs the README's quick start (`test/readme/quick-start.ts`) against it;
  `.github/workflows/mppx-sdk.yml` runs the tests weekly against both ends of the mppx peer range
- `test/rpc-faults.int.test.ts` puts the reader behind the viem tests' fault proxy (`../viem/test/fault-proxy.ts`)
  while a real settlement is confirmed and checked
- `test/hostile-input.test.ts` applies the hostile-input table (`../core/test/hostile.ts`, ADR 0025) to the observers,
  with hostile challenges, credentials, receipt headers, response copies, errors and receipts, and to the options and
  the client; a new observer adds rows there
