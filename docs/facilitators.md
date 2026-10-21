# x402 facilitator conformance matrix

The matrix sends the same x402 v2 payments to several facilitator implementations on a local chain and compares
what each answers on `/verify` and `/settle` with the spec and with the others. It also moves the token on chain, so
it checks what was paid, not only what was answered. It is a lab tool of this repository; hashspan's packages do not
depend on it.

## What it runs

Wave 1 is the three facilitators of the x402 repository's end-to-end suite at one pinned commit
([`targets.mjs`](../scripts/facilitators/targets.mjs)): `e2e/facilitators/typescript`, `go` and `python` at
`faa1c694`. Wave 2, x402-rs and qntx/facilitator, is listed there and not run yet.

Each wave-1 target is an HTTP server of the e2e suite around that language's x402 SDK. The verify and settle logic,
and so the reason codes, come from the SDK; the HTTP envelope (the status code, and whether a failure comes as a
VerifyResponse or SettleResponse body or as an error text) and the RPC signer come from the e2e server. A row about
the envelope, such as a 500 for a failed verify or for an unregistered network, describes that e2e server, not the
SDK library.

Every target talks to the same chain: Anvil with chain id 84532, with Permit2, the x402 Permit2 proxies, the
batch-settlement contracts and Multicall3 installed at their canonical addresses and an EIP-3009 test token ([`chain.mjs`](../scripts/facilitators/chain.mjs)). All keys are Anvil's well-known test keys.

The corpus ([`corpus.mjs`](../scripts/facilitators/corpus.mjs), committed as `corpus.json`) has these cases:

- `exact` with EIP-3009: a valid payment, and an expired one, one not yet valid, a wrong amount, a wrong recipient, a
  wrong asset, a wrong network, a payer without funds, a bad signature and a replay (settle twice)
