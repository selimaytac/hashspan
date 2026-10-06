// The checks every RPC fault row makes (issue #290): the caller's outcome compared with a client without hashspan,
// unhandled rejections, how a span ended, and the metric samples recorded. Shared by the `*faults*.int.test.ts`
// files of the adapters; the faults themselves come from `fault-proxy.ts`.
import {
  type Attributes,
  type Histogram,
  type MeterProvider,
  SpanStatusCode,
} from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { expect } from 'vitest';
import type { Fault, FaultRule } from './fault-proxy.js';

export type Faults = Record<string, Fault | FaultRule | FaultRule[]>;

/** A meter provider that keeps what each histogram records. */
export function recordingMeterProvider(): {
  provider: MeterProvider;
  recorded: (name: string) => { value: number; attributes: Attributes }[];
} {
  const recorded = new Map<string, { value: number; attributes: Attributes }[]>();
  const provider = {
    getMeter: () => ({
      createHistogram: (name: string): Histogram => {
        recorded.set(name, []);
        return {
          record: (value: number, attributes: Attributes = {}) => {
            recorded.get(name)?.push({ value, attributes });
          },
        };
      },
    }),
  } as unknown as MeterProvider;
  return { provider, recorded: (name: string) => recorded.get(name) ?? [] };
}

export type Outcome =
  | { resolved: unknown }
  | { rejected: { name: unknown; shortMessage: unknown; details: unknown } };

/** How a call settled, comparable between a client with hashspan and one without. */
export const settle = (call: Promise<unknown>): Promise<Outcome> =>
  call.then(
    (resolved) => ({ resolved }),
    (error: { name?: unknown; shortMessage?: unknown; details?: unknown }) => ({
      rejected: { name: error.name, shortMessage: error.shortMessage, details: error.details },
    }),
  );

/** Runs `run`, collecting the unhandled rejections raised until a little after it settled. */
export async function collectingRejections<T>(run: () => Promise<T>): Promise<[T, unknown[]]> {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const result = await run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return [result, rejections];
  } finally {
    process.off('unhandledRejection', onRejection);
  }
}

/** How a span ended: its status code, `error.type` and the outcome attribute of its kind. */
export interface Ending {
  status: SpanStatusCode;
  errorType?: string;
  outcome?: unknown;
}
export const failed = (errorType: string): Ending => ({ status: SpanStatusCode.ERROR, errorType });
export const TIMEOUT: Ending = failed('timeout');
/** Ended without an error and without an outcome. */
export const NO_OUTCOME: Ending = { status: SpanStatusCode.UNSET };
export const succeeded = (outcome: unknown): Ending => ({ status: SpanStatusCode.UNSET, outcome });

/** Checks how `span` ended; `outcomeAttribute` is the attribute that holds its kind's outcome. */
export const expectEnding = (
  span: ReadableSpan | undefined,
  ending: Ending,
  outcomeAttribute: string,
): void =>
  expect({
    status: span?.status.code,
    errorType: span?.attributes['error.type'],
    outcome: span?.attributes[outcomeAttribute],
  }).toEqual({ status: ending.status, errorType: ending.errorType, outcome: ending.outcome });

/** The transport faults of issue #290, on `method`. */
/**
 * `error.type` of a send that fails on each transport fault of `faultsOn`: the error viem classified the failure as,
 * under the `TransactionExecutionError` (or `ContractFunctionExecutionError`) it throws (hashspan #407).
 */
export const SEND_ERROR_TYPES: Record<string, string> = {
  'a request that never answers': 'TimeoutError',
  'HTTP 429': 'HttpRequestError',
  'a connection reset mid-response': 'HttpRequestError',
  'JSON-RPC -32005 (limit exceeded)': 'LimitExceededRpcError',
  'JSON-RPC -32603 (internal error)': 'InternalRpcError',
};

export const faultsOn = (method: string): Record<string, Faults> => ({
  'a request that never answers': { [method]: { kind: 'hang' } },
  'HTTP 429': { [method]: { kind: 'http', status: 429 } },
  'JSON-RPC -32005 (limit exceeded)': { [method]: { kind: 'rpc-error', code: -32005 } },
  'JSON-RPC -32603 (internal error)': { [method]: { kind: 'rpc-error', code: -32603 } },
  'a connection reset mid-response': { [method]: { kind: 'reset' } },
});
