# x402 facilitator conformance matrix

The matrix sends the same x402 v2 payments to several facilitator implementations on a local chain and compares
what each answers on `/verify` and `/settle` with the spec and with the others. It also moves the token on chain, so
it checks what was paid, not only what was answered. It is a lab tool of this repository; hashspan's packages do not
depend on it.

## What it runs

Wave 1 is the three facilitators of the x402 repository's end-to-end suite at one pinned commit
([`targets.mjs`](../scripts/facilitators/targets.mjs)): `e2e/facilitators/typescript`, `go` and `python` at
`faa1c694`. Wave 2, x402-rs and qntx/facilitator, is listed there and not run yet.

Every target talks to the same chain: Anvil with chain id 84532 and a genesis time of 2024-01-01, with Permit2, the
x402 Permit2 proxies, the batch-settlement contracts and Multicall3 installed at their canonical addresses and an
EIP-3009 test token ([`chain.mjs`](../scripts/facilitators/chain.mjs)). All keys are Anvil's well-known test keys.

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

The committed corpus is signed for 2024-01-01, so every signature in it expired long before any run. The facilitators
check a validity window against their host clock, so a run signs the same cases again in memory with windows around
its own time. Those payloads are never written to a file, and a result holds no payload or signature.

A run has two passes:

1. Conformance: it reads `/supported` first. A case of a scheme the target does not offer is `unsupported`, which is
   not a failure. Then it sends every other case, `/verify` before `/settle`, and reads the token balances.
2. Faults: the valid case of each scheme again, with one fault of
   [`@hashspan/faults`](../packages/faults/README.md) on the facilitator's `eth_sendRawTransaction` or
   `eth_getTransactionReceipt` (hang, reset, drop, truncate, a JSON-RPC error), then the same settle again. The
   invariants: no success without a mined transfer, no failure after one (unless it is `settlement_pending` with the
   transaction), and funds never move twice.

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

No results yet: the first lab run of the matrix writes them.

<!-- facilitators:table:end -->
