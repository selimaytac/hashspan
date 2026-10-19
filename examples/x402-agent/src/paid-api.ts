import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { x402Facilitator } from '@x402/core/facilitator';
import { type FacilitatorClient, x402ResourceServer } from '@x402/core/server';
import type { SupportedResponse } from '@x402/core/types';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { registerExactEvmScheme as registerFacilitatorScheme } from '@x402/evm/exact/facilitator';
import { registerExactEvmScheme as registerServerScheme } from '@x402/evm/exact/server';
import { paymentMiddleware } from '@x402/hono';
import { Hono } from 'hono';
import { AUTHOR, type LocalChain, NETWORK, REPORT_PRICE, SELLER } from './chain.js';

export interface PaidApi {
  /** The API's base URL, e.g. `http://127.0.0.1:4021`. */
  url: string;
  close: () => Promise<void>;
}

/**
 * A facilitator in this process: it verifies payments and settles them on the local chain from Anvil's first
 * account, which pays the gas. A real API would use a facilitator service instead (see the README).
 */
function localFacilitator({ facilitatorWallet }: LocalChain): FacilitatorClient {
  const facilitator = new x402Facilitator();
  const signer = toFacilitatorEvmSigner({
    ...facilitatorWallet,
    address: facilitatorWallet.account.address,
  } as unknown as Parameters<typeof toFacilitatorEvmSigner>[0]);
  registerFacilitatorScheme(facilitator, { signer, networks: NETWORK });
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    // The in-process facilitator answers synchronously, with network names typed as plain strings.
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  };
}

/**
 * A paid API served with Hono on `127.0.0.1:port` (0 picks a free port): `GET /report` costs 0.01 Test USD, paid to
 * the seller with an `exact` EIP-3009 payment. It is not traced: the trace is the agent's.
 */
export async function startPaidApi(chain: LocalChain, port = 0): Promise<PaidApi> {
  const resourceServer = new x402ResourceServer(localFacilitator(chain));
  registerServerScheme(resourceServer, { networks: [NETWORK] });

  const app = new Hono();
  app.use(
    paymentMiddleware(
      {
        'GET /report': {
          accepts: {
            scheme: 'exact',
            network: NETWORK,
            payTo: SELLER,
            // Test USD is not one of the scheme's default assets: name it, with its EIP-712 domain.
            price: {
              asset: chain.token,
              amount: String(REPORT_PRICE),
              extra: { name: 'Test USD', version: '1' },
            },
            maxTimeoutSeconds: 60,
          },
          description: "Today's market report",
          mimeType: 'application/json',
        },
      },
      resourceServer,
    ),
  );
  app.get('/report', (c) =>
    c.json({ title: 'Stablecoin volumes rose 4% this week', author: AUTHOR }),
  );

  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info: AddressInfo) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        close: () =>
          new Promise<void>((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          ),
      });
    });
  });
}
