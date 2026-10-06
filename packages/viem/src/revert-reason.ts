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
  return cutAt(reason, MAX_REASON_LENGTH);
}

/**
 * `text` cut to `max` characters, followed by `...`. A hex value that the cut splits is dropped whole: the part left
 * is shorter than an address, so the address mode, applied later, would no longer recognise it as one.
 */
function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return `${/^[0-9a-fA-F]/.test(text.slice(max)) ? head.replace(/0[xX][0-9a-fA-F]*$/, '') : head}...`;
}

function revertDataOf(error: unknown): Hex | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const deepest = error.walk() as { data?: Hex | { data?: Hex } } | null;
  const data = deepest?.data;
  return typeof data === 'object' ? data?.data : data;
}

/**
 * Replays a mined transaction with `eth_call` on the state of the previous block and returns the decoded revert
 * reason. If that call does not revert, as when the contract was created earlier in the same block, it is replayed
 * once more on the state at the end of the transaction's block. Best effort: see
 * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.1.0/docs/adr/0005-revert-reason-replay.md.
 */
export async function fetchRevertReason(
  client: unknown,
  hash: Hex,
  blockNumber: bigint,
  abi: Abi | undefined,
): Promise<string | undefined> {
  const tx = await getTransaction(client as never, { hash });
  const replayOn = async (
    block: bigint,
  ): Promise<{ reverted: boolean; reason?: string | undefined }> => {
    try {
      await call(client as never, {
        account: tx.from,
        to: tx.to,
        data: tx.input,
        value: tx.value,
        gas: tx.gas,
        blockNumber: block,
      });
      return { reverted: false };
    } catch (error) {
      const data = revertDataOf(error);
      return { reverted: true, reason: data ? formatRevertData(data, abi) : undefined };
    }
  };
  const before = await replayOn(blockNumber > 0n ? blockNumber - 1n : 0n);
  if (before.reverted) return before.reason;
  return (await replayOn(blockNumber)).reason;
}
