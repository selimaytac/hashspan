# Dev-node matrix

The matrix sends the same scripted transactions and JSON-RPC calls to several local dev nodes, each started fresh from
genesis, and compares the answers with the Ethereum execution-apis spec and with each other. Developers test against
these nodes and ship against real ones, so where they disagree, a test can pass locally and fail in production. It
is a lab tool of this repository; hashspan's packages do not depend on it.

The production clients are already checked daily against the spec's fixtures by hive's rpc-compat suite, so the
matrix does not repeat that. It covers what that suite does not run: the dev nodes Anvil and Hardhat (EDR), live
send-and-mine flows on a fresh chain, error codes and message text, and the fee and L2 fields hashspan reads. Geth and
Reth are in it as the reference columns.

## What it runs

The nodes and their pinned versions are in [`targets.mjs`](../scripts/nodes/targets.mjs):

| Node | Version | Runs as | Status |
|---|---|---|---|
| Anvil | v1.8.5 | local process | run |
| Anvil nightly | the tag given to the run | local process | run, for fixes that are in nightlies only |
| Hardhat | 3.20.0 on EDR 0.24.0 | local process | run |
| Reth `--dev` | v2.8.0 | Docker | run, reference |
| Geth `--dev` | v1.17.8 | Docker | run, reference |
| Nethermind (spaceneth) | 2.2.0 | | phase 2, after the gate, if it fits in 2 GiB |
| Besu | | | out: its built-in dev network is London only, so it has no EIP-4844 and no EIP-7702 |
| Ganache | | | out: archived in 2024 |

Hardhat 3.20.0 depends on EDR 0.23.0 exactly, so the run installs it in a scratch project with an npm override to EDR
0.24.0 and fails unless that is the EDR it got. The Anvil release and nightly archives come from Foundry's GitHub
releases and are checked against their checksums (pinned for the release, and the release's own `.sha256` file and
asset digest for both) before they run. Anvil, Hardhat and Reth prefund the well-known test mnemonic. Geth prefunds one
faucet, so the run first sends each well-known account it uses 1,000 ETH from it; that setup is recorded in the
result and not compared.

Geth's binaries are GPL-3.0 and its library LGPL-3.0, Nethermind is GPL-3.0. The matrix only talks to them over HTTP
and neither links nor vendors them.

## What it compares

