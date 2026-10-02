import { type Abi, BaseError, decodeErrorResult, type Hex } from 'viem';
import { call, getTransaction } from 'viem/actions';

const MAX_REASON_LENGTH = 1024;

function formatValue(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(formatValue).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  }
  return String(value);
}

/** Human-readable reason for revert data: `Error(string)` message, `Panic(0x..)`, `Name(args)` or the selector. */
export function formatRevertData(data: Hex, abi: Abi | undefined): string | undefined {
  if (data.length < 10) return undefined;
  let reason: string;
  try {
    const { errorName, args = [] } = decodeErrorResult({ abi: abi ?? [], data });
    if (errorName === 'Error') reason = String(args[0]);
    else if (errorName === 'Panic') reason = `Panic(0x${(args[0] as bigint).toString(16)})`;
    else reason = `${errorName}(${args.map(formatValue).join(', ')})`;
  } catch {
    reason = data.slice(0, 10);
  }
  return reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH)}...` : reason;
}

function revertDataOf(error: unknown): Hex | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const deepest = error.walk() as { data?: Hex | { data?: Hex } } | null;
  const data = deepest?.data;
  return typeof data === 'object' ? data?.data : data;
}

/**
 * Replays a mined transaction with `eth_call` on the state of the previous block and returns the decoded revert
 * reason. Best effort: see
 * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.7.0/docs/adr/0005-revert-reason-replay.md.
 */
export async function fetchRevertReason(
  client: unknown,
  hash: Hex,
  blockNumber: bigint,
  abi: Abi | undefined,
): Promise<string | undefined> {
  const tx = await getTransaction(client as never, { hash });
  try {
    await call(client as never, {
      account: tx.from,
      to: tx.to,
      data: tx.input,
      value: tx.value,
      gas: tx.gas,
      blockNumber: blockNumber > 0n ? blockNumber - 1n : 0n,
    });
  } catch (error) {
    const data = revertDataOf(error);
    return data ? formatRevertData(data, abi) : undefined;
  }
  return undefined;
}
