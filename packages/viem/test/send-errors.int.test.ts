// Failed sends on Anvil: `error.type` is the error viem classified the node's answer as (hashspan #407), on the send
// span and on `blockchain.client.send.duration`, while the exception event keeps the class viem threw.
import { createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordingMeterProvider } from '../../core/test/hostile.js';
import { withHashspan } from '../src/index.js';
import { startAnvil } from './start-anvil.js';
import { setupTracing, type TestTracing } from './tracing.js';

const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
// Anvil's second well-known test account, so that the nonces here are this file's own.
const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

const { instance, rpcUrl: RPC_URL } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
});

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});
afterAll(async () => {
  await instance.stop();
});

/** Runs `send` on a traced wallet; returns the rejection, the send span and the send duration samples. */
async function failedSend(
  send: (wallet: ReturnType<typeof walletOf>) => Promise<unknown>,
): Promise<{ thrown: Error; errorType: unknown; exceptionType: unknown; metric: unknown[] }> {
  const meters = recordingMeterProvider();
  const wallet = walletOf(meters.provider);
  const thrown = (await send(wallet).then(
    () => {
      throw new Error('the send did not fail');
    },
    (error: unknown) => error,
  )) as Error;
  const span = tracing.spanNamed('send 31337');
  return {
    thrown,
    errorType: span.attributes['error.type'],
    exceptionType: span.events.find((e) => e.name === 'exception')?.attributes?.['exception.type'],
    metric: meters
      .samples()
      .filter((s) => s.name === 'blockchain.client.send.duration')
      .map((s) => s.attributes['error.type']),
  };
}

const walletOf = (meterProvider: ReturnType<typeof recordingMeterProvider>['provider']) =>
  createWalletClient({ account, chain: anvil, transport: http(RPC_URL) }).extend(
    withHashspan({ meterProvider }),
  );

describe('a failed send on Anvil', () => {
  it('records NonceTooLowError for a nonce already used', async () => {
    await walletOf(recordingMeterProvider().provider).sendTransaction({ to: RECIPIENT, value: 1n });
    tracing.exporter.reset();

    const failed = await failedSend((wallet) =>
      wallet.sendTransaction({ to: RECIPIENT, value: 1n, nonce: 0 }),
    );
    expect(failed.thrown.name).toBe('TransactionExecutionError');
    expect(failed).toMatchObject({
      errorType: 'NonceTooLowError',
      exceptionType: 'TransactionExecutionError',
      metric: ['NonceTooLowError'],
    });
  });

  it('records InsufficientFundsError for a value above the balance', async () => {
    const failed = await failedSend((wallet) =>
      wallet.sendTransaction({ to: RECIPIENT, value: 10n ** 30n }),
    );
    expect(failed).toMatchObject({
      errorType: 'InsufficientFundsError',
      exceptionType: 'TransactionExecutionError',
      metric: ['InsufficientFundsError'],
    });
  });

  it('records IntrinsicGasTooLowError for a gas limit below the intrinsic gas', async () => {
    const failed = await failedSend((wallet) =>
      wallet.sendTransaction({ to: RECIPIENT, value: 1n, gas: 1_000n }),
    );
    expect(failed).toMatchObject({
      errorType: 'IntrinsicGasTooLowError',
      exceptionType: 'TransactionExecutionError',
      metric: ['IntrinsicGasTooLowError'],
    });
  });

  it('records the classified error under both wrappers of writeContract', async () => {
    const failed = await failedSend((wallet) =>
      wallet.writeContract({
        address: RECIPIENT,
        abi: parseAbi(['function ping()']),
        functionName: 'ping',
        nonce: 0,
      }),
    );
    expect(failed.thrown.name).toBe('ContractFunctionExecutionError');
    expect(failed).toMatchObject({
      errorType: 'NonceTooLowError',
      exceptionType: 'ContractFunctionExecutionError',
      metric: ['NonceTooLowError'],
    });
  });
});
