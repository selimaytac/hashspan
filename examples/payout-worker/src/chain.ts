import { type Address, createPublicClient, http } from 'viem';
import { anvil } from 'viem/chains';

/** A contract that refuses every payment: runtime bytecode PUSH1 0 PUSH1 0 REVERT. */
export const REFUSER: Address = '0x00000000000000000000000000000000000000aa';

/** Three payouts: two to plain addresses, one to a contract that refuses it, so its send fails. */
export const PAYOUTS = [
  { id: 'po-1', to: '0x00000000000000000000000000000000000000c1', value: 1_000_000_000_000_000n },
  { id: 'po-2', to: '0x00000000000000000000000000000000000000c2', value: 2_000_000_000_000_000n },
  { id: 'po-3', to: REFUSER, value: 3_000_000_000_000_000n },
] as const;

/** Places the refusing contract on the local Anvil chain at `rpcUrl`. */
export async function prepareLocalChain(rpcUrl: string): Promise<void> {
  await createPublicClient({ chain: anvil, transport: http(rpcUrl) }).request({
    method: 'anvil_setCode' as never,
    params: [REFUSER, '0x60006000fd'] as never,
  });
}
