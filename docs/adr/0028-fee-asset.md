# 0028. The asset a fee was paid in

- Status: accepted
- Date: 2026-10-06

## Context

`blockchain.tx.fee` is `gas.used × effective_gas_price + l1_fee`, as the receipt gives them. On some chains that
value is not in wei of the native currency, and nothing on the span says which asset it is in (#401):

- Celo, a type `0x7b` (CIP-64) transaction with a `feeCurrency`: the receipt's `effectiveGasPrice`, and so the fee,
  are in that fee currency. Only the transaction names it; the receipt does not. For 6-decimal tokens the fee
  currency is an 18-decimal adapter contract, not the token.
- Tempo, type `0x76`: the gas price is in attodollars (10^-18 USD) and the fee is charged in a token the receipt
  names as `feeToken`.
- Arc: gas is paid in its native currency, USDC with 18 decimals, so the chain id already says what the unit is.

The fee histogram `blockchain.client.fee` mixes these samples with native ones on the same chain. Converting them is
out of scope: hashspan records chain data, with no prices. The viem adapter's peer range starts at 2.21.0, and
`viem/tempo` exists only from 2.43.0.

## Decision

**Span attribute `blockchain.tx.fee_asset`** (string, confirm span): the contract address the fee was paid in, as
the chain reports it, so a Celo adapter address stays an adapter address. It follows the address mode, like
`blockchain.payment.asset`, and is absent when the fee is in the native currency. It is recorded with the receipt's
fee attributes, when `effective_gas_price` is. The name keeps `blockchain.tx.fee` a leaf: OpenTelemetry names must
not coincide with namespaces, and the conventions already write such names with an underscore (`l1_fee`,
`settled_amount`, `status_code`).

**Where the value comes from.** Both sources are untrusted (ADR 0025): each is read from own data properties only,
must be a 20-byte hex address, is lower-cased, and is dropped otherwise.

- Celo: the sending call's `feeCurrency`. The send's entry in the link store carries the validated, lower-cased
  string, never the call's object, so background confirmation and `watch()` on the same tracker record it.
- Tempo: the receipt's `feeToken`, read only from a receipt whose type is `0x76`. The filter is on the type, not on
  chain ids (Tempo's localnet uses 1337), and it fails closed: a receipt of any other type gets no asset.
- Core takes the value as new optional fields of its send and receipt inputs; a receipt's value wins over the send's.
  No adapter imports a chain module.
- A replacing transaction records its own asset: from its own send, or from the replacing transaction viem reports
  to `onReplaced`, never from the replaced one, since a speed-up may name another fee currency.

**Metric attribute `blockchain.fee.denomination`**, value `token`, on `blockchain.client.fee` samples whose fee was
paid in a token, that is, whose fee asset is known: a validated Celo fee currency, or a validated `feeToken` of a
`0x76` receipt. A `0x76` receipt with a missing or malformed `feeToken` records no asset and no marker. It is set from
the validated value before the address mode, so samples are marked in `off` mode too. It is absent for the native
currency, Arc's USDC included. Like `blockchain.fee.payer` (ADR 0020), it is a closed set and a constant, never an
address or a value read from the chain, and only the fee sample carries it. A sponsored Tempo fee can carry both.

**Privacy.** `blockchain.tx.fee_asset` is not one of the non-sensitive keys a failing `redact` hook keeps. The
hostile-input table gains rows for `feeCurrency` and `feeToken` with its shared address, and the new metric value
joins the closed sets it checks.

**Unchanged.** The metric unit stays `{wei}`, and no value is converted, rounded or formatted with token decimals.
The docs describe the fee attributes in "the chain's fee unit" rather than "wei", with fee table rows for Celo fee
currencies, Tempo and Arc. The recorded values do not change, and the docs already say they are not always in wei,
so this describes the existing meaning rather than changing it in place (ADR 0027).

## Consequences

- Both names are additions, a minor change under the change policy of ADR 0027. The attribute's form is an address
  under the address mode; the metric value set is `token`.
- Dashboards separate token-paid fees by `blockchain.fee.denomination`, as they separate fees others paid by
  `blockchain.fee.payer`; samples with neither are fees the sender paid in the native currency.
- A Celo transaction sent elsewhere and confirmed with `watch()` without a call is recorded in its fee currency with
  no asset and no marker, so its sample counts as native. Reading the transaction would cost an
  `eth_getTransactionByHash` per confirmation, which hashspan does not add. A future `watch()` option or raw
  transaction parser that supplies the value goes through the same validation.
- A raw `0x7b` transaction (`sendRawTransaction`) records no asset; a raw `0x76` one gets it from its receipt.
- Tempo's sponsored fees, pending receipts and `calls` lists are #402.
- `@hashspan/cdp` and `@hashspan/x402` are unchanged; they can pass the same core fields when a network they support
  charges fees in a token.

## Amendment (2026-10-18, proposed): Tempo receipts of any type

On Tempo every transaction pays its fee in a token, not only type `0x76` (#429). A plain EIP-1559 (`0x2`) or legacy
(`0x0`) transaction's receipt names `feeToken` and `feePayer` too, and its `effectiveGasPrice` is in attodollars as
well; viem sends `0x2` on its Tempo chains unless the call or the chain names a fee token. Read only from `0x76`
receipts, such a fee was recorded with no asset and its sample counted as native.

- The viem adapter reads the `feeToken` of a receipt whose type is `0x76`, as before, or of a receipt of any other
  type whose own data properties also include a `feePayer` that is a 20-byte hex address. Tempo's RPC receipt carries
  both fields on every receipt; no other chain the adapter knows of names either. The rule still takes no chain id
  and no chain module, and `feeToken` is validated as before (ADR 0025). A receipt with a `feeToken` but no valid
  `feePayer` records no asset and no marker (fails closed).
- `blockchain.tx.fee_asset` and `blockchain.fee.denomination` keep their meaning: the token the fee was paid in, and
  the marker of a fee whose asset is known. They are now recorded for more Tempo fees, which were recorded as paid in
  the native currency before.
- The sponsored fee of ADR 0020 and pending receipts (#402) stay on type `0x76`: only that type can have a fee payer
  other than the sender or a multisig operation, so reading `feePayer` from other types would add no value.
- A node that names both fields on a receipt whose fee was native would have it marked `token`. The marker is a
  constant and the address passes the same validation and address mode, so no unbounded value reaches telemetry.
