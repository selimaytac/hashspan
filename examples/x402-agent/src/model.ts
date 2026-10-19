import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

const usage = {
  inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

const callTool = (toolCallId: string, toolName: string, input: object) => ({
  content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
  usage,
  warnings: [],
});

/**
 * A scripted model, so the example runs without an API key: it tips the author, then buys the report, then
 * answers. To use a real model instead, see the README.
 */
export function scriptedModel({ tipEth }: { tipEth: string }): LanguageModel {
  return new MockLanguageModelV4({
    provider: 'scripted',
    modelId: 'scripted-model',
    doGenerate: [
      callTool('call_1', 'tip_author', { amountEth: tipEth }),
      callTool('call_2', 'buy_report', {}),
      {
        content: [
          {
            type: 'text' as const,
            text: `Tipped the author ${tipEth} ETH and bought today's report for 0.01 Test USD.`,
          },
        ],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage,
        warnings: [],
      },
    ],
  });
}
