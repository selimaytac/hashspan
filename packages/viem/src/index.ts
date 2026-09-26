import {
  type ConfirmHandle,
  createTxTracker,
  type ReceiptLike,
  type SendHandle,
  type SendInput,
  type TxTracker,
  type TxTrackerOptions,
} from '@hashspan/core';
import { diag } from '@opentelemetry/api';
import { type Abi, getAbiItem, toFunctionSelector } from 'viem';

export interface WithHashspanOptions extends TxTrackerOptions {
  /**
   * Tracker to report to. Defaults to one tracker per `withHashspan()` call, so reuse the same
   * `withHashspan()` result for a wallet client and a public client to link sends to confirmations.
   */
  tracker?: TxTracker | undefined;
}

/** Actions this adapter traces. */
export type TracedAction = 'sendTransaction' | 'writeContract' | 'waitForTransactionReceipt';

// biome-ignore lint/suspicious/noExplicitAny: viem action signatures are preserved via Pick<TClient, ...>.
type AnyAction = (args: any) => Promise<any>;

/** The subset of a viem client the adapter relies on. */
export interface ViemClientLike {
  chain?: { id: number } | undefined;
  account?: { address: string } | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: matches viem's overloaded EIP-1193 request function.
  request: (...args: any[]) => Promise<any>;
}

/** Client extension returned by {@link withHashspan}: the traced actions present on the client. */
export type HashspanExtension = <TClient extends ViemClientLike>(
  client: TClient,
) => Pick<TClient, Extract<keyof TClient, TracedAction>>;

const NOOP_SEND: SendHandle = { end: () => {}, fail: () => {} };
const NOOP_CONFIRM: ConfirmHandle = { end: () => {}, timeout: () => {}, fail: () => {} };

interface SendArgs {
  account?: string | { address: string } | null | undefined;
  chain?: { id: number } | null | undefined;
  to?: string | null | undefined;
  value?: bigint | undefined;
  nonce?: number | undefined;
  data?: string | undefined;
}

interface WriteContractArgs extends SendArgs {
  address: string;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[] | undefined;
}

interface WaitArgs {
  hash: string;
  chain?: { id: number } | null | undefined;
}

interface ViemReceipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice?: bigint | undefined;
  l1Fee?: bigint | string | null | undefined;
}

function selectorOf(data: string | undefined): string | undefined {
  return data && data.length >= 10 ? data.slice(0, 10) : undefined;
}

function addressOf(account: string | { address: string } | null | undefined): string | undefined {
  if (!account) return undefined;
  return typeof account === 'string' ? account : account.address;
}

/** Normalises a viem receipt; `l1Fee` is a bigint with the OP-stack formatter, else a raw hex string. */
function toReceiptLike(receipt: ViemReceipt): ReceiptLike {
  const { l1Fee } = receipt;
  return {
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    l1Fee: typeof l1Fee === 'string' ? BigInt(l1Fee) : l1Fee,
  };
}

/**
 * viem client extension that traces transactions with `@hashspan/core`:
 * `client.extend(withHashspan())`. Apply it after other extensions such as `publicActions`,
 * which would otherwise replace the traced actions.
 */
export function withHashspan(options: WithHashspanOptions = {}): HashspanExtension {
  const { tracker: providedTracker, ...trackerOptions } = options;
  const tracker = providedTracker ?? createTxTracker(trackerOptions);
  const chainIds = new WeakMap<object, Promise<number>>();

  const extension = (client: ViemClientLike & Partial<Record<TracedAction, AnyAction>>) => {
    const chainIdFor = async (args: {
      chain?: { id: number } | null | undefined;
    }): Promise<number> => {
      const known = args.chain?.id ?? client.chain?.id;
      if (known !== undefined) return known;
      let pending = chainIds.get(client);
      if (!pending) {
        pending = client.request({ method: 'eth_chainId' }).then((hex: string) => Number(hex));
        pending.catch(() => chainIds.delete(client));
        chainIds.set(client, pending);
      }
      return pending;
    };

    const traceSend = async (
      describe: () => Promise<SendInput>,
      send: () => Promise<string>,
    ): Promise<string> => {
      let handle = NOOP_SEND;
      try {
        handle = tracker.startSend(await describe());
      } catch (error) {
        diag.error('hashspan: failed to start send span', error);
      }
      try {
        const hash = await send();
        handle.end(hash);
        return hash;
      } catch (error) {
        handle.fail(error);
        throw error;
      }
    };

    const sendInput = async (
      args: SendArgs,
      to: string | null | undefined,
    ): Promise<SendInput> => ({
      chainId: await chainIdFor(args),
      from: addressOf(args.account ?? client.account),
      to: to ?? undefined,
      value: args.value,
      nonce: args.nonce,
    });

    const actions: Partial<Record<TracedAction, AnyAction>> = {};
    const { sendTransaction, writeContract, waitForTransactionReceipt } = client;

    if (typeof sendTransaction === 'function') {
      actions.sendTransaction = (args: SendArgs) =>
        traceSend(
          async () => ({
            ...(await sendInput(args, args.to)),
            functionSelector: selectorOf(args.data),
          }),
          () => sendTransaction(args),
        );
    }

    if (typeof writeContract === 'function') {
      actions.writeContract = (args: WriteContractArgs) =>
        traceSend(
          async () => {
            let functionSelector: string | undefined;
            try {
              const item = getAbiItem({
                abi: args.abi,
                name: args.functionName,
                args: args.args,
              } as never);
              functionSelector = item ? toFunctionSelector(item as never) : undefined;
            } catch {
              // Unknown or ambiguous ABI item: record the function name only.
            }
            return {
              ...(await sendInput(args, args.address)),
              functionName: args.functionName,
              functionSelector,
            };
          },
          () => writeContract(args),
        );
    }

    if (typeof waitForTransactionReceipt === 'function') {
      actions.waitForTransactionReceipt = async (args: WaitArgs) => {
        let handle = NOOP_CONFIRM;
        try {
          handle = tracker.startConfirm({ chainId: await chainIdFor(args), hash: args.hash });
        } catch (error) {
          diag.error('hashspan: failed to start confirm span', error);
        }
        try {
          const receipt = await waitForTransactionReceipt(args);
          try {
            handle.end(toReceiptLike(receipt));
          } catch (error) {
            diag.error('hashspan: failed to read receipt', error);
            handle.end(receipt);
          }
          return receipt;
        } catch (error) {
          if (error instanceof Error && error.name === 'WaitForTransactionReceiptTimeoutError') {
            handle.timeout();
          } else {
            handle.fail(error);
          }
          throw error;
        }
      };
    }

    return actions;
  };

  return extension as HashspanExtension;
}
