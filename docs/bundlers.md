# ERC-4337 bundler matrix

The matrix sends the same user operations to several ERC-4337 bundlers on a local chain and compares what each
answers with
[ERC-7769](https://github.com/ethereum/ERCs/blob/a431a3fb66c1f31fa5394893003f7b9bb61c54bf/ERCS/erc-7769.md), the
JSON-RPC API of ERC-4337, and with the others. It also reads the chain, so it checks what was included, not only
what was answered. It is a lab tool of this repository; hashspan's packages do not depend on it.

## What it runs

Wave 1 is three bundlers at pinned versions ([`targets.mjs`](../scripts/bundlers/targets.mjs)):

- Rundler v0.11.0 (alchemyplatform), the signed linux release binary for the Docker VM's architecture
- Alto v1.2.8 (pimlicolabs), built from a `git archive` of the tag, not from the official image
- Voltaire v1.0.5 (candidelabs), built from a `git archive` of the tag

Skandha comes in wave 2, after wave 1 agrees on the valid cases. The eth-infinitism bundler is a reference column,
not a gating target. Silius is out: it has had no release since 2024 and supports EntryPoint v0.6 only. The
[bundler-spec-tests](https://github.com/eth-infinitism/bundler-spec-tests) of eth-infinitism cover the ERC-7562
validation rules. This matrix cites them and does not copy them.

v1 runs every bundler in its unsafe mode, without a tracer: Rundler `--unsafe`, Alto `--safe-mode false`, Voltaire
`--unsafe`. Full ERC-7562 validation (opcode, storage, reputation and stake rules) traces validation with
`debug_traceCall` and a JavaScript or custom tracer. Anvil does not offer that tracer, so on Anvil those rules cannot
be checked, and no row of the matrix is about them. A safe-mode row can come later on a node that has the tracer.

Every target talks to the same chain: Anvil with chain id 1337 (Rundler's `dev` network), with the canonical
EntryPoint v0.7 and SimpleAccountFactory v0.7 deployed through the deterministic deployer
([`chain.mjs`](../scripts/bundlers/chain.mjs)). All keys are Anvil's well-known test keys. A run first asks
`eth_supportedEntryPoints`: a case runs only on an EntryPoint the target lists and the chain has. v1 deploys v0.7
only, so a v0.8 row would show as unsupported, kept apart from failures.

The corpus ([`corpus.mjs`](../scripts/bundlers/corpus.mjs), committed as `corpus.json`) holds user operations of
SimpleAccount smart accounts, built and signed with permissionless's `toSimpleSmartAccount`:

- valid: a plain operation that deploys its account, a batch of two calls in one operation, two operations sent back
  to back (one bundle or two), and an operation whose call reverts
- rejected: a bad signature, a malformed signature that reverts in validation (AA23), a sender without funds (AA21), a
  verification gas limit too low, a reused nonce (AA25), and a preVerificationGas of 2^128, whose row is marked
  `known:` [alchemyplatform/rundler#1354](https://github.com/alchemyplatform/rundler/issues/1354)
- recorded only: a nonce gap and a replacement with higher fees

Each case lists what it expects. A `spec` row cites the line of ERC-7769 that states the result, and a mismatch is a
spec difference. An `unspecified` row is recorded and compared across targets only. ERC-7769 names error codes
-32500 to -32508 except -32506, so no row expects -32506. A `known:` mark names an upstream item that already
describes a difference. A test on Anvil checks that the committed senders are the factory's, lands the plain
operation through a direct `handleOps`, and checks that each rejected operation fails validation with its AAxx code.

For each included operation the run reads `eth_getUserOperationReceipt` and `eth_getUserOperationByHash` and compares
them with the chain: the receipt fields, the `UserOperationEvent` values, `logs` holding this operation's logs only,
and `receipt` being the bundle's whole receipt
([hashspan#431](https://github.com/selimaytac/hashspan/issues/431)). `actualGasCost`, `paymaster`, `success` and
`reason` are the fields hashspan's user operation spans read.

A run has two passes:

1. Conformance: every case, each through the faults proxy with no fault.
2. Faults: the plain operation again, for an account of its own, with one fault of
   [`@hashspan/faults`](../packages/faults/README.md) on the bundler's `eth_sendRawTransaction`, `eth_estimateGas`,
   `eth_getTransactionReceipt` or `eth_call` (hang, reset, drop, truncate, a JSON-RPC error). The case sends,
   waits for the receipt, then sends the same operation again and waits again; the conformance pass covers the
   estimate. A bundler calls its node while
   it starts, so the proxy applies the fault only once the bundler answers. A scenario whose method was never called
   after that is counted as not exercised. The invariants:
   - no operation is reported included without a mined bundle
   - no operation is included twice
   - a receipt agrees with the chain
   - a reported failure is not followed by an inclusion that the retry did not announce

   The harness waits for a receipt as long as the target's bundle interval plus 30 seconds. Each target entry records
   that interval with its source line.

## How a run is isolated

Each run uses at most three containers, each removed after the run with `--rm`, limited to 2 GiB and mounting no
directory of the host:

- `e16-anvil` owns the network namespace. It is on the `e16-net` network, resolves names through 127.0.0.1 only and
  publishes Anvil's port (18565) and the bundler's port (14337) on 127.0.0.1.
- `e16-faults` runs the faults proxy from the built `packages/faults`
  ([`faults-runner/`](../scripts/bundlers/faults-runner/runner.mjs)), with the fault scenario from an environment
  variable. It joins Anvil's namespace with `--network container:e16-anvil`, so its upstream is 127.0.0.1 and remote
  upstreams stay refused.
- `e16-<target>` is the bundler, which also joins the namespace. Its node URL is the proxy's. Its keys are passed by
  environment name only.

Inside the namespace every bundler listens on 0.0.0.0, since Docker forwards a published port to the namespace's
interface address and not to its loopback. Only the 127.0.0.1 publish reaches the host. Alto's listen host is fixed
to 0.0.0.0 ([pimlicolabs/alto#767](https://github.com/pimlicolabs/alto/issues/767)), and Rundler's RPC and metrics
listen on 0.0.0.0 by default, so on a host they would listen on every network interface. That is why the matrix never
runs a bundler on the host, only in its container. A run fails when the proxy saw no request from the bundler.

The images are built from scratch contexts, with a Dockerfile of
[`docker/`](../scripts/bundlers/docker/rundler.Dockerfile) that only copies its build context:

- Rundler's release publishes a tarball and a detached signature per platform, and no checksum file. The harness pins
  the SHA-256 of both, per architecture, and checks that the signature names the pinned issuer key
  ([`rundler.mjs`](../scripts/bundlers/rundler.mjs)). That public key is not published where it could be fetched, so
  a cryptographic check of the signature runs only when the run is given the key (`--rundler-key`).
- Alto's contract submodules are empty in an archive. The harness fetches each at the commit the tag records. The
  image compiles the contracts as the tag's build scripts do, then installs and builds only Alto's package, one task
  at a time with a 4 GiB heap.

Building the images needs the network. Running them does not.

## Run it

With Docker, the ports 18565 and 14337 free on 127.0.0.1 and no other stack running, run one target at a time, then
regenerate the tables:

```sh
pnpm install && pnpm --filter @hashspan/faults build && ./scripts/install-bundler.sh
node scripts/bundlers/run.mjs rundler   # --list names the targets; --clone <dir> reuses a clone of Alto or Voltaire
pnpm bundlers:table
```

`scripts/install-bundler.sh` provides the EntryPoint artifacts the chain setup deploys. The run writes
`docs/bundlers/results/<target>@<version>.json` and removes its containers, its network and its images.
`--pass conformance` or `--pass faults` runs one pass, and `--keep-images` keeps the images.

## Results

The first table has one row per target. The second has one row per compared field of each case, with each target's
value. A spec difference is in bold. A cell says what the bundler returned or what the chain shows, not why.

<!-- bundlers:table:start (generated by `pnpm bundlers:table`, do not edit) -->

| Target | Version | EntryPoints run | Spec rows matched | Spec differences | Known upstream | Not reached | Unspecified rows | Unsupported cases | Fault invariants | Faults not exercised | RPC requests seen | Run |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Alto | `v1.2.8` | 0.7 | 48 of 52 | 4 | 0 | 0 | 22 | 0 | 60 of 60 hold | 5 | 368 | [2026-10-22](bundlers/results/alto@v1.2.8.json) |
| Rundler | `v0.11.0` | 0.7 | 48 of 52 | 3 | 1 | 0 | 22 | 0 | 60 of 60 hold | 5 | 771 | [2026-10-22](bundlers/results/rundler@v0.11.0.json) |
| Voltaire | `v1.0.5` | 0.7 | 51 of 52 | 1 | 0 | 0 | 22 | 0 | 12 of 12 hold | 17 | 277 | [2026-10-22](bundlers/results/voltaire@v1.0.5.json) |

| Case | Field | Spec | Alto | Rundler | Voltaire |
|---|---|---|---|---|---|
| `plain-op` | estimate.fields (step 0) | `complete` | `complete` | `complete` | `complete` |
| `plain-op` | accepted (step 1) | `true` | `true` | `true` | `true` |
| `plain-op` | included (step 2) | `true` | `true` | `true` | `true` |
| `plain-op` | receipt.shape (step 2) | `complete` | **`missing: paymaster`** | `complete` | `complete` |
| `plain-op` | receipt.matchesChain (step 2) | `true` | `true` | `true` | `true` |
| `plain-op` | receipt.success (step 2) | `true` | `true` | `true` | `true` |
| `plain-op` | receipt.logsOwn (step 2) | `true` | `true` | `true` | `true` |
| `plain-op` | receipt.bundleReceipt (step 2) | `whole-bundle` | `whole-bundle` | `whole-bundle` | `whole-bundle` |
| `plain-op` | byHash.matchesChain (step 2) | `true` | `true` | `true` | `true` |
| `plain-op` | receipt.paymaster (step 2) | *unspecified* | `absent` | `zero-address` | `zero-address` |
| `plain-op` | receipt.reason (step 2) | *unspecified* | `absent` | `not-hex` | `absent` |
| `batch-calls` | accepted (step 0) | `true` | `true` | `true` | `true` |
| `batch-calls` | included (step 1) | `true` | `true` | `true` | `true` |
| `batch-calls` | receipt.shape (step 1) | `complete` | **`missing: paymaster`** | `complete` | `complete` |
| `batch-calls` | receipt.matchesChain (step 1) | `true` | `true` | `true` | `true` |
| `batch-calls` | receipt.success (step 1) | `true` | `true` | `true` | `true` |
| `batch-calls` | receipt.logsOwn (step 1) | `true` | `true` | `true` | `true` |
| `batch-calls` | receipt.bundleReceipt (step 1) | `whole-bundle` | `whole-bundle` | `whole-bundle` | `whole-bundle` |
| `batch-calls` | byHash.matchesChain (step 1) | `true` | `true` | `true` | `true` |
| `batch-calls` | receipt.paymaster (step 1) | *unspecified* | `absent` | `zero-address` | `zero-address` |
| `batch-calls` | receipt.reason (step 1) | *unspecified* | `absent` | `not-hex` | `absent` |
| `two-senders` | accepted (step 0) | `true` | `true` | `true` | `true` |
| `two-senders` | included (step 2) | `true` | `true` | `true` | `true` |
| `two-senders` | receipt.shape (step 2) | `complete` | **`missing: paymaster`** | `complete` | `complete` |
| `two-senders` | receipt.matchesChain (step 2) | `true` | `true` | `true` | `true` |
| `two-senders` | receipt.success (step 2) | `true` | `true` | `true` | `true` |
| `two-senders` | receipt.logsOwn (step 2) | `true` | `true` | `true` | `true` |
| `two-senders` | receipt.bundleReceipt (step 2) | `whole-bundle` | `whole-bundle` | `whole-bundle` | `whole-bundle` |
| `two-senders` | byHash.matchesChain (step 2) | `true` | `true` | `true` | `true` |
| `two-senders` | receipt.paymaster (step 2) | *unspecified* | `absent` | `zero-address` | `zero-address` |
| `two-senders` | receipt.reason (step 2) | *unspecified* | `absent` | `not-hex` | `absent` |
| `two-senders` | accepted (step 1) | `true` | `true` | `true` | `true` |
| `two-senders` | included (step 3) | `true` | `true` | `true` | `true` |
| `two-senders` | receipt.shape (step 3) | `complete` | **`missing: paymaster`** | `complete` | `complete` |
| `two-senders` | receipt.matchesChain (step 3) | `true` | `true` | `true` | `true` |
| `two-senders` | receipt.success (step 3) | `true` | `true` | `true` | `true` |
| `two-senders` | receipt.logsOwn (step 3) | `true` | `true` | `true` | `true` |
| `two-senders` | receipt.bundleReceipt (step 3) | `whole-bundle` | `whole-bundle` | `whole-bundle` | `whole-bundle` |
| `two-senders` | byHash.matchesChain (step 3) | `true` | `true` | `true` | `true` |
| `two-senders` | receipt.paymaster (step 3) | *unspecified* | `absent` | `zero-address` | `zero-address` |
| `two-senders` | receipt.reason (step 3) | *unspecified* | `absent` | `not-hex` | `absent` |
| `two-senders` | effect.sameBundle | *unspecified* | `true` | `true` | `true` |
| `execution-revert` | accepted (step 0) | *unspecified* | `true` | `true` | `true` |
| `execution-revert` | included (step 1) | *unspecified* | `true` | `true` | `true` |
| `execution-revert` | receipt.success (step 1) | `false` | `false` | `false` | `false` |
| `execution-revert` | receipt.reason (step 1) | `Error(boom)` | `Error(boom)` | `Error(boom)` | **`absent`** |
| `execution-revert` | receipt.matchesChain (step 1) | `true` | `true` | `true` | `true` |
| `bad-signature` | accepted (step 0) | `false` | `false` | `false` | `false` |
| `bad-signature` | code (step 0) | `-32507` | `-32507` | `-32507` | `-32507` |
| `bad-signature` | aa (step 0) | *unspecified* | `AA24` | `absent` | `absent` |
| `validation-revert` | accepted (step 0) | `false` | `false` | `false` | `false` |
| `validation-revert` | code (step 0) | `-32500` | `-32500` | `-32500` | `-32500` |
| `validation-revert` | aa (step 0) | `AA23` | `AA23` | `AA23` | `AA23` |
| `insufficient-prefund` | accepted (step 0) | `false` | `false` | `false` | `false` |
| `insufficient-prefund` | code (step 0) | `-32500` | `-32500` | **`-32000`** | `-32500` |
| `insufficient-prefund` | aa (step 0) | `AA21` | `AA21` | **`absent`** | `AA21` |
| `low-verification-gas` | accepted (step 0) | `false` | `false` | `false` | `false` |
| `low-verification-gas` | code (step 0) | *unspecified* | `-32500` | `-32500` | `-32500` |
| `low-verification-gas` | aa (step 0) | *unspecified* | `AA13` | `AA13` | `AA13` |
| `nonce-reuse` | accepted (step 0) | `true` | `true` | `true` | `true` |
| `nonce-reuse` | included (step 1) | `true` | `true` | `true` | `true` |
| `nonce-reuse` | accepted (step 2) | `false` | `false` | `false` | `false` |
| `nonce-reuse` | code (step 2) | `-32500` | `-32500` | `-32500` | `-32500` |
| `nonce-reuse` | aa (step 2) | `AA25` | `AA25` | `AA25` | `AA25` |
| `nonce-gap` | accepted (step 0) | *unspecified* | `false` | `false` | `false` |
| `nonce-gap` | code (step 0) | *unspecified* | `-32500` | `-32500` | `-32500` |
| `nonce-gap` | aa (step 0) | *unspecified* | `AA25` | `AA25` | `AA25` |
| `replacement` | accepted (step 0) | *unspecified* | `true` | `true` | `true` |
| `replacement` | accepted (step 1) | *unspecified* | `true` | `true` | `true` |
| `replacement` | code (step 1) | *unspecified* | `absent` | `absent` | `absent` |
| `replacement` | effect.landed | *unspecified* | `replacement` | `replacement` | `replacement` |
| `pre-verification-gas-out-of-range` | answer (step 0) | `error` | `error` | **`connection`** (known: rundler#1354) | `error` |
| `pre-verification-gas-out-of-range` | accepted (step 0) | `false` | `false` | **`absent`** | `false` |
| `pre-verification-gas-out-of-range` | code (step 0) | *unspecified* | `-32500` | `absent` | `-32500` |

<!-- bundlers:table:end -->
