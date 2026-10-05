// Public types that the extension's modules share; `index.ts` exports them, so no module imports the entry point.
import type { Abi, TransactionReceipt } from 'viem';

/** The `confirm` option of {@link withHashspan}: confirm transactions in the background. */
export interface BackgroundConfirmOptions {
  /** Confirm every transaction sent through the extended clients, whether or not the caller waits for it. */
  mode: 'background';
  /** How long to poll for a receipt before ending the confirm span as `timeout`. Default: 120 000 ms. */
  timeoutMs?: number | undefined;
}

/**
 * Actions this adapter traces: those of a wallet client (with the sync forms of viem 2.38.0), two of a bundler client (`createBundlerClient`), and the
 * EIP-5792 call batch actions of a wallet client.
 */
export type TracedAction =
  | 'sendTransaction'
  | 'writeContract'
  | 'sendTransactionSync'
  | 'writeContractSync'
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
  /** The client's chain; its id is the chain id of what is sent through the client. */
  chain?: { id: number } | undefined;
  /** The client's account; its address is the sender when a call names no account. */
  account?: { address: string } | undefined;
  /** viem's unique id of the client. */
  uid?: string | undefined;
  /** The client's EIP-1193 request function. */
  // biome-ignore lint/suspicious/noExplicitAny: matches viem's overloaded EIP-1193 request function.
  request: (...args: any[]) => Promise<any>;
}

/** Options of `flush()`. */
export interface FlushOptions {
  /** Longest time to wait. Default: 10 000 ms. */
  timeoutMs?: number | undefined;
}

/** Options of `watch()` of the extension: the transaction to confirm. */
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
   * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.11.0/docs/adr/0017-x402-payment-verification.md.
   */
  onReceipt?: ((receipt: TransactionReceipt | undefined) => void) | undefined;
}
