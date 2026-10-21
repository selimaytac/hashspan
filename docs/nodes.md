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

No results yet: the first lab run of the matrix writes them.

<!-- nodes:table:end -->
