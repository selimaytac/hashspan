import {
  type Attributes,
  context,
  diag,
  type Span,
  SpanKind,
  SpanStatusCode,
  type TracerProvider,
  trace,
} from '@opentelemetry/api';
import type { Transport } from 'viem';
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
 * https://github.com/selimaytac/hashspan/blob/@hashspan/viem@0.11.0/docs/adr/0019-json-rpc-spans.md.
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
          result = context.with(trace.setSpan(context.active(), active), () =>
            request(args, requestOptions),
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
