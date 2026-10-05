// Tracing a send: the send span around the call, or, while the chain id is unknown, recorded once it is known.
import { type Context, context, diag } from '@opentelemetry/api';
import { own } from './arguments.js';
import { chainIdOrGiveUp, isChainId } from './confirm/timing.js';
import { errorName } from './safe-tracker.js';
import type { ViemClientLike } from './types.js';

export interface SendArgs {
  account?: string | { address: string } | null | undefined;
  chain?: { id: number } | null | undefined;
  to?: string | null | undefined;
  value?: bigint | undefined;
  nonce?: number | undefined;
  data?: string | undefined;
}

/**
 * A started send span, of a transaction, a user operation or a call batch, as `traceSend` ends it; `R` is what the
 * call returned: a hash, or a call batch's result.
 */
export interface StartedSend<R = string> {
  context: Context;
  end(result: R, endTime?: Date): void;
  fail(error: unknown, endTime?: Date): void;
}

/** How `traceSend` records one kind of send: a transaction, a user operation or a call batch. */
export interface SendTrace<R = string> {
  /**
   * The chain id when it is known before the call, undefined when it is not, or null when the call names a chain
   * whose id is not one, so the call is not traced. Reads the call's arguments, so it may throw.
   */
  chainId(): number | null | undefined;
  /** Starts the send span, in the active context. */
  start(chainId: number, startTime?: Date): StartedSend<R>;
  /** Work after a successful send. */
  after(chainId: number, result: R): void;
}

/** Send tracing of one extended client, shared by its traced actions. */
export interface SendTracing {
  /**
   * The chain id of a call: its `chain` argument, else the client's chain; null when the call's `chain` names an id
   * that is not a chain id, so the call is not traced.
   */
  knownChainId(args: { chain?: { id: number } | null | undefined }): number | null | undefined;
  /** Asks a client without a chain for its chain id; concurrent calls share one request. */
  queryChainId(): Promise<number>;
  traceSend<R>(sendTrace: SendTrace<R>, send: () => Promise<R>): Promise<R>;
  /** Logs that reading the call's arguments for telemetry threw; the caller then makes the call untraced. */
  untraced(error: unknown): void;
}

export function createSendTracing(
  client: ViemClientLike,
  track: (work: Promise<void>) => void,
): SendTracing {
  const knownChainId = (args: {
    chain?: { id: number } | null | undefined;
  }): number | null | undefined => {
    const id = own(own(args, 'chain'), 'id');
    // A chain the call names with an id that is not one is not replaced by the client's: the span would be recorded
    // for a chain the call did not send on. Such a call is not traced (ADR 0025 rule 3).
    if (id !== undefined) return isChainId(id) ? id : null;
    const clientId = client.chain?.id;
    return isChainId(clientId) ? clientId : undefined;
  };

  /**
   * Asks a client without a chain for its chain id. Concurrent calls share one request; the answer is not cached,
   * since a wallet can switch networks. Callers never await it before the call they trace
   * (https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.12.0/docs/adr/0009-telemetry-off-the-call-path.md).
   */
  let pendingChainId: Promise<number> | undefined;
  const queryChainId = (): Promise<number> => {
    if (!pendingChainId) {
      const query = Promise.resolve()
        .then(() => client.request({ method: 'eth_chainId' }))
        .then((hex: string) => {
          const id = Number(hex);
          if (!isChainId(id)) throw new TypeError('invalid chain id');
          return id;
        });
      pendingChainId = query;
      const clear = (): void => {
        if (pendingChainId === query) pendingChainId = undefined;
      };
      query.then(clear, clear);
    }
    return pendingChainId;
  };

  /**
   * Records a send whose chain id was unknown when it started, once the chain id is known: same parent context,
   * start and end time as the call. Never rejects.
   */
  const recordLateSend = async <R>(
    ctx: Context,
    startTime: Date,
    chainId: Promise<number>,
    result: Promise<R>,
    sendTrace: SendTrace<R>,
  ): Promise<void> => {
    let sent: { value: R } | undefined;
    let error: unknown;
    try {
      sent = { value: await result };
    } catch (thrown) {
      error = thrown;
    }
    const endTime = new Date();
    const id = await chainIdOrGiveUp(chainId, Promise.resolve());
    if (id === undefined) return;
    try {
      const handle = context.with(ctx, () => sendTrace.start(id, startTime));
      if (sent === undefined) {
        handle.fail(error, endTime);
        return;
      }
      handle.end(sent.value, endTime);
      sendTrace.after(id, sent.value);
    } catch (thrown) {
      diag.error(`hashspan: failed to record send span (${errorName(thrown)})`);
    }
  };

  const traceSend = async <R>(sendTrace: SendTrace<R>, send: () => Promise<R>): Promise<R> => {
    let chainId: number | null | undefined;
    try {
      chainId = sendTrace.chainId();
    } catch (error) {
      untraced(error);
      return send();
    }
    if (chainId === null) {
      diag.debug('hashspan: the call names a chain whose id is not a chain id; call not traced');
      return send();
    }
    if (chainId === undefined) {
      // Telemetry must not delay the call: record it once the chain id is known (docs/adr/0009).
      const ctx = context.active();
      const startTime = new Date();
      const chainIdQuery = queryChainId();
      const result = send();
      track(recordLateSend(ctx, startTime, chainIdQuery, result, sendTrace));
      return result;
    }
    let handle: StartedSend<R> = { context: context.active(), end: () => {}, fail: () => {} };
    try {
      handle = sendTrace.start(chainId);
    } catch (error) {
      diag.error(`hashspan: failed to start send span (${errorName(error)})`);
    }
    let result: R;
    try {
      // Only the call runs in the send span's context, so the spans it creates nest under the send span; what
      // follows runs in the caller's (ADR 0015). The guarded tracker always provides a context.
      result = await context.with(handle.context, send);
    } catch (error) {
      handle.fail(error);
      throw error;
    }
    handle.end(result);
    sendTrace.after(chainId, result);
    return result;
  };

  /**
   * Logs that reading the call's arguments for telemetry threw, for example on a Proxy whose traps throw; the caller
   * then makes the call untraced, so the read never affects it.
   */
  const untraced = (error: unknown): void => {
    diag.error(
      `hashspan: failed to read the call arguments; call not traced (${errorName(error)})`,
    );
  };

  return { knownChainId, queryChainId, traceSend, untraced };
}
