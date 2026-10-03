// Public types that the extension's modules share; `index.ts` exports them, so no module imports the entry point.
import type { Abi, TransactionReceipt } from 'viem';

export interface BackgroundConfirmOptions {
  /** Confirm every transaction sent through the extended clients, whether or not the caller waits for it. */
  mode: 'background';
  /** How long to poll for a receipt before ending the confirm span as `timeout`. Default: 120 000 ms. */
  timeoutMs?: number | undefined;
}

/**
 * Actions this adapter traces: those of a wallet client, two of a bundler client (`createBundlerClient`), and the
 * EIP-5792 call batch actions of a wallet client.
 */
export type TracedAction =
  | 'sendTransaction'
  | 'writeContract'
  | 'waitForTransactionReceipt'
  | 'sendUserOperation'
  | 'waitForUserOperationReceipt'
  | 'sendCalls'
  | 'sendCallsSync'
  | 'waitForCallsStatus';

// biome-ignore lint/suspicious/noExplicitAny: viem action signatures are preserved via Pick<TClient, ...>.
export type AnyAction = (args: any) => Promise<any>;

/** The client's own actions `K`, as a send path wraps them; absent from a client that lacks them. */
export type BaseActions<K extends TracedAction> = { [P in K]?: AnyAction | undefined };

/** The subset of a viem client the adapter relies on. */
export interface ViemClientLike {
  chain?: { id: number } | undefined;
  account?: { address: string } | undefined;
  uid?: string | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: matches viem's overloaded EIP-1193 request function.
  request: (...args: any[]) => Promise<any>;
}

export interface FlushOptions {
  /** Longest time to wait. Default: 10 000 ms. */
  timeoutMs?: number | undefined;
}

export interface WatchOptions {
  /** Transaction hash. */
  hash: string;
  /**
   * EIP-155 chain id; defaults to the client's chain. Without either, nothing is recorded; when it differs from the
   * client's chain, nothing is recorded either and a `diag` warning is logged. A client without a chain is asked
   * for its chain id with `eth_chainId` first.
   */
  chainId?: number | undefined;
  /** How long to poll for the receipt before the confirm span ends as `timeout`. Default: 120 000 ms. */
  timeoutMs?: number | undefined;
  /** ABI of the called contract, to decode custom errors in the revert reason. */
  abi?: Abi | undefined;
  /**
   * Called once when the watch ends: with the receipt of the mined transaction (of a replacing transaction, if one
   * was mined instead), or with `undefined` when no receipt was retrieved (timeout, failure, or nothing watched). Its
   * result and errors are ignored; it never affects the confirm span. See
   * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.9.0/docs/adr/0017-x402-payment-verification.md.
   */
  onReceipt?: ((receipt: TransactionReceipt | undefined) => void) | undefined;
}
