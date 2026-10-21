// JSON-RPC over HTTP to the node under test, and the reduction of its answers to what a result may hold: the shape of
// a result (each field's kind, never a hash, time or address value), a short list of values that do not differ by
// design, and for an error its code, its message (sanitized) and the shape of its data.
import { setTimeout as sleep } from 'node:timers/promises';
import { sanitize as sanitizeText } from '../facilitators/diff.mjs';

/**
 * Text a node returned, made safe for a result: control characters (such as raw revert bytes) and runs of spaces
 * become one space, then hashes, paths, addresses other than 127.0.0.1 and times are replaced and it is cut to 200
 * characters (scripts/facilitators/diff.mjs).
 */
export const sanitize = (text) =>
  sanitizeText(
    String(text)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );

/** How long one call may take before the harness records a timeout. */
export const CALL_TIMEOUT_MS = 30_000;

/** A client for one node: `call(method, params)` resolves to `{ result }` or `{ error }`, never throws on an answer. */
export function client(url, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
  let id = 0;
  const call = async (method, params = []) => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return { error: { code: 'http', message: `HTTP ${response.status}, not JSON` } };
      }
      if (body?.error) return { error: body.error };
      if (body && 'result' in body) return { result: body.result };
      return { error: { code: 'http', message: `HTTP ${response.status}, no result or error` } };
    } catch (error) {
      if (error?.name === 'TimeoutError') return { error: { code: 'timeout', message: 'timeout' } };
      return { error: { code: 'transport', message: String(error?.message ?? error) } };
    }
  };
  /** Polls for a receipt until it is there or `timeoutMs` passed; resolves to the last answer. */
  const receipt = async (hash, waitMs = 30_000) => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const answer = await call('eth_getTransactionReceipt', [hash]);
      if (answer.error || answer.result) return answer;
      if (Date.now() > deadline) return { error: { code: 'timeout', message: 'no receipt' } };
      await sleep(100);
    }
  };
  return { url, call, receipt };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const HEX = /^0x[0-9a-fA-F]*$/;

/**
 * The kind of one value: `null`, `boolean`, `number`, `address`, `hash32`, `quantity`, `bytes<n>` (other hex, with
 * its length in bytes), `string`, `array` or `object`. A hex value is never kept, only its kind.
 */
export function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') {
    if (ADDRESS.test(value)) return 'address';
    if (HASH.test(value)) return 'hash32';
    if (QUANTITY.test(value)) return 'quantity';
    if (HEX.test(value)) return `bytes${Math.floor((value.length - 2) / 2)}`;
    return 'string';
  }
  return typeof value;
}

/** The fields of an object with the kind of each, sorted: `["blockHash:hash32", ...]`. */
export const fieldsOf = (object) =>
  Object.entries(object ?? {})
    .map(([k, v]) => `${k}:${kindOf(v)}`)
    .sort();

/** The data of an error, by shape: its first four bytes and its length, as `0x08c379a0 (100 bytes)`. */
export function dataShape(data) {
  if (data === undefined) return 'absent';
  if (typeof data !== 'string' || !HEX.test(data)) return kindOf(data);
  const bytes = Math.floor((data.length - 2) / 2);
  return bytes >= 4
    ? `${data.slice(0, 10).toLowerCase()} (${bytes} bytes)`
    : `${data} (${bytes} bytes)`;
}

/** An error as a result may hold it: the code, the sanitized message and the shape of the data. */
export const errorOf = (error) => ({
  code: typeof error?.code === 'number' ? error.code : String(error?.code ?? 'absent'),
  message: sanitize(error?.message ?? ''),
  data: dataShape(error?.data),
});

/** The receipt values that do not differ by design between nodes; everything else is compared by shape. */
export function receiptValues(receipt) {
  if (!receipt || typeof receipt !== 'object') return {};
  const out = {};
  for (const key of ['type', 'status', 'gasUsed', 'transactionIndex', 'blobGasUsed']) {
    if (receipt[key] !== undefined) out[key] = receipt[key];
  }
  if (Array.isArray(receipt.logs)) out.logs = receipt.logs.length;
  out.contractAddress =
    receipt.contractAddress === undefined ? 'absent' : receipt.contractAddress ? 'present' : 'null';
  return out;
}
