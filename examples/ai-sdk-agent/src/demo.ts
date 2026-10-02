import { stepCountIs, ToolLoopAgent } from 'ai';
import { type DemoChain, hashspan, localChain } from './chain.js';
import { scriptedModel } from './model.js';
import { createTools } from './tools.js';

export interface DemoResult {
  text: string;
  toolResults: { toolName: string; output: unknown }[];
}

/**
 * Runs the treasury agent once, on the local Anvil chain unless another chain is given. Telemetry must be registered
 * before this module is imported.
 */
export async function runDemo(chain?: DemoChain): Promise<DemoResult> {
  const demoChain = chain ?? (await localChain());
  const { payEth, withdrawEth } = demoChain;

  const agent = new ToolLoopAgent({
    id: 'treasury-agent',
    telemetry: { functionId: 'treasury-agent' },
    model: scriptedModel({ payEth, withdrawEth }),
    instructions: 'You manage a small treasury. Use the tools to move funds.',
    tools: createTools(demoChain),
    stopWhen: stepCountIs(5),
  });

  const result = await agent.generate({
    prompt: `Pay the vendor ${payEth} ETH, then withdraw ${withdrawEth} ETH from the vault.`,
  });

  // The reverted withdrawal's confirm span ends once its revert reason is fetched: flush before shutting down.
  const flushed = await hashspan.flush();
  console.log(
    flushed
      ? 'hashspan: all spans ended'
      : 'hashspan: flush timed out; confirm spans still waiting were ended as timeout',
  );

  return {
    text: result.text,
    toolResults: result.steps.flatMap((step) =>
      step.toolResults.map(({ toolName, output }) => ({ toolName, output })),
    ),
  };
}