- `exact` with Permit2: a valid payment and an expired one
- `upto` with Permit2: a partial settlement and one above the authorized maximum
- an EIP-3009 payload sent as `upto`
- `batch-settlement`, driven through the SDK's channel manager: a refund before the settle
  ([x402#3730](https://github.com/x402-foundation/x402/issues/3730)), a stop with flush and dynamic pricing

Each case lists what it expects. A `spec` row cites the section of the x402 spec or scheme spec that states the
result, and a mismatch is a spec difference. An `unspecified` row is recorded and compared across targets only. A
`known:` mark names an upstream item that already describes a difference.

The committed corpus is signed for 2024-01-01, so every signature in it expired long before any run, and a test checks
it on an Anvil started at that time. The facilitators check a validity window against their host clock, so a run
signs the same cases again in memory with windows around its own time, on an Anvil that runs on the host clock too.
Those payloads are never written to a file, and a result holds no payload or signature.

A run has two passes:

1. Conformance: it reads `/supported` first. A case of a scheme the target does not offer is `unsupported`, which is
   not a failure. Then it sends every other case, `/verify` before `/settle`, and reads the token balances. The HTTP
   status of each call is a row of its own, `unspecified`: the spec gives the response bodies and leaves their HTTP
   status to the transport. An answer with a non-2xx status whose error text starts with a reason code
   (`settlement_pending: ...`) is read as that reason, so its reason rows compare with the other targets'.
2. Faults: the valid case of each scheme again, with one fault of
   [`@hashspan/faults`](../packages/faults/README.md) on the facilitator's `eth_sendRawTransaction` or
   `eth_getTransactionReceipt` (hang, reset, drop, truncate, a JSON-RPC error), then the same settle again. The
   invariants: no success without a mined transfer, no failure after one (unless it is `settlement_pending` with the
   transaction), funds never move twice, and nothing mines after the case unless an answer announced it as
   `settlement_pending`. Each fault case pays a receiver of its own, so a transfer that mines later counts for the case
   it belongs to. The harness waits for a settle as long as the target waits for its receipt, plus 30 seconds; each
   target entry records that wait with its source line.

## How a run is isolated

Each run uses at most three containers, each removed after the run with `--rm`, limited to 2 GiB and mounting no
directory of the host:

- `e14-anvil` owns the network namespace. It is on the `e14-net` network, resolves names through 127.0.0.1 only and
  publishes Anvil's port (18545) and the facilitator's port (14022) on 127.0.0.1.
- `e14-faults` runs the faults proxy from the built `packages/faults`
  ([`faults-runner/`](../scripts/facilitators/faults-runner/runner.mjs)), with the fault scenario from an environment
  variable. It joins Anvil's namespace with `--network container:e14-anvil`, so its upstream is 127.0.0.1 and remote
  upstreams stay refused.
- `e14-<target>` is the facilitator, which also joins the namespace. Its RPC URL is the proxy's. Its key is passed by
  environment name only.

Each wave-1 facilitator falls back to a public Base Sepolia RPC when its RPC variable is unset. The target entries
record that fallback with its source line, and the run always sets the variable. A run fails when the proxy saw no
request from the facilitator. The images are built from a `git archive` of the pinned commit with a Dockerfile of
[`docker/`](../scripts/facilitators/docker/typescript.Dockerfile) that only copies its build context. Building them
needs the network. Running them does not.

## Run it

With Docker, the ports 18545 and 14022 free on 127.0.0.1 and no other stack running, run one target at a time, then
regenerate the tables:

```sh
pnpm install && pnpm --filter @hashspan/faults build
node scripts/facilitators/run.mjs typescript   # --list names the targets; --x402 <clone> reuses a clone
pnpm facilitators:table
```

The run writes `docs/facilitators/results/<target>@<commit>.json` and removes its containers, its network and its
images. `--pass conformance` or `--pass faults` runs one pass, and `--keep-images` keeps the images.

## Results

The first table has one row per target. The second has one row per compared field of each case, with each target's
value. A spec difference is in bold. A cell says what the facilitator returned or what moved on chain, not why.

<!-- facilitators:table:start (generated by `pnpm facilitators:table`, do not edit) -->

| Target | Commit | Schemes offered | Spec rows matched | Spec differences | Known upstream | Unspecified rows | Unsupported cases | Fault invariants | RPC requests seen | Run |
|---|---|---|---|---|---|---|---|---|---|---|
| x402 e2e facilitator (Go) | `faa1c694` | auth-capture, batch-settlement, exact, upto | 20 of 40 | 19 | 1 | 44 | 0 | 144 of 150 hold | 98 | [2026-10-21](facilitators/results/go@faa1c694.json) |
| x402 e2e facilitator (Python) | `faa1c694` | batch-settlement, exact, upto | 38 of 40 | 1 | 1 | 44 | 0 | 147 of 150 hold | 222 | [2026-10-21](facilitators/results/python@faa1c694.json) |
| x402 e2e facilitator (TypeScript) | `faa1c694` | auth-capture, batch-settlement, exact, upto | 35 of 40 | 4 | 1 | 44 | 0 | 150 of 150 hold | 168 | [2026-10-21](facilitators/results/typescript@faa1c694.json) |

| Case | Field | Spec | x402 e2e facilitator (Go) | x402 e2e facilitator (Python) | x402 e2e facilitator (TypeScript) |
|---|---|---|---|---|---|
| `exact-eip3009-valid` | isValid (step 0) | `true` | `true` | `true` | `true` |
| `exact-eip3009-valid` | success (step 1) | `true` | `true` | `true` | `true` |
| `exact-eip3009-valid` | transaction (step 1) | `present` | `present` | `present` | `present` |
| `exact-eip3009-valid` | effect.payTo | `10000` | `10000` | `10000` | `10000` |
| `exact-eip3009-valid` | effect.payer | `-10000` | `-10000` | `-10000` | `-10000` |
| `exact-eip3009-expired` | isValid (step 0) | `false` | **`absent`** | `false` | `false` |
| `exact-eip3009-expired` | invalidReason (step 0) | `invalid_exact_evm_payload_authorization_valid_before` | **`absent`** | `invalid_exact_evm_payload_authorization_valid_before` | `invalid_exact_evm_payload_authorization_valid_before` |
| `exact-eip3009-expired` | success (step 1) | *unspecified* | `absent` | `false` | `false` |
| `exact-eip3009-expired` | errorReason (step 1) | *unspecified* | `absent` | `invalid_exact_evm_payload_authorization_valid_before` | `Payment must be verified before settlement` |
| `exact-eip3009-expired` | effect.payTo | *unspecified* | `0` | `0` | `0` |
| `exact-eip3009-not-yet-valid` | isValid (step 0) | `false` | **`absent`** | `false` | `false` |
| `exact-eip3009-not-yet-valid` | invalidReason (step 0) | `invalid_exact_evm_payload_authorization_valid_after` | **`absent`** | `invalid_exact_evm_payload_authorization_valid_after` | `invalid_exact_evm_payload_authorization_valid_after` |
| `exact-eip3009-not-yet-valid` | success (step 1) | *unspecified* | `absent` | `false` | `false` |
| `exact-eip3009-not-yet-valid` | errorReason (step 1) | *unspecified* | `absent` | `invalid_exact_evm_payload_authorization_valid_after` | `Payment must be verified before settlement` |
| `exact-eip3009-not-yet-valid` | effect.payTo | *unspecified* | `0` | `0` | `0` |
| `exact-eip3009-amount-mismatch` | isValid (step 0) | `false` | **`absent`** | `false` | `false` |
| `exact-eip3009-amount-mismatch` | invalidReason (step 0) | `invalid_exact_evm_payload_authorization_value_mismatch` | **`absent`** | `invalid_exact_evm_payload_authorization_value_mismatch` | `invalid_exact_evm_payload_authorization_value_mismatch` |
| `exact-eip3009-amount-mismatch` | success (step 1) | *unspecified* | `absent` | `false` | `false` |
| `exact-eip3009-amount-mismatch` | errorReason (step 1) | *unspecified* | `absent` | `invalid_exact_evm_payload_authorization_value_mismatch` | `Payment must be verified before settlement` |
| `exact-eip3009-amount-mismatch` | effect.payTo | *unspecified* | `0` | `0` | `0` |
| `exact-eip3009-recipient-mismatch` | isValid (step 0) | `false` | **`absent`** | `false` | `false` |
| `exact-eip3009-recipient-mismatch` | invalidReason (step 0) | `invalid_exact_evm_payload_recipient_mismatch` | **`absent`** | `invalid_exact_evm_payload_recipient_mismatch` | **`invalid_exact_evm_recipient_mismatch`** |
| `exact-eip3009-recipient-mismatch` | success (step 1) | *unspecified* | `absent` | `false` | `false` |
| `exact-eip3009-recipient-mismatch` | errorReason (step 1) | *unspecified* | `absent` | `invalid_exact_evm_payload_recipient_mismatch` | `Payment must be verified before settlement` |
| `exact-eip3009-recipient-mismatch` | effect.payTo | *unspecified* | `0` | `0` | `0` |
| `exact-eip3009-wrong-asset` | isValid (step 0) | `false` | **`absent`** | `false` | `false` |
| `exact-eip3009-wrong-asset` | invalidReason (step 0) | *unspecified* | `absent` | `invalid_exact_evm_payload_signature` | `invalid_exact_evm_signature` |
| `exact-eip3009-wrong-asset` | success (step 1) | *unspecified* | `absent` | `false` | `false` |
| `exact-eip3009-wrong-asset` | errorReason (step 1) | *unspecified* | `absent` | `invalid_exact_evm_payload_signature` | `Payment must be verified before settlement` |
| `exact-eip3009-wrong-asset` | effect.payTo | *unspecified* | `0` | `0` | `0` |
| `exact-eip3009-wrong-network` | isValid (step 0) | `false` | **`absent`** | `false` | **`absent`** |
| `exact-eip3009-wrong-network` | invalidReason (step 0) | *unspecified* | `absent` | `invalid_exact_evm_payload_signature` | `absent` |
| `exact-eip3009-wrong-network` | success (step 1) | *unspecified* | `absent` | `false` | `false` |
| `exact-eip3009-wrong-network` | errorReason (step 1) | *unspecified* | `absent` | `invalid_exact_evm_payload_signature` | `Payment must be verified before settlement` |
| `exact-eip3009-wrong-network` | effect.payTo | *unspecified* | `0` | `0` | `0` |
| `exact-eip3009-insufficient-balance` | isValid (step 0) | `false` | **`absent`** | `false` | `false` |
| `exact-eip3009-insufficient-balance` | invalidReason (step 0) | `insufficient_funds` | **`absent`** | **`invalid_exact_evm_insufficient_balance`** | **`invalid_exact_evm_insufficient_balance`** |
| `exact-eip3009-insufficient-balance` | success (step 1) | *unspecified* | `absent` | `false` | `false` |
| `exact-eip3009-insufficient-balance` | errorReason (step 1) | *unspecified* | `absent` | `transaction_failed` | `Payment must be verified before settlement` |
| `exact-eip3009-insufficient-balance` | effect.payTo | *unspecified* | `0` | `0` | `0` |
| `exact-eip3009-bad-signature` | isValid (step 0) | `false` | **`absent`** | `false` | `false` |
| `exact-eip3009-bad-signature` | invalidReason (step 0) | `invalid_exact_evm_payload_signature` | **`absent`** | `invalid_exact_evm_payload_signature` | **`invalid_exact_evm_signature`** |
| `exact-eip3009-bad-signature` | success (step 1) | *unspecified* | `absent` | `false` | `false` |
| `exact-eip3009-bad-signature` | errorReason (step 1) | *unspecified* | `absent` | `invalid_exact_evm_payload_signature` | `Payment must be verified before settlement` |
| `exact-eip3009-bad-signature` | effect.payTo | *unspecified* | `0` | `0` | `0` |
| `exact-eip3009-replay` | isValid (step 0) | `true` | `true` | `true` | `true` |
| `exact-eip3009-replay` | success (step 1) | `true` | `true` | `true` | `true` |
| `exact-eip3009-replay` | isValid (step 2) | `false` | **`absent`** | `false` | `false` |
| `exact-eip3009-replay` | invalidReason (step 2) | *unspecified* | `absent` | `invalid_exact_evm_nonce_already_used` | `invalid_exact_evm_nonce_already_used` |
| `exact-eip3009-replay` | success (step 3) | `false` | **`absent`** | `false` | `false` |
| `exact-eip3009-replay` | errorReason (step 3) | *unspecified* | `absent` | `transaction_failed` | `Payment must be verified before settlement` |
| `exact-eip3009-replay` | effect.payTo | `10000` | `10000` | `10000` | `10000` |
| `exact-permit2-valid` | isValid (step 0) | `true` | `true` | `true` | `true` |
| `exact-permit2-valid` | success (step 1) | `true` | `true` | `true` | `true` |
| `exact-permit2-valid` | transaction (step 1) | `present` | `present` | `present` | `present` |
| `exact-permit2-valid` | effect.payTo | `10000` | `10000` | `10000` | `10000` |
| `exact-permit2-valid` | effect.payer | `-10000` | `-10000` | `-10000` | `-10000` |
| `exact-permit2-expired` | isValid (step 0) | `false` | **`absent`** | `false` | `false` |
| `exact-permit2-expired` | invalidReason (step 0) | *unspecified* | `absent` | `permit2_deadline_expired` | `permit2_deadline_expired` |
| `exact-permit2-expired` | success (step 1) | *unspecified* | `absent` | `false` | `false` |
| `exact-permit2-expired` | errorReason (step 1) | *unspecified* | `absent` | `permit2_deadline_expired` | `Payment must be verified before settlement` |
| `exact-permit2-expired` | effect.payTo | *unspecified* | `0` | `0` | `0` |
| `upto-permit2-partial` | isValid (step 0) | `true` | `true` | `true` | `true` |
| `upto-permit2-partial` | success (step 1) | `true` | `true` | `true` | `true` |
| `upto-permit2-partial` | transaction (step 1) | `present` | `present` | `present` | `present` |
| `upto-permit2-partial` | effect.payTo | `4000` | `4000` | `4000` | `4000` |
| `upto-permit2-partial` | effect.payer | `-4000` | `-4000` | `-4000` | `-4000` |
| `upto-permit2-exceeds` | isValid (step 0) | `true` | `true` | `true` | `true` |
| `upto-permit2-exceeds` | success (step 1) | `false` | **`absent`** | `false` | `false` |
| `upto-permit2-exceeds` | errorReason (step 1) | `invalid_upto_evm_payload_settlement_exceeds_amount` | **`absent`** | `invalid_upto_evm_payload_settlement_exceeds_amount` | `invalid_upto_evm_payload_settlement_exceeds_amount` |
| `upto-permit2-exceeds` | effect.payTo | `0` | `0` | `0` | `0` |
| `exact-payload-as-upto` | isValid (step 0) | *unspecified* | `absent` | `false` | `false` |
| `exact-payload-as-upto` | invalidReason (step 0) | *unspecified* | `absent` | `unsupported_payload_type` | `unsupported_payload_type` |
| `exact-payload-as-upto` | success (step 1) | *unspecified* | `absent` | `false` | `false` |
| `exact-payload-as-upto` | effect.payTo | *unspecified* | `0` | `0` | `0` |
| `batch-refund-before-settle` | effect.payTo | `3000` | **`0`** (known: x402#3730) | **`0`** (known: x402#3730) | **`0`** (known: x402#3730) |
| `batch-refund-before-settle` | effect.payer | *unspecified* | `-3000` | `-3000` | `-3000` |
| `batch-refund-before-settle` | effect.contract | *unspecified* | `3000` | `3000` | `3000` |
| `batch-flush-stop` | effect.payTo | *unspecified* | `0` | `6000` | `6000` |
| `batch-flush-stop` | effect.payer | *unspecified* | `-10000` | `-10000` | `-10000` |
| `batch-flush-stop` | effect.contract | *unspecified* | `10000` | `4000` | `4000` |
| `batch-dynamic-pricing` | effect.payTo | *unspecified* | `0` | `1500` | `1500` |
| `batch-dynamic-pricing` | effect.payer | *unspecified* | `-10000` | `-10000` | `-10000` |
| `batch-dynamic-pricing` | effect.contract | *unspecified* | `10000` | `8500` | `8500` |

<!-- facilitators:table:end -->
