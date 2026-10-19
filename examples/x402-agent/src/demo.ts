import { stepCountIs, ToolLoopAgent } from 'ai';
import { AGENT_NAME, hashspan, prepareLocalChain, tracedClients } from './chain.js';
import { scriptedModel } from './model.js';
import { startPaidApi } from './paid-api.js';
import { paymentClient } from './payments.js';
import { createTools } from './tools.js';

const TIP_ETH = '0.01';

export interface DemoResult {
  text: string;
  toolResults: { toolName: string; output: unknown }[];
}

/**
 * Runs the research agent once on the local Anvil chain at `RPC_URL`, with the paid API on `PAID_API_PORT` (a free
 * port by default). Telemetry must be registered before this module is imported.
 */
export async function runDemo(): Promise<DemoResult> {
  const chain = await prepareLocalChain(process.env.RPC_URL ?? 'http://127.0.0.1:8545');
  const api = await startPaidApi(chain, Number(process.env.PAID_API_PORT ?? 0));
  const { fetchWithPayment, payments } = paymentClient(chain);
  try {
    const agent = new ToolLoopAgent({
      id: AGENT_NAME,
      telemetry: { functionId: AGENT_NAME },
      model: scriptedModel({ tipEth: TIP_ETH }),
      instructions: 'You research markets. Use the tools to pay for data and to tip authors.',
      tools: createTools({ clients: tracedClients(chain), fetchWithPayment, apiUrl: api.url }),
      stopWhen: stepCountIs(5),
    });
    const result = await agent.generate({
      prompt: `Tip the author of yesterday's report ${TIP_ETH} ETH, then buy today's report.`,
    });
    return {
      text: result.text,
      toolResults: result.steps.flatMap((step) =>
        step.toolResults.map(({ toolName, output }) => ({ toolName, output })),
      ),
    };
  } finally {
    // Before a short-lived process exits: the spans still waiting for a receipt end first.
    const flushed = (await Promise.all([hashspan.flush(), payments.flush()])).every(Boolean);
    console.log(
      flushed
        ? 'hashspan: all spans ended'
        : 'hashspan: flush timed out; spans still waiting were ended as timeout',
    );
    await api.close();
  }
}
