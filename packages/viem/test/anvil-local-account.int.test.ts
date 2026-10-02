import { SpanStatusCode } from '@opentelemetry/api';
import { Instance } from 'prool';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeErrorResult,
  getAddress,
  type Hex,
  http,
  parseAbi,
  toHex,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type WithHashspanOptions, withHashspan } from '../src/index.js';
import { setupTracing, type TestTracing } from './tracing.js';

const PORT = 18547;
const RPC_URL = `http://127.0.0.1:${PORT}`;
/** Anvil's public default mnemonic; its first account is funded on every Anvil chain. */
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
// A local account signs in-process, unlike the unlocked JSON-RPC accounts of the other Anvil tests.
const signer = privateKeyToAccount(
  toHex(mnemonicToAccount(ANVIL_MNEMONIC).getHdKey().privateKey as Uint8Array),
);

const RECIPIENT = '0x00000000000000000000000000000000000000cc' as const;
const PANICS = '0x00000000000000000000000000000000000000d1' as const;
const BLOCKS = '0x00000000000000000000000000000000000000d2' as const;
const REJECTS = '0x00000000000000000000000000000000000000d3' as const;
const RAMBLES = '0x00000000000000000000000000000000000000d4' as const;

const vault = parseAbi([
  'function withdraw(uint256 amount)',
  'error Blocked(address account)',
  'error Rejected((address to, uint256 amount) order, uint256[] codes)',
]);
const LONG_MESSAGE = 'x'.repeat(1_100);

/** Runtime bytecode that stores `payload` in memory and reverts with it; PUSH2 offsets allow long payloads. */
function revertingWith(payload: Hex): Hex {
  const bytes = payload.slice(2);
  const size = bytes.length / 2;
  const push2 = (n: number) => `61${n.toString(16).padStart(4, '0')}`;
  let code = '';
  for (let offset = 0; offset < size; offset += 32) {
    const word = bytes.slice(offset * 2, offset * 2 + 64).padEnd(64, '0');
    code += `7f${word}${push2(offset)}52`; // PUSH32 word, PUSH2 offset, MSTORE
  }
  return `0x${code}${push2(size)}6000fd`; // PUSH2 size, PUSH1 0, REVERT
}

const instance = Instance.anvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
  port: PORT,
});

let tracing: TestTracing;

beforeAll(async () => {
  await instance.start();
  const client = createPublicClient({ chain: anvil, transport: http(RPC_URL) });
  const setCode = (address: Address, payload: Hex) =>
    client.request({
      method: 'anvil_setCode' as never,
      params: [address, revertingWith(payload)] as never,
    });
  await setCode(
    PANICS,
    encodeErrorResult({
      abi: parseAbi(['error Panic(uint256)']),
      errorName: 'Panic',
      args: [0x11n],
    }),
  );
  await setCode(
    BLOCKS,
    encodeErrorResult({ abi: vault, errorName: 'Blocked', args: [signer.address] }),
  );
  await setCode(
    REJECTS,
    encodeErrorResult({
      abi: vault,
      errorName: 'Rejected',
      args: [{ to: RECIPIENT, amount: 5n }, [1n, 2n]],
    }),
  );
  await setCode(
    RAMBLES,
    encodeErrorResult({
      abi: parseAbi(['error Error(string)']),
      errorName: 'Error',
      args: [LONG_MESSAGE],
    }),
  );
});
afterAll(async () => {
  await instance.stop();
});
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const clients = (options: WithHashspanOptions = {}) => {
  const hashspan = withHashspan(options);
  return {
    hashspan,
    wallet: createWalletClient({ account: signer, chain: anvil, transport: http(RPC_URL) }).extend(
      hashspan,
    ),
    reader: createPublicClient({ chain: anvil, transport: http(RPC_URL) }).extend(hashspan),
  };
};

/** Sends a transaction that is mined although it reverts, and returns its confirm span. */
const revertOf = async (
  send: (c: ReturnType<typeof clients>) => Promise<Hex>,
  options: WithHashspanOptions = {},
) => {
  const c = clients(options);
  const hash = await send(c);
  const receipt = await c.reader.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('reverted');
  await c.hashspan.flush();
  return tracing.spanNamed('confirm 31337');
};

describe('a local account', () => {
  it('is traced from send to confirmation', async () => {
    const { hashspan, wallet, reader } = clients();
    const hash = await wallet.sendTransaction({ to: RECIPIENT, value: 1n });
    await reader.waitForTransactionReceipt({ hash });
    await hashspan.flush();

    expect(tracing.spanNamed('send 31337').attributes).toMatchObject({
      'blockchain.tx.hash': hash,
      'blockchain.tx.from': signer.address.toLowerCase(),
      'blockchain.tx.to': RECIPIENT.toLowerCase(),
    });
    expect(tracing.spanNamed('confirm 31337').attributes['blockchain.tx.status']).toBe('success');
  });

  it('records the sender per address mode', async () => {
    const sender = async (address: 'off' | 'hashed') => {
      tracing.exporter.reset();
      await clients({ address }).wallet.sendTransaction({ to: RECIPIENT, value: 1n });
      return tracing.spanNamed('send 31337').attributes['blockchain.tx.from'];
    };
    expect(await sender('off')).toBeUndefined();
    expect(await sender('hashed')).toMatch(/^sha256:[0-9a-f]{32}$/);
  });
});

describe('revert reasons decoded through viem', () => {
  const gas = 200_000n;

  it('records a panic code', async () => {
    const confirm = await revertOf(({ wallet }) => wallet.sendTransaction({ to: PANICS, gas }));
    expect(confirm.status.code).toBe(SpanStatusCode.ERROR);
    expect(confirm.attributes['blockchain.tx.revert.reason']).toBe('Panic(0x11)');
  });

  it("writes a custom error's address argument per address mode", async () => {
    const withdraw = ({ wallet }: ReturnType<typeof clients>) =>
      wallet.writeContract({
        address: BLOCKS,
        abi: vault,
        functionName: 'withdraw',
        args: [1n],
        gas,
      });
    const off = await revertOf(withdraw, { address: 'off' });
    expect(off.attributes['blockchain.tx.revert.reason']).toBe('Blocked(<address>)');
  });

  it('formats tuple and array arguments', async () => {
    const confirm = await revertOf(({ wallet }) =>
      wallet.writeContract({
        address: REJECTS,
        abi: vault,
        functionName: 'withdraw',
        args: [1n],
        gas,
      }),
    );
    expect(confirm.attributes['blockchain.tx.revert.reason']).toBe(
      `Rejected({"to":"${getAddress(RECIPIENT)}","amount":"5"}, [1, 2])`,
    );
  });

  it('truncates a reason longer than 1024 characters', async () => {
    const confirm = await revertOf(({ wallet }) => wallet.sendTransaction({ to: RAMBLES, gas }));
    expect(confirm.attributes['blockchain.tx.revert.reason']).toBe(`${'x'.repeat(1_024)}...`);
  });
});
