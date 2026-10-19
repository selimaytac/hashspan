import { decodePaymentResponseHeader } from '@x402/fetch';
import { tool } from 'ai';
import { type Address, parseEther } from 'viem';
import { z } from 'zod';
import { AUTHOR, type tracedClients } from './chain.js';

interface ToolDeps {
  clients: ReturnType<typeof tracedClients>;
  fetchWithPayment: typeof fetch;
  apiUrl: string;
}

/** Agent tools. They hold no tracing code: hashspan traces the transaction and the payment under each tool's span. */
export function createTools({ clients: { wallet, receipts }, fetchWithPayment, apiUrl }: ToolDeps) {
  return {
    tip_author: tool({
      description: 'Send the author of a report a tip in ETH.',
      inputSchema: z.object({ amountEth: z.string().describe('Amount in ETH, e.g. "0.01"') }),
      execute: async ({ amountEth }) => {
        const hash = await wallet.sendTransaction({ to: AUTHOR, value: parseEther(amountEth) });
        const receipt = await receipts.waitForTransactionReceipt({ hash });
        return { hash, status: receipt.status };
      },
    }),

    buy_report: tool({
      description: "Buy today's market report from the paid API, paying with x402.",
      inputSchema: z.object({}),
      execute: async () => {
        const response = await fetchWithPayment(`${apiUrl}/report`);
        const header = response.headers.get('PAYMENT-RESPONSE');
        const settlement = header ? decodePaymentResponseHeader(header) : undefined;
        return {
          status: response.status,
          report: response.ok
            ? ((await response.json()) as { title: string; author: Address })
            : null,
          settlement: settlement?.transaction,
        };
      },
    }),
  };
}
