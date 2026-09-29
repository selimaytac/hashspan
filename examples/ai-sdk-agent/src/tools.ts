import { tool } from 'ai';
import { formatEther, parseEther } from 'viem';
import { z } from 'zod';
import { reader, vault, vaultAbi, vendor, wallet } from './chain.js';

/** Agent tools: each one sends a transaction, which hashspan traces under the tool's span. */
export const tools = {
  pay_vendor: tool({
    description: 'Pay the vendor an amount of ETH.',
    inputSchema: z.object({ amountEth: z.string().describe('Amount in ETH, e.g. "0.01"') }),
    execute: async ({ amountEth }) => {
      const hash = await wallet.sendTransaction({ to: vendor, value: parseEther(amountEth) });
      const receipt = await reader.waitForTransactionReceipt({ hash });
      return { hash, status: receipt.status, paid: `${formatEther(parseEther(amountEth))} ETH` };
    },
  }),

  withdraw_from_vault: tool({
    description: 'Withdraw ETH from the treasury vault.',
    inputSchema: z.object({ amountEth: z.string() }),
    execute: async ({ amountEth }) => {
      // Explicit gas skips estimation, so the rejected withdrawal is mined and shows up as a reverted transaction.
      const hash = await wallet.writeContract({
        address: vault,
        abi: vaultAbi,
        functionName: 'withdraw',
        args: [parseEther(amountEth)],
        gas: 100_000n,
      });
      const receipt = await reader.waitForTransactionReceipt({ hash });
      return { hash, status: receipt.status };
    },
  }),
};
