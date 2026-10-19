import { withHashspan } from '@hashspan/x402';
import { x402Client } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { type LocalChain, MAX_PER_PAYMENT, NETWORK, tracker } from './chain.js';

/**
 * The agent's x402 client: it pays with the agent account's EIP-3009 signature, only in Test USD and at most
 * 0.05 Test USD per payment. Each payment becomes a `payment` span; with the reader, a linked `confirm` span follows
 * for the facilitator's settling transaction.
 */
export function paymentClient({ agent, token, reader }: LocalChain) {
  const client = new x402Client();
  // Before any hook of your own, as the @hashspan/x402 README asks. The shared tracker carries the agent identity.
  const payments = withHashspan(client, { reader, tracker });
  registerExactEvmScheme(client, { signer: agent, networks: [NETWORK] });
  // Spend controls refuse a payment before it is signed: Test USD is allowed, up to the cap.
  client.setSpendControls({
    allowedAssets: [
      { network: NETWORK, asset: token, maxAmountPerPayment: String(MAX_PER_PAYMENT) },
    ],
  });
  return { fetchWithPayment: wrapFetchWithPayment(fetch, client), payments };
}
