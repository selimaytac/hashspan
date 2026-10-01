import { x402Client } from '@x402/core/client';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired, SettleResponse } from '@x402/core/types';

export const PAYER = '0x1111111111111111111111111111111111111111';
export const PAY_TO = '0x2222222222222222222222222222222222222222';
export const ASSET = '0x3333333333333333333333333333333333333333';
export const HASH = `0x${'ab'.repeat(32)}`;
export const NETWORK = 'eip155:84532';

/** What a paid API answers with 402: one `exact` option on Base Sepolia. */
export function paymentRequired(
  overrides: Partial<PaymentRequired['accepts'][number]> = {},
): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: 'https://api.example.com/weather?key=secret' },
    accepts: [
      {
        scheme: 'exact',
        network: NETWORK,
        amount: '10000',
        asset: ASSET,
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: {},
        ...overrides,
      },
    ],
  };
}

/**
 * An x402 client whose `exact` scheme signs nothing: its payload carries only the payer, as an EIP-3009
 * authorization would. Spend controls are off, so the test asset is not refused before any hook runs.
 */
export function testClient(
  createPayload: () => Promise<unknown> = async () => ({ authorization: { from: PAYER } }),
): x402Client {
  return x402Client.fromConfig({
    schemes: [
      {
        network: 'eip155:*',
        client: {
          scheme: 'exact',
          createPaymentPayload: async (x402Version) => ({
            x402Version,
            payload: (await createPayload()) as Record<string, unknown>,
          }),
        },
      },
    ],
    spendControls: false,
  });
}

/**
 * A fetch standing in for a paid API: it answers unpaid requests with 402 and `required` (or what it returns for the
 * request), and paid ones (with a
 * `PAYMENT-SIGNATURE` header) with `paid(request)`.
 */
export function paidApi(
  paid: (request: Request) => Response | Promise<Response>,
  required: PaymentRequired | ((request: Request) => PaymentRequired) = paymentRequired(),
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (!request.headers.has('PAYMENT-SIGNATURE')) {
      return new Response('{}', {
        status: 402,
        headers: {
          'PAYMENT-REQUIRED': encodePaymentRequiredHeader(
            typeof required === 'function' ? required(request) : required,
          ),
        },
      });
    }
    return paid(request);
  };
}

/** A paid response carrying `settlement` in its `PAYMENT-RESPONSE` header. */
export function settledWith(settlement: Partial<SettleResponse>, status = 200): Response {
  return new Response('{"temperature":21}', {
    status,
    headers: {
      'PAYMENT-RESPONSE': encodePaymentResponseHeader({
        success: true,
        transaction: HASH,
        network: NETWORK,
        payer: PAYER,
        ...settlement,
      } as SettleResponse),
    },
  });
}
