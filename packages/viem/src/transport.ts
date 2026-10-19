import {
  type Attributes,
  context,
  createContextKey,
  diag,
  isSpanContextValid,
  type Span,
  SpanKind,
  SpanStatusCode,
  type TracerProvider,
  trace,
} from '@opentelemetry/api';
import type { HttpTransportConfig, Transport } from 'viem';
import { errorName } from './safe-tracker.js';

/** Options of {@link traceTransport}. */
export interface TraceTransportOptions {
  /** Tracer provider to record the spans with. Defaults to the global one. */
  tracerProvider?: TracerProvider | undefined;
  /**
   * Which JSON-RPC methods get a span, for example to leave out receipt polling. Called with the method name;
   * a method for which it returns false, or throws, is sent untraced. Default: every method.
   */
  methods?: ((method: string) => boolean) | undefined;
}

// OpenTelemetry semantic conventions for RPC (1.43): attribute names and the JSON-RPC system value.
const ATTR_RPC_SYSTEM_NAME = 'rpc.system.name';
const ATTR_RPC_METHOD = 'rpc.method';
const ATTR_RPC_RESPONSE_STATUS_CODE = 'rpc.response.status_code';
const ATTR_JSONRPC_PROTOCOL_VERSION = 'jsonrpc.protocol.version';
const ATTR_SERVER_ADDRESS = 'server.address';
const ATTR_SERVER_PORT = 'server.port';
const ATTR_ERROR_TYPE = 'error.type';
const ATTR_BLOCKCHAIN_CHAIN_ID = 'blockchain.chain.id';
/** Method names as JSON-RPC providers define them; anything else is recorded as `_OTHER`, as the conventions say. */
const METHOD = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
/** Scheme, host and port of an HTTP or WebSocket URL, skipping user info; the path and query are not captured. */
const SERVER =
  /^(https?|wss?):\/\/(?:[^/?#@]*@)?(\[[0-9a-fA-F:.]+\]|[^:/?#@[\]]+)(?::([0-9]{1,5}))?(?:[/?#]|$)/i;

/** Holds the JSON-RPC span of {@link traceTransport} in the context its request runs in, for {@link propagateTraceContext}. */
const JSON_RPC_SPAN = createContextKey('@hashspan/viem JSON-RPC span');

type TransportParams = Parameters<Transport>[0];
// biome-ignore lint/suspicious/noExplicitAny: viem's EIP-1193 request function is overloaded.
type AnyRequest = (args: any, options?: any) => Promise<any>;

/**
 * The host and port the transport sends to, from its URL; never its path or query, which can carry an API key.
 * Undefined for a transport without a URL, such as a browser wallet.
 */
function serverOf(value: unknown): Attributes {
  const url = (value as { url?: unknown } | null | undefined)?.url;
  const match = typeof url === 'string' ? SERVER.exec(url) : null;
  if (!match) return {};
  const [, scheme, host, port] = match as unknown as [string, string, string, string | undefined];
  const secure = scheme.toLowerCase() === 'https' || scheme.toLowerCase() === 'wss';
  return {
    [ATTR_SERVER_ADDRESS]: host.toLowerCase(),
    [ATTR_SERVER_PORT]: port ? Number(port) : secure ? 443 : 80,
  };
}

/** Ends `span` with the outcome of a request; only the error's code or class name is recorded, never its message. */
function endWith(span: Span, error: unknown): void {
  if (error === undefined) {
    span.end();
    return;
  }
  const code = (error as { code?: unknown } | null)?.code;
  const type = typeof code === 'number' && Number.isInteger(code) ? String(code) : errorName(error);
  if (typeof code === 'number' && Number.isInteger(code)) {
    span.setAttribute(ATTR_RPC_RESPONSE_STATUS_CODE, String(code));
  }
  span.setAttribute(ATTR_ERROR_TYPE, type);
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}

/**
 * Wraps a viem transport so that each JSON-RPC request it sends becomes a client span named after its method, as
 * the OpenTelemetry RPC conventions describe. Used with `withHashspan()`, the requests a transaction makes nest under
 * its `send` span. Records no parameters or results, and of the transport's URL only the host and port. Tracing never
 * changes a request, its result or its error. See
 * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.2.2/docs/adr/0019-json-rpc-spans.md.
 */
export function traceTransport<TTransport extends Transport>(
  transport: TTransport,
  options: TraceTransportOptions = {},
): TTransport {
  const traced = (params: TransportParams) => {
    const created = transport(params);
    try {
      const request = created.request as AnyRequest;
      const tracer = (options.tracerProvider ?? trace.getTracerProvider()).getTracer(
        '@hashspan/viem',
      );
      const chainId = params?.chain?.id;
      const base: Attributes = {
        [ATTR_RPC_SYSTEM_NAME]: 'jsonrpc',
        [ATTR_JSONRPC_PROTOCOL_VERSION]: '2.0',
        ...serverOf(created.value),
        ...(typeof chainId === 'number' ? { [ATTR_BLOCKCHAIN_CHAIN_ID]: chainId } : {}),
      };
      const tracedRequest: AnyRequest = (args, requestOptions) => {
        let span: Span | undefined;
        try {
          // Read without running a getter of the caller's: a method behind an accessor is sent untraced.
          const descriptor =
            args !== null && typeof args === 'object'
              ? Object.getOwnPropertyDescriptor(args, 'method')
              : undefined;
          const method = descriptor && 'value' in descriptor ? descriptor.value : undefined;
          const name = typeof method === 'string' && METHOD.test(method) ? method : '_OTHER';
          if (descriptor && !('value' in descriptor)) {
            diag.debug('hashspan: the request method is an accessor; not tracing the request');
          } else if (!options.methods || options.methods(name)) {
            span = tracer.startSpan(name, {
              kind: SpanKind.CLIENT,
              attributes: { ...base, [ATTR_RPC_METHOD]: name },
            });
          }
        } catch (error) {
          diag.error(`hashspan: failed to start a JSON-RPC span (${errorName(error)})`);
          span = undefined;
        }
        if (!span) return request(args, requestOptions);
        const active = span;
        let result: Promise<unknown>;
        try {
          // The request runs in the span's context, so HTTP spans of the request nest under it.
          result = context.with(
            trace.setSpan(context.active(), active).setValue(JSON_RPC_SPAN, active),
            () => request(args, requestOptions),
          );
        } catch (error) {
          safely(() => endWith(active, error));
          throw error;
        }
        Promise.resolve(result).then(
          () => safely(() => endWith(active, undefined)),
          (error: unknown) => safely(() => endWith(active, error)),
        );
        return result;
      };
      return { ...created, request: tracedRequest };
    } catch (error) {
      diag.error(`hashspan: failed to trace a transport (${errorName(error)})`);
      return created;
    }
  };
  return traced as unknown as TTransport;
}

function safely(record: () => void): void {
  try {
    record();
  } catch (error) {
    diag.error(`hashspan: failed to end a JSON-RPC span (${errorName(error)})`);
  }
}

/** Whether `headers`, in any form `fetch` takes, has a `traceparent` header. */
function hasTraceparent(headers: unknown): boolean {
  if (headers === null || typeof headers !== 'object') return false;
  const has = (headers as { has?: unknown }).has;
  if (typeof has === 'function') return Boolean(has.call(headers, 'traceparent'));
  if (Array.isArray(headers)) {
    return headers.some(
      (entry) => Array.isArray(entry) && String(entry[0]).toLowerCase() === 'traceparent',
    );
  }
  return Object.keys(headers).some((name) => name.toLowerCase() === 'traceparent');
}

/** `headers` as a plain object, from any form `fetch` takes. */
function plainHeaders(headers: unknown): Record<string, string> {
  const plain: Record<string, string> = {};
  if (headers === null || typeof headers !== 'object') return plain;
  const forEach = (headers as { forEach?: unknown }).forEach;
  if (Array.isArray(headers)) {
    for (const entry of headers)
      if (Array.isArray(entry)) plain[String(entry[0])] = String(entry[1]);
  } else if (typeof forEach === 'function') {
    forEach.call(headers, (value: unknown, name: unknown) => {
      plain[String(name)] = String(value);
    });
  } else {
    for (const [name, value] of Object.entries(headers)) plain[name] = String(value);
  }
  return plain;
}

/**
 * Whether `body` holds several JSON-RPC requests: one HTTP request of a batching transport (`batch: true`) can carry
 * requests of different traces, which one header cannot describe. A batch of one request is not.
 */
function severalRequests(body: unknown): boolean {
  if (typeof body !== 'string' || !body.trimStart().startsWith('[')) return false;
  const parsed: unknown = JSON.parse(body);
  return !Array.isArray(parsed) || parsed.length !== 1;
}

let warnedOldViem = false;

/**
 * A hook for the `onFetchRequest` option of viem's `http()` transport that sends the W3C trace context of each
 * request's JSON-RPC span to the provider, so that a gateway which reads it, such as eRPC, records its spans in the
 * same trace: `traceTransport(http(url, { onFetchRequest: propagateTraceContext() }))`. Without it, no header is sent.
 *
 * It adds `traceparent`, and `tracestate` when the span has one, from the span context; never `baggage`, and it does
 * not use the global propagator. It adds nothing when the active span is not a JSON-RPC span of
 * {@link traceTransport} (the transport is not traced, or `methods` left the method out), when the request already
 * has a `traceparent` header, or when the HTTP request carries several JSON-RPC requests (`batch: true`), which can
 * belong to different traces. Use it or an HTTP instrumentation of `fetch`, such as undici's, not both: that
 * instrumentation adds a second `traceparent` header after this hook ran. Needs viem 2.21.25 or later, the first whose
 * hook can change the request; with an older viem it adds nothing and logs a `diag` warning once. It never throws into
 * the request: if it fails, the request is sent unchanged. See
 * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@1.2.1/docs/adr/0030-trace-context-on-json-rpc-requests.md.
 */
export function propagateTraceContext(): NonNullable<HttpTransportConfig['onFetchRequest']> {
  const hook = (_request: unknown, init?: unknown): Record<string, unknown> | undefined => {
    try {
      if (init === null || typeof init !== 'object') {
        // viem below 2.21.25 passes the request only, and ignores what the hook returns.
        if (!warnedOldViem) {
          warnedOldViem = true;
          diag.warn(
            'hashspan: propagateTraceContext() needs viem 2.21.25 or later; no header sent',
          );
        }
        return undefined;
      }
      const active = context.active();
      const span = active.getValue(JSON_RPC_SPAN) as Span | undefined;
      if (span === undefined || trace.getSpan(active) !== span) return undefined;
      const spanContext = span.spanContext();
      if (!isSpanContextValid(spanContext)) return undefined;
      const { headers, body } = init as { headers?: unknown; body?: unknown };
      if (hasTraceparent(headers) || severalRequests(body)) return undefined;
      const flags = (spanContext.traceFlags & 0xff).toString(16).padStart(2, '0');
      const added: Record<string, string> = {
        traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`,
      };
      const traceState = spanContext.traceState?.serialize();
      if (traceState) added.tracestate = traceState;
      // A `tracestate` of the caller's belongs to another `traceparent`, so it is replaced or dropped.
      const kept = Object.entries(plainHeaders(headers)).filter(
        ([name]) => name.toLowerCase() !== 'tracestate',
      );
      return { ...init, headers: { ...Object.fromEntries(kept), ...added } };
    } catch (error) {
      diag.error(`hashspan: failed to add the trace context to a request (${errorName(error)})`);
      return undefined;
    }
  };
  return hook as unknown as NonNullable<HttpTransportConfig['onFetchRequest']>;
}
