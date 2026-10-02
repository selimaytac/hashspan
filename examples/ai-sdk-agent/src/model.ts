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
 * A scripted model, so the demo runs without an API key: it pays the vendor, then tries a withdrawal, then answers.
 * To use a real model instead, see the README.
 */
export function scriptedModel({
  payEth,
  withdrawEth,
}: {
  payEth: string;
  withdrawEth: string;
}): LanguageModel {
  return new MockLanguageModelV4({
    provider: 'scripted',
    modelId: 'scripted-model',
    doGenerate: [
      callTool('call_1', 'pay_vendor', { amountEth: payEth }),
      callTool('call_2', 'withdraw_from_vault', { amountEth: withdrawEth }),
      {
        content: [
          {
            type: 'text' as const,
            text: `Paid the vendor ${payEth} ETH. The vault rejected the ${withdrawEth} ETH withdrawal.`,
          },
        ],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage,
        warnings: [],
      },
    ],
  });
}
