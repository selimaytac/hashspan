// The types withHashspan() gives viem's own clients, a public contract: compiled by `pnpm typecheck`
// (tsconfig.test.json); the assertions do nothing at runtime. A smart account SDK's client, whose `sendTransaction`
// is not viem's, is covered in integrations/test/smart-account-sdks.int.test.ts.
import {
  createClient,
  createPublicClient,
  createWalletClient,
  http,
  publicActions,
  walletActions,
} from 'viem';
import { createBundlerClient } from 'viem/account-abstraction';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { describe, expectTypeOf, it } from 'vitest';
import { type TracedAction, withHashspan } from '../src/index.js';

// Anvil's first well-known test account.
const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const transport = http('http://127.0.0.1:8545');

/** The return type of the extension before smart account SDK clients were accepted by `extend()`. */
type Traced<TClient> = Pick<TClient, Extract<keyof TClient, TracedAction>>;

const clients = {
  wallet: createWalletClient({ account, chain: foundry, transport }),
  'wallet without an account': createWalletClient({ chain: foundry, transport }),
  public: createPublicClient({ chain: foundry, transport }),
  'public and wallet actions': createClient({ account, chain: foundry, transport })
    .extend(publicActions)
    .extend(walletActions),
  bundler: createBundlerClient({ chain: foundry, transport }),
};

describe('withHashspan() types on viem clients', () => {
  it('returns every traced action a wallet client has, with its own type', () => {
    const client = clients.wallet;
    expectTypeOf(withHashspan()(client)).toEqualTypeOf<Traced<typeof client>>();
    const extended = client.extend(withHashspan());
    expectTypeOf(extended.sendTransaction).toEqualTypeOf(client.sendTransaction);
    expectTypeOf(extended.writeContract).toEqualTypeOf(client.writeContract);
    expectTypeOf(extended.sendRawTransaction).toEqualTypeOf(client.sendRawTransaction);
    expectTypeOf(extended.sendCalls).toEqualTypeOf(client.sendCalls);
    expectTypeOf(extended.waitForCallsStatus).toEqualTypeOf(client.waitForCallsStatus);
  });

  it('returns every traced action a wallet client without an account has', () => {
    const client = clients['wallet without an account'];
    expectTypeOf(withHashspan()(client)).toEqualTypeOf<Traced<typeof client>>();
    const extended = client.extend(withHashspan());
    expectTypeOf(extended.sendTransaction).toEqualTypeOf(client.sendTransaction);
    expectTypeOf(extended.writeContract).toEqualTypeOf(client.writeContract);
  });

  it('returns every traced action a public client has', () => {
    const client = clients.public;
    expectTypeOf(withHashspan()(client)).toEqualTypeOf<Traced<typeof client>>();
    const extended = client.extend(withHashspan());
    expectTypeOf(extended.sendRawTransaction).toEqualTypeOf(client.sendRawTransaction);
    expectTypeOf(extended.waitForTransactionReceipt).toEqualTypeOf(
      client.waitForTransactionReceipt,
    );
  });

  it('returns every traced action of a client with public and wallet actions', () => {
    const client = clients['public and wallet actions'];
    expectTypeOf(withHashspan()(client)).toEqualTypeOf<Traced<typeof client>>();
    const extended = client.extend(withHashspan());
    expectTypeOf(extended.sendTransaction).toEqualTypeOf(client.sendTransaction);
    expectTypeOf(extended.waitForTransactionReceipt).toEqualTypeOf(
      client.waitForTransactionReceipt,
    );
  });

  it('returns every traced action a bundler client has', () => {
    const client = clients.bundler;
    expectTypeOf(withHashspan()(client)).toEqualTypeOf<Traced<typeof client>>();
    const extended = client.extend(withHashspan());
    expectTypeOf(extended.sendUserOperation).toEqualTypeOf(client.sendUserOperation);
    expectTypeOf(extended.waitForUserOperationReceipt).toEqualTypeOf(
      client.waitForUserOperationReceipt,
    );
  });
});
