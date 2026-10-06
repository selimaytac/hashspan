---
'@hashspan/viem': minor
---

A failed send now records, as `error.type` on the send span and on `blockchain.client.send.duration`, the error viem
classified the failure as, instead of the class of the error viem wraps it in. For example, a nonce already used was
recorded as `TransactionExecutionError` (`ContractFunctionExecutionError` for `writeContract`) and is now recorded as
`NonceTooLowError`; likewise `InsufficientFundsError`, `IntrinsicGasTooLowError`, `FeeCapTooLowError`, transport errors
such as `HttpRequestError` or `TimeoutError`, and for `sendUserOperation` the bundler error under the
`UserOperationExecutionError`. When viem classified nothing, the thrown class is recorded as before. `exception.type`
and the rethrown error are unchanged. Queries and dashboards that filter failed sends on the wrapper class need the new
values.
