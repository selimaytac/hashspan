# 0028. The asset a fee was paid in

- Status: proposed
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
paid in a token: every `0x76` receipt, and every transaction with a validated fee currency. It is set from the
validated value before the address mode, so samples are marked in `off` mode too. It is absent for the native
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
