import { stepCountIs, ToolLoopAgent } from 'ai';
import { hashspan, installDemoVault } from './chain.js';
import { scriptedModel } from './model.js';
import { tools } from './tools.js';

export interface DemoResult {
  text: string;
  toolResults: { toolName: string; output: unknown }[];
}

/** Runs the treasury agent once. Telemetry must be registered before this module is imported. */
export async function runDemo(): Promise<DemoResult> {
  await installDemoVault();

  const agent = new ToolLoopAgent({
    id: 'treasury-agent',
    telemetry: { functionId: 'treasury-agent' },
    model: scriptedModel(),
    instructions: 'You manage a small treasury. Use the tools to move funds.',
    tools,
    stopWhen: stepCountIs(5),
  });

  const result = await agent.generate({
    prompt: 'Pay the vendor 0.25 ETH, then withdraw 1 ETH from the vault.',
  });

  // The reverted withdrawal's confirm span ends once its revert reason is fetched: flush before shutting down.
  await hashspan.flush();

  return {
    text: result.text,
    toolResults: result.steps.flatMap((step) =>
      step.toolResults.map(({ toolName, output }) => ({ toolName, output })),
    ),
  };
}
