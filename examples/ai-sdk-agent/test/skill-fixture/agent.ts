// The treasury agent before hashspan: an AI SDK agent with the AI SDK's OpenTelemetry integration and no
// OpenTelemetry SDK, whose tools send with viem and wait for the receipts. skill.int.test.ts applies
// skills/hashspan/SKILL.md to a copy of this folder and runs it as a script.
import { OpenTelemetry } from '@ai-sdk/otel';
import { registerTelemetry, stepCountIs, ToolLoopAgent, tool } from 'ai';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { z } from 'zod';
import { scriptedModel } from '../../src/model.js';

const transport = http(process.env.RPC_URL ?? 'http://127.0.0.1:8545');
const wallet = createWalletClient({
  account: mnemonicToAccount('test test test test test test test test test test test junk'),
  chain: anvil,
  transport,
  pollingInterval: 100,
});
const reader = createPublicClient({ chain: anvil, transport, pollingInterval: 100 });

const vendor = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const vault = '0x00000000000000000000000000000000000000aa';

/** Sends `value` to `to` and waits for the receipt. */
async function send(to: `0x${string}`, amountEth: string) {
  const hash = await wallet.sendTransaction({ to, value: parseEther(amountEth) });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  return { hash, status: receipt.status };
}

registerTelemetry(new OpenTelemetry());

const agent = new ToolLoopAgent({
  id: 'treasury-agent',
  model: scriptedModel({ payEth: '0.25', withdrawEth: '0.5' }),
  instructions: 'You manage a small treasury. Use the tools to move funds.',
  tools: {
    pay_vendor: tool({
      description: 'Pay the vendor an amount of ETH.',
      inputSchema: z.object({ amountEth: z.string() }),
      execute: ({ amountEth }) => send(vendor, amountEth),
    }),
    withdraw_from_vault: tool({
      description: 'Move ETH to the treasury vault.',
      inputSchema: z.object({ amountEth: z.string() }),
      execute: ({ amountEth }) => send(vault, amountEth),
    }),
  },
  stopWhen: stepCountIs(5),
});

const { text } = await agent.generate({
  prompt: 'Pay the vendor 0.25 ETH, then move 0.5 ETH to the vault.',
});
console.log(text);
