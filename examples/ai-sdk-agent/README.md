# Example: AI SDK agent with traced transactions

A treasury agent built with the [AI SDK](https://ai-sdk.dev) whose tools send transactions with viem. With
`@hashspan/viem`, every transaction shows up inside the agent's trace:

```
invoke_agent                       gen_ai.agent.name=treasury-agent
├─ step 1
│  └─ execute_tool pay_vendor
│     ├─ send 31337                blockchain.tx.value=250000000000000000
│     └─ confirm 31337             blockchain.tx.status=success, blockchain.tx.fee=...
└─ step 2
   └─ execute_tool withdraw_from_vault
      ├─ send 31337                blockchain.contract.function.name=withdraw
      └─ confirm 31337             blockchain.tx.status=reverted
                                   blockchain.tx.revert.reason=WithdrawalLimitExceeded(100000000000000000, 1000000000000000000)
```

![The example agent's trace in Jaeger](../../docs/images/jaeger-trace.png)

It runs offline and needs no API key: a scripted model makes the tool calls, and the transactions go to a local
Anvil chain.

## Run it

From the repository root:

```sh
make lab-up   # Jaeger UI on http://localhost:16686
make demo     # starts a local chain, runs the agent, stops the chain
```

`make demo` needs port 8545 to be free: it starts its own chain there and fails if something already listens on it
(such as a running `make anvil`).

Open Jaeger, pick the service `treasury-agent` and open the trace. To print spans instead, run
`OTEL_TRACES_EXPORTER=console make demo`. The setup reads the standard OpenTelemetry variables:
`OTEL_SERVICE_NAME=my-agent make demo` files the trace under `my-agent`, and `OTEL_EXPORTER_OTLP_ENDPOINT` sends it
to another backend.

## How it is wired

| File | What it shows |
|---|---|
| [`src/telemetry.ts`](src/telemetry.ts) | A standard OpenTelemetry SDK setup plus the AI SDK's OpenTelemetry integration |
| [`src/chain.ts`](src/chain.ts) | One `withHashspan()` result shared by the wallet and public client |
| [`src/tools.ts`](src/tools.ts) | Plain AI SDK tools calling `sendTransaction`, `writeContract` and `waitForTransactionReceipt` |
| [`src/demo.ts`](src/demo.ts) | The agent run, and `hashspan.flush()` before the process exits |
| [`src/model.ts`](src/model.ts) | The scripted model standing in for an LLM |

The tools contain no tracing code: the AI SDK runs each tool inside its `execute_tool` span, so the transaction
spans become its children.

To use a real model, replace `scriptedModel()` in `src/demo.ts` with any AI SDK model, for example
`openai('...')` from `@ai-sdk/openai` with `OPENAI_API_KEY` set.

The demo vault is installed on the local chain with `anvil_setCode` and rejects every withdrawal, to show a
reverted transaction. The wallet is Anvil's first test account, which Anvil signs for, so the example holds no
private key.