The expected column is the execution-apis OpenRPC spec at commit
[`16caee27`](https://github.com/ethereum/execution-apis/tree/16caee274b0d4fb7a0316f294029adac88a75a09) (CC0-1.0). Only
the files of the methods the flows call, the schemas they reference and the error groups are vendored, byte for byte,
in [`scripts/nodes/execution-apis/`](../scripts/nodes/execution-apis/manifest.json), with the licence and a manifest of
their git blob ids and SHA-256. `node scripts/nodes/vendor.mjs --write` fetches them again from that commit, and a test
checks that the files are exactly that list. The spec's `.io` fixtures need its chain state, so they are not replayed on
a dev node.

The flows ([`flows.mjs`](../scripts/nodes/flows.mjs)) run in order on one fresh node: a contract deploy (a small
contract assembled from opcodes in [`contract.mjs`](../scripts/nodes/contract.mjs)), legacy, EIP-2930 and EIP-1559
transfers, logs with `eth_getLogs` and a filter, a revert with a reason and with a custom error, an out-of-gas
transaction, `eth_estimateGas`, `eth_feeHistory`, `eth_getBlockReceipts`, `eth_simulateV1`, `debug_traceTransaction`,
an EIP-7702 authorization, an EIP-4844 blob transaction, invalid input (a nonce too low, a fee below the base fee, bad
parameters, an unknown method) and concurrent `eth_sendTransaction` calls from one account. Every compared transaction
is signed locally and sent with `eth_sendRawTransaction`. The blob is all zeros, whose KZG commitment and proofs are
the point at infinity, so no KZG library is needed. The run sends it in the EIP-7594 form first and in the EIP-4844
form if the node refuses that.

Before the flows the run probes the node ([`probes.mjs`](../scripts/nodes/probes.mjs)). A method is unsupported only
when the node answers that it does not know it (`-32601`, or `-32004` as EDR returns it), and EIP-7702 and EIP-4844 are
read from the fork fields of the genesis header. A flow that needs what the node lacks is `unsupported` and kept apart
from failed flows and from differences.

Each answer becomes rows of three kinds ([`diff.mjs`](../scripts/nodes/diff.mjs)):

- `spec`: the spec, or JSON-RPC 2.0 for the standard error codes, states the answer, so a mismatch is a spec
  difference. Results are validated against the method's result schema, which names an extra, missing or mistyped
  field but never its value. A send's error code must be one of the codes of the method's error groups.
- `unspecified`: the spec is silent (error messages, most error codes, gas values), so the answer is recorded and
  compared across nodes, with Geth and Reth as the references. A regression row has the expected value of the
  upstream item it comes from.
- `by-design`: a field a chain mode adds on purpose, such as an L2 fee field. It is never a difference.

Values that differ by design (hashes, times, block numbers, gas prices, chain id, client version) are compared by
their kind only, and each node's genesis parameters are recorded in its result so a reader sees why they differ.

A candidate is what the review after a run looks at. It is a code that differs from the references where they agree, a
field that is missing or of another kind, a value that differs, or a message that names another cause than its own
(each invalid-input flow declares its cause, such as `nonce` or `fee`). A message that words the same cause differently
is recorded and never a candidate on its own. A `known:` mark names an upstream item that already describes a
difference: [edr#1258](https://github.com/NomicFoundation/edr/issues/1258) (`-32004` for an unknown method),
[foundry#17354](https://github.com/foundry-rs/foundry/issues/17354) (concurrent `eth_sendTransaction` nonces) and
[foundry#17462](https://github.com/foundry-rs/foundry/issues/17462) (the Celo `0x7b` type), both fixed after Anvil
v1.8.5, and [edr#1829](https://github.com/NomicFoundation/edr/issues/1829) (the OP L1 fee), fixed in EDR 0.24.0, which
the rows show as fixed where the expected answer comes back.

## Chain modes

Some dev nodes emulate other chains. Each mode runs on a fresh node of its own and is compared with the shape a real
chain returned in an earlier experiment ([`chain-modes.mjs`](../scripts/nodes/chain-modes.mjs)), not with Geth and
Reth, which emulate no L2:

- Hardhat's OP chain type: the L1Block scalars are non-zero, as on OP Mainnet and Base, and a receipt has a non-zero
  `l1Fee` (edr#1829). Its L1 fee fields are by design.
- Anvil `--network optimism`: the receipts carry no L1 fee fields, as Anvil models no L1 data fee. That is recorded.
- Anvil `--network tempo`: every receipt, a `0x2` one too, has `feeToken` and `feePayer`, as Tempo mainnet's do.
- Anvil `--celo`: a signed CIP-64 (`0x7b`) transaction is accepted, as Celo mainnet builds one (foundry#17462).

## How a run is isolated

One node runs at a time, with other stacks stopped. Anvil and Hardhat listen on 127.0.0.1:18555. Reth and Geth run as
`e15-reth` and `e15-geth`, removed after the run with `--rm` and limited to 2 GiB, with only the HTTP JSON-RPC port
published, on 127.0.0.1:18555: no p2p, auth or metrics port. Neither mounts a directory of the host. Reth keeps its
datadir in the named volume `e15-reth-data` and Geth keeps its chain in memory (`--dev --dev.period 0 --nodiscover
--maxpeers 0`). Each image is pulled by its digest and removed after the run, and so are the volume, the Anvil
download and the Hardhat project.

## Run it

With port 18555 free on 127.0.0.1 and, for Reth and Geth, Docker, run one node at a time, then regenerate the tables:

```sh
pnpm install
node scripts/nodes/run.mjs anvil         # --list names the nodes; --anvil <binary> uses a local Anvil v1.8.5
node scripts/nodes/run.mjs anvil-nightly --nightly nightly-<commit>
node scripts/nodes/run.mjs hardhat       # needs the npm registry
node scripts/nodes/run.mjs reth
node scripts/nodes/run.mjs geth
pnpm nodes:table
```

The run writes `docs/nodes/results/<node>@<version>.json` (`--out <dir>` writes it elsewhere). The chain modes run
after the flows, each on a fresh node; `--no-chain-modes` skips them and `--keep-image` keeps the image. A result holds
no hash, key, raw transaction or time of the run and no host data, and a run whose result would hold one keeps it
outside the repository and fails.

## Results

The first table has one row per node. The second has one row per compared field of each flow, with each node's value,
and the third the chain-mode rows. A spec difference and a candidate are in bold. A cell says what the node returned
or stored, not why.

<!-- nodes:table:start (generated by `pnpm nodes:table`, do not edit) -->

| Node | Version | Chain id | Spec rows matched | Spec differences | Known upstream | Candidates | Unspecified rows | By design | Unsupported flows | Failed flows | Run |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Anvil nightly | `2026-10-21` | 31337 | 44 of 57 | 13 | 0 | 2 | 73 | 3 | 0 | 0 | [2026-10-21](nodes/results/anvil-nightly@2026-10-21.json) |
| Anvil | `1.8.5` | 31337 | 44 of 56 | 12 | 2 | 2 | 72 | 2 | 0 | 0 | [2026-10-21](nodes/results/anvil@1.8.5.json) |
| Geth --dev | `1.17.8` | 1337 | 53 of 53 | 0 | 0 | 2 | 68 | 0 | 0 | 0 | [2026-10-21](nodes/results/geth@1.17.8.json) |
| Hardhat (EDR) | `3.20.0 (EDR 0.24.0)` | 31337 | 49 of 50 | 0 | 1 | 8 | 67 | 1 | 2 | 0 | [2026-10-21](nodes/results/hardhat@3.20.0.json) |
| Reth --dev | `2.8.0` | 1337 | 54 of 54 | 0 | 0 | 3 | 70 | 0 | 0 | 0 | [2026-10-21](nodes/results/reth@2.8.0.json) |

| Flow | Call | Field | Expected | Anvil nightly | Anvil | Geth --dev | Hardhat (EDR) | Reth --dev |
|---|---|---|---|---|---|---|---|---|
| `deploy` | receipt | schema | `valid` | **`/ additionalProperties blockTimestamp (number)`** | **`/ additionalProperties blockTimestamp (number)`** | `valid` | `valid` | `valid` |
| `deploy` | receipt | type | `0x2` | `0x2` | `0x2` | `0x2` | `0x2` | `0x2` |
| `deploy` | receipt | status | `0x1` | `0x1` | `0x1` | `0x1` | `0x1` | `0x1` |
| `deploy` | receipt | gasUsed | *unspecified* | `0x1a26a` | `0x1a26a` | `0x1a26a` | `0x1a26a` | `0x1a26a` |
| `deploy` | receipt | logs | *unspecified* | `0` | `0` | `0` | `0` | `0` |
| `deploy` | receipt | contractAddress | *unspecified* | `present` | `present` | `present` | `present` | `present` |
| `deploy` | receipt | fields | *unspecified* | `15 fields, also blockTimestamp:number` | `15 fields, also blockTimestamp:number` | `14 fields` | `14 fields` | `14 fields` |
| `deploy` | code | runtime | *unspecified* | `as deployed` | `as deployed` | `as deployed` | `as deployed` | `as deployed` |
| `legacy` | send | schema | `valid` | `valid` | `valid` | `valid` | `valid` | `valid` |
| `legacy` | receipt | schema | `valid` | **`/ additionalProperties blockTimestamp (number)`** | **`/ additionalProperties blockTimestamp (number)`** | `valid` | `valid` | `valid` |
| `legacy` | receipt | type | `0x0` | `0x0` | `0x0` | `0x0` | `0x0` | `0x0` |
| `legacy` | receipt | status | `0x1` | `0x1` | `0x1` | `0x1` | `0x1` | `0x1` |
| `legacy` | receipt | gasUsed | *unspecified* | `0x5208` | `0x5208` | `0x5208` | `0x5208` | `0x5208` |
| `legacy` | receipt | logs | *unspecified* | `0` | `0` | `0` | `0` | `0` |
| `legacy` | receipt | contractAddress | *unspecified* | `null` | `null` | `null` | `null` | `null` |
| `legacy` | receipt | fields | *unspecified* | `15 fields, also blockTimestamp:number` | `15 fields, also blockTimestamp:number` | `14 fields` | `14 fields` | `14 fields` |
| `legacy` | receipt | effectiveGasPrice | `formula holds` | `formula holds` | `formula holds` | `formula holds` | `formula holds` | `formula holds` |
| `eip2930` | send | schema | `valid` | `valid` | `valid` | `valid` | `valid` | `valid` |
| `eip2930` | receipt | schema | `valid` | **`/ additionalProperties blockTimestamp (number)`** | **`/ additionalProperties blockTimestamp (number)`** | `valid` | `valid` | `valid` |
| `eip2930` | receipt | type | `0x1` | `0x1` | `0x1` | `0x1` | `0x1` | `0x1` |
| `eip2930` | receipt | status | `0x1` | `0x1` | `0x1` | `0x1` | `0x1` | `0x1` |
| `eip2930` | receipt | gasUsed | *unspecified* | `0x5b68` | `0x5b68` | `0x5b68` | `0x5b68` | `0x5b68` |
| `eip2930` | receipt | logs | *unspecified* | `0` | `0` | `0` | `0` | `0` |
| `eip2930` | receipt | contractAddress | *unspecified* | `null` | `null` | `null` | `null` | `null` |
| `eip2930` | receipt | fields | *unspecified* | `15 fields, also blockTimestamp:number` | `15 fields, also blockTimestamp:number` | `14 fields` | `14 fields` | `14 fields` |
| `eip2930` | receipt | effectiveGasPrice | `formula holds` | `formula holds` | `formula holds` | `formula holds` | `formula holds` | `formula holds` |
| `eip1559` | send | schema | `valid` | `valid` | `valid` | `valid` | `valid` | `valid` |
| `eip1559` | receipt | schema | `valid` | **`/ additionalProperties blockTimestamp (number)`** | **`/ additionalProperties blockTimestamp (number)`** | `valid` | `valid` | `valid` |
| `eip1559` | receipt | type | `0x2` | `0x2` | `0x2` | `0x2` | `0x2` | `0x2` |
| `eip1559` | receipt | status | `0x1` | `0x1` | `0x1` | `0x1` | `0x1` | `0x1` |
| `eip1559` | receipt | gasUsed | *unspecified* | `0x5208` | `0x5208` | `0x5208` | `0x5208` | `0x5208` |
| `eip1559` | receipt | logs | *unspecified* | `0` | `0` | `0` | `0` | `0` |
| `eip1559` | receipt | contractAddress | *unspecified* | `null` | `null` | `null` | `null` | `null` |
| `eip1559` | receipt | fields | *unspecified* | `15 fields, also blockTimestamp:number` | `15 fields, also blockTimestamp:number` | `14 fields` | `14 fields` | `14 fields` |
| `eip1559` | receipt | effectiveGasPrice | `formula holds` | `formula holds` | `formula holds` | `formula holds` | `formula holds` | `formula holds` |
| `logs` | emit receipt | schema | `valid` | **`/ additionalProperties blockTimestamp (number)`** | **`/ additionalProperties blockTimestamp (number)`** | `valid` | `valid` | `valid` |
| `logs` | emit receipt | type | `0x2` | `0x2` | `0x2` | `0x2` | `0x2` | `0x2` |
| `logs` | emit receipt | status | `0x1` | `0x1` | `0x1` | `0x1` | `0x1` | `0x1` |
| `logs` | emit receipt | gasUsed | *unspecified* | `0x563e` | `0x563e` | `0x563e` | `0x563e` | `0x563e` |
| `logs` | emit receipt | logs | *unspecified* | `1` | `1` | `1` | `1` | `1` |
| `logs` | emit receipt | contractAddress | *unspecified* | `null` | `null` | `null` | `null` | `null` |
| `logs` | emit receipt | fields | *unspecified* | `15 fields, also blockTimestamp:number` | `15 fields, also blockTimestamp:number` | `14 fields` | `14 fields` | `14 fields` |
| `logs` | emit receipt | topic | *unspecified* | `Ping(uint256)` | `Ping(uint256)` | `Ping(uint256)` | `Ping(uint256)` | `Ping(uint256)` |
| `logs` | getLogs | schema | `valid` | `valid` | `valid` | `valid` | `valid` | `valid` |
| `logs` | getLogs | count | *unspecified* | `1` | `1` | `1` | `1` | `1` |
| `logs` | getLogs | fields | *unspecified* | `10 fields` | `10 fields` | `10 fields` | `10 fields` | `10 fields` |
| `logs` | newFilter | schema | `valid` | `valid` | `valid` | `valid` | `valid` | `valid` |
| `logs` | getFilterLogs | schema | `valid` | `valid` | `valid` | `valid` | `valid` | `valid` |
| `logs` | getFilterLogs | count | *unspecified* | `1` | `1` | `1` | `1` | `1` |
| `logs` | uninstallFilter | schema | `valid` | `valid` | `valid` | `valid` | `valid` | `valid` |
| `revert-reason` | call | code | `3` | `3` | `3` | `3` | `3` | `3` |
| `revert-reason` | call | message | *unspecified* | `execution reverted: nope` | `execution reverted: nope` | `execution reverted: nope` | `VM Exception while processing transaction: reverted with reason string 'nope'` | `execution reverted: nope` |
| `revert-reason` | call | data | `0x08c379a0` | `0x08c379a0` | `0x08c379a0` | `0x08c379a0` | `0x08c379a0` | `0x08c379a0` |
| `revert-reason` | estimateGas | code | `3` | `3` | `3` | `3` | `3` | `3` |
| `revert-reason` | estimateGas | message | *unspecified* | `execution reverted: nope` | `execution reverted: nope` | `execution reverted: nope` | `VM Exception while processing transaction: reverted with reason string 'nope'` | `execution reverted: nope` |
| `revert-reason` | estimateGas | data | `0x08c379a0` | `0x08c379a0` | `0x08c379a0` | `0x08c379a0` | `0x08c379a0` | `0x08c379a0` |
| `revert-reason` | send receipt | schema | `valid` | **`/ additionalProperties blockTimestamp (number)`** | **`/ additionalProperties blockTimestamp (number)`** | `valid` | - | `valid` |
| `revert-reason` | send receipt | type | `0x2` | `0x2` | `0x2` | `0x2` | - | `0x2` |
| `revert-reason` | send receipt | status | `0x0` | `0x0` | `0x0` | `0x0` | - | `0x0` |
| `revert-reason` | send receipt | gasUsed | *unspecified* | `0x527b` | `0x527b` | `0x527b` | - | `0x527b` |
| `revert-reason` | send receipt | logs | *unspecified* | `0` | `0` | `0` | - | `0` |
| `revert-reason` | send receipt | contractAddress | *unspecified* | `null` | `null` | `null` | - | `null` |
| `revert-reason` | send receipt | fields | *unspecified* | `15 fields, also blockTimestamp:number` | `15 fields, also blockTimestamp:number` | `14 fields` | - | `14 fields` |
| `revert-reason` | send | code | *unspecified* | - | - | - | `3` | - |
| `revert-reason` | send | code in error groups | `listed` | - | - | - | `listed` | - |
| `revert-reason` | send | message | *unspecified* | - | - | - | `VM Exception while processing transaction: reverted with reason string 'nope'` | - |
| `revert-reason` | send | data | *unspecified* | - | - | - | `0x08c379a0 (100 bytes)` | - |
| `custom-error` | call | code | `3` | `3` | `3` | `3` | `3` | `3` |
| `custom-error` | call | message | *unspecified* | `execution reverted: custom error 0xcb362b34:` | `execution reverted: custom error 0xcb362b34:` | `execution reverted` | `VM Exception while processing transaction: reverted with an unrecognized custom error (return data: <hex>)` | `execution reverted` |
| `custom-error` | call | data | `0xcb362b34` | `0xcb362b34` | `0xcb362b34` | `0xcb362b34` | `0xcb362b34` | `0xcb362b34` |
| `out-of-gas` | send receipt | schema | `valid` | **`/ additionalProperties blockTimestamp (number)`** | **`/ additionalProperties blockTimestamp (number)`** | `valid` | - | `valid` |
| `out-of-gas` | send receipt | type | `0x2` | `0x2` | `0x2` | `0x2` | - | `0x2` |
| `out-of-gas` | send receipt | status | `0x0` | `0x0` | `0x0` | `0x0` | - | `0x0` |
| `out-of-gas` | send receipt | gasUsed | *unspecified* | `0xc350` | `0xc350` | `0xc350` | - | `0xc350` |
| `out-of-gas` | send receipt | logs | *unspecified* | `0` | `0` | `0` | - | `0` |
| `out-of-gas` | send receipt | contractAddress | *unspecified* | `null` | `null` | `null` | - | `null` |
| `out-of-gas` | send receipt | fields | *unspecified* | `15 fields, also blockTimestamp:number` | `15 fields, also blockTimestamp:number` | `14 fields` | - | `14 fields` |
| `out-of-gas` | send receipt | all gas used | *unspecified* | `yes` | `yes` | `yes` | - | `yes` |
| `out-of-gas` | estimateGas | code | *unspecified* | `-32003` | `-32003` | **`-32000`** (candidate: code) | `-32000` | **`-32003`** (candidate: code) |
| `out-of-gas` | estimateGas | message | *unspecified* | `Out of gas: gas required exceeds allowance: 100000` | `Out of gas: gas required exceeds allowance: 100000` | `gas required exceeds allowance (100000)` | `Transaction ran out of gas` | `out of gas: gas required exceeds: 100000` |
| `out-of-gas` | estimateGas | data | *unspecified* | `absent` | `absent` | `absent` | **`object`** (candidate: value) | `absent` |
| `out-of-gas` | send | code | *unspecified* | - | - | - | `-32000` | - |
| `out-of-gas` | send | code in error groups | `listed` | - | - | - | `listed` | - |
| `out-of-gas` | send | message | *unspecified* | - | - | - | `Transaction ran out of gas` | - |
| `out-of-gas` | send | data | *unspecified* | - | - | - | `object` | - |
| `estimate-gas` | transfer | schema | `valid` | `valid` | `valid` | `valid` | `valid` | `valid` |
| `estimate-gas` | transfer | value | *unspecified* | `0x5208` | `0x5208` | `0x5208` | **`0x5209`** (candidate: value) | `0x5208` |
| `fee-history` | feeHistory | schema | `valid` | `valid` | `valid` | `valid` | `valid` | `valid` |
| `fee-history` | feeHistory | baseFeePerGas length | `blocks + 1` | `blocks + 1` | `blocks + 1` | `blocks + 1` | `blocks + 1` | `blocks + 1` |
| `fee-history` | feeHistory | reward length | `blocks` | `blocks` | `blocks` | `blocks` | `blocks` | `blocks` |
| `fee-history` | feeHistory | blocks | *unspecified* | `4` | `4` | `4` | `4` | `4` |
| `fee-history` | feeHistory | fields | *unspecified* | `6 fields, also baseFeePerBlobGas:array, blobGasUsedRatio:array` | `6 fields, also baseFeePerBlobGas:array, blobGasUsedRatio:array` | `6 fields, also baseFeePerBlobGas:array, blobGasUsedRatio:array` | **`4 fields`** (candidate: field) | `6 fields, also baseFeePerBlobGas:array, blobGasUsedRatio:array` |
| `block-receipts` | blockReceipts | schema | `valid` | **`/0 additionalProperties blockTimestamp (number)`** | **`/0 additionalProperties blockTimestamp (number)`** | `valid` | *unsupported* | `valid` |
| `block-receipts` | blockReceipts | count | *unspecified* | `1` | `1` | `1` | *unsupported* | `1` |
| `block-receipts` | blockReceipts | same as eth_getTransactionReceipt | *unspecified* | `yes` | `yes` | `yes` | *unsupported* | `yes` |
| `block-receipts` | all | - | - | *run* | *run* | *run* | *unsupported* | *run* |
| `simulate` | simulate | schema | `valid` | `valid` | `valid` | `valid` | *unsupported* | `valid` |
| `simulate` | simulate | call status | *unspecified* | `0x1` | `0x1` | `0x1` | *unsupported* | `0x1` |
| `simulate` | all | - | - | *run* | *run* | *run* | *unsupported* | *run* |
| `trace` | trace | schema | `valid` | `valid` | `valid` | `valid` | `valid` | `valid` |
| `trace` | trace | gas | *unspecified* | `21000` | `21000` | `21000` | `21000` | `21000` |
| `trace` | trace | failed | *unspecified* | `false` | `false` | `false` | `false` | `false` |
| `trace` | trace | fields | *unspecified* | `4 fields` | `4 fields` | `4 fields` | `4 fields` | `4 fields` |
| `eip7702` | receipt | schema | `valid` | **`/ additionalProperties blockTimestamp (number)`** | **`/ additionalProperties blockTimestamp (number)`** | `valid` | `valid` | `valid` |
| `eip7702` | receipt | type | `0x4` | `0x4` | `0x4` | `0x4` | `0x4` | `0x4` |
| `eip7702` | receipt | status | `0x1` | `0x1` | `0x1` | `0x1` | `0x1` | `0x1` |
| `eip7702` | receipt | gasUsed | *unspecified* | `0x931f` | `0x931f` | `0x931f` | `0x931f` | `0x931f` |
| `eip7702` | receipt | logs | *unspecified* | `1` | `1` | `1` | `1` | `1` |
| `eip7702` | receipt | contractAddress | *unspecified* | `null` | `null` | `null` | `null` | `null` |
| `eip7702` | receipt | fields | *unspecified* | `15 fields, also blockTimestamp:number` | `15 fields, also blockTimestamp:number` | `14 fields` | `14 fields` | `14 fields` |
| `eip7702` | code | delegation | *unspecified* | `to the contract` | `to the contract` | `to the contract` | `to the contract` | `to the contract` |
| `eip4844` | send | wrapper accepted | *unspecified* | `v1` | `v1` | `v1` | **`v0`** (candidate: value) | `v1` |
| `eip4844` | receipt | schema | `valid` | **`/ additionalProperties blockTimestamp (number)`** | **`/ additionalProperties blockTimestamp (number)`** | `valid` | `valid` | `valid` |
| `eip4844` | receipt | type | `0x3` | `0x3` | `0x3` | `0x3` | `0x3` | `0x3` |
| `eip4844` | receipt | status | `0x1` | `0x1` | `0x1` | `0x1` | `0x1` | `0x1` |
| `eip4844` | receipt | gasUsed | *unspecified* | `0x5208` | `0x5208` | `0x5208` | `0x5208` | `0x5208` |
| `eip4844` | receipt | logs | *unspecified* | `0` | `0` | `0` | `0` | `0` |
| `eip4844` | receipt | contractAddress | *unspecified* | `null` | `null` | `null` | `null` | `null` |
| `eip4844` | receipt | blobGasUsed | *unspecified* | `0x20000` | `0x20000` | `0x20000` | - | `0x20000` |
| `eip4844` | receipt | fields | *unspecified* | `17 fields, also blobGasPrice:quantity, blobGasUsed:quantity, blockTimestamp:number` | `17 fields, also blobGasPrice:quantity, blobGasUsed:quantity, blockTimestamp:number` | `16 fields, also blobGasPrice:quantity, blobGasUsed:quantity` | **`14 fields`** (candidate: field) | `16 fields, also blobGasPrice:quantity, blobGasUsed:quantity` |
| `eip4844` | send v1 | code | *unspecified* | - | - | - | `-32602` | - |
| `eip4844` | send v1 | code in error groups | `listed` | - | - | - | `listed` | - |
| `eip4844` | send v1 | message | *unspecified* | - | - | - | `unexpected string` | - |
| `eip4844` | send v1 | data | *unspecified* | - | - | - | `object` | - |
| `invalid-input` | nonce too low | code | *unspecified* | **`-32003`** (candidate: code) | **`-32003`** (candidate: code) | `-32000` | `-32000` | `-32000` |
| `invalid-input` | nonce too low | code in error groups | `listed` | `listed` | `listed` | `listed` | `listed` | `listed` |
| `invalid-input` | nonce too low | message | *unspecified* | `nonce too low` | `nonce too low` | `nonce too low: next nonce 8, tx nonce 0` | `Nonce too low. Expected nonce to be 8 but got 0. Note that transactions can't be queued when automining.` | `nonce too low: next nonce 8, tx nonce 0` |
| `invalid-input` | nonce too low | data | *unspecified* | `absent` | `absent` | `absent` | **`object`** (candidate: value) | `absent` |
| `invalid-input` | underpriced | code | *unspecified* | **`-32003`** (candidate: code) | **`-32003`** (candidate: code) | - | `-32000` | `-32000` |
| `invalid-input` | underpriced | code in error groups | `listed` | `listed` | `listed` | - | `listed` | `listed` |
| `invalid-input` | underpriced | message | *unspecified* | `max fee per gas less than block base fee` | `max fee per gas less than block base fee` | - | `Transaction maxFeePerGas (1) is too low for the next block, which has a baseFeePerGas of 263482191` | `transaction underpriced` |
| `invalid-input` | underpriced | data | *unspecified* | `absent` | `absent` | - | **`object`** (candidate: value) | `absent` |
| `invalid-input` | bad params | code | `-32602` | `-32602` | `-32602` | `-32602` | `-32602` | `-32602` |
| `invalid-input` | bad params | message | *unspecified* | `invalid string length` | `invalid string length` | `invalid argument 0: json: cannot unmarshal hex string without 0x prefix into Go value of type common.Address` | `invalid value "nope" supplied to : ADDRESS at line 1 column 68` | `Invalid params` |
| `invalid-input` | bad params | data | *unspecified* | `absent` | `absent` | **`absent`** (candidate: value) | `object` | **`string`** (candidate: value) |
| `invalid-input` | unknown method | code | `-32601` | `-32601` | `-32601` | `-32601` | **`-32004`** (known: edr#1258) | `-32601` |
| `invalid-input` | unknown method | message | *unspecified* | `Method not found` | `Method not found` | `the method hashspan_unknownMethod does not exist/is not available` | `Method hashspan_unknownMethod is not supported` | `Method not found` |
| `invalid-input` | unknown method | data | *unspecified* | `absent` | `absent` | `absent` | **`object`** (candidate: value) | `absent` |
| `invalid-input` | underpriced | answer | *unspecified* | - | - | `accepted` | - | - |
| `concurrent-send` | sends | distinct nonces | `5` (foundry#17354) | `5` (foundry#17354: fixed here) | **`4`** (known: foundry#17354) | `5` (foundry#17354: fixed here) | `5` (foundry#17354: fixed here) | **`1`** (candidate: value) |

| Chain mode | Call | Field | Expected | Anvil nightly | Anvil | Hardhat (EDR) |
|---|---|---|---|---|---|---|
| `anvil-optimism` | receipt | L1 fee fields | *by design: optimism* | `none` | `none` | - |
| `anvil-optimism` | receipt | schema | `valid` | **`/ additionalProperties blockTimestamp (number)`** | **`/ additionalProperties blockTimestamp (number)`** | - |
| `anvil-optimism` | receipt | fields | *unspecified* | `15 fields` | `15 fields` | - |
| `hardhat-op` | L1Block | baseFeeScalar | `non-zero` (edr#1829) | - | - | `non-zero` (edr#1829: fixed here) |
| `hardhat-op` | L1Block | blobBaseFeeScalar | `non-zero` (edr#1829) | - | - | `non-zero` (edr#1829: fixed here) |
| `hardhat-op` | receipt | l1Fee | `non-zero` (edr#1829) | - | - | `non-zero` (edr#1829: fixed here) |
| `hardhat-op` | receipt | schema | `valid` | - | - | `valid` |
| `hardhat-op` | receipt | extension fields | *by design: op* | - | - | `l1BaseFeeScalar, l1BlobBaseFee, l1BlobBaseFeeScalar, l1Fee, l1GasPrice, l1GasUsed, operatorFeeConstant, operatorFeeScalar` |
| `hardhat-op` | receipt | fields | *unspecified* | - | - | `22 fields` |
| `anvil-tempo` | receipt | fee fields on 0x2 | `feePayer, feeToken` (real chain) | `feePayer, feeToken` | `feePayer, feeToken` | - |
| `anvil-tempo` | receipt | schema | `valid` | **`/ additionalProperties blockTimestamp (number)`** | **`/ additionalProperties blockTimestamp (number)`** | - |
| `anvil-tempo` | receipt | extension fields | *by design: tempo* | `feePayer, feeToken` | `feePayer, feeToken` | - |
| `anvil-tempo` | receipt | fields | *unspecified* | `17 fields` | `17 fields` | - |
| `anvil-celo` | send 0x7b | receipt type | `0x7b` (foundry#17462) | `0x7b` (foundry#17462: fixed here) | **`refused (-32602)`** (known: foundry#17462) | - |
| `anvil-celo` | receipt | schema | `valid` | **`/ additionalProperties blockTimestamp (number)`** | - | - |
| `anvil-celo` | receipt | extension fields | *by design: celo* | `feeCurrency` | - | - |
| `anvil-celo` | receipt | fields | *unspecified* | `16 fields` | - | - |

<!-- nodes:table:end -->
