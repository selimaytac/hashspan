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
  | 'sendRawTransaction'
  | 'sendRawTransactionSync'
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
   * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.2.1/docs/adr/0017-x402-payment-verification.md.
   */
  onReceipt?: ((receipt: TransactionReceipt | undefined) => void) | undefined;
}

/**
 * Options of `watchUserOperation()`: a user operation known by its hash, confirmed through a bundler client
 * (`eth_getUserOperationReceipt`).
 */
export interface WatchUserOperationByHashOptions {
  /** The user operation hash. */
  userOpHash: string;
  /** Not given with a user operation hash alone; see {@link WatchUserOperationInBundleOptions}. */
  bundleHash?: undefined;
  /** Not given with a user operation hash alone. */
  sender?: undefined;
  /** Not given with a user operation hash alone. */
  nonce?: undefined;
  /**
   * EIP-155 chain id; defaults to the client's chain, or to the chain of the client a bundler client was created
   * with. Without either, the client is asked with `eth_chainId`; when it differs, nothing is recorded and a `diag`
   * warning is logged.
   */
  chainId?: number | undefined;
  /** How long to poll for the receipt before the confirm span ends as `timeout`. Default: 120 000 ms. */
  timeoutMs?: number | undefined;
}

/**
 * Options of `watchUserOperation()`: a user operation known by the hash of the bundle transaction that included it and
 * by its smart account, found in that transaction's receipt (`eth_getTransactionReceipt`) by its `UserOperationEvent`.
 */
export interface WatchUserOperationInBundleOptions {
  /** Hash of the bundle transaction, such as the hash a smart account SDK's `sendTransaction` returns. */
  bundleHash: string;
  /** Address of the smart account that sent the operation. */
  sender: string;
  /**
   * The operation's nonce, to tell apart several operations of the sender in one bundle: without it, a bundle with
   * more than one records nothing. A bigint, a safe integer, or a decimal or `0x` hex string.
   */
  nonce?: bigint | number | string | undefined;
  /** The user operation hash, when it is known as well: the event must then carry it. */
  userOpHash?: string | undefined;
  /**
   * EIP-155 chain id; defaults to the client's chain. Without either, the client is asked with `eth_chainId`; when it
   * differs, nothing is recorded and a `diag` warning is logged.
   */
  chainId?: number | undefined;
  /**
   * How long to poll for the bundle receipt. Default: 120 000 ms. The operation's hash comes from the receipt, so
   * when none came in time, nothing is recorded.
   */
  timeoutMs?: number | undefined;
}

/** Options of `watchUserOperation()`: the user operation to confirm, by its hash or in its bundle transaction. */
export type WatchUserOperationOptions =
  | WatchUserOperationByHashOptions
  | WatchUserOperationInBundleOptions;
