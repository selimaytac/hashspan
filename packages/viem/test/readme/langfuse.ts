// Example from docs/backends.md.
// `pnpm typecheck` compiles this file, and docs.test.ts checks that the document shows the region
// unchanged. Declarations outside the region stand in for the reader's own values.
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

// Stand in for @langfuse/otel, which this repository does not depend on.
declare class LangfuseSpanProcessor {
  constructor(params?: { shouldExportSpan?: (params: { otelSpan: ReadableSpan }) => boolean });
}
declare function isDefaultExportSpan(span: ReadableSpan): boolean;

// #region readme
const processor = new LangfuseSpanProcessor({
  shouldExportSpan: ({ otelSpan }) =>
    isDefaultExportSpan(otelSpan) || otelSpan.instrumentationScope.name.startsWith('@hashspan/'),
});
// #endregion
