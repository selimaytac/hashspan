import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTxTracker } from '../src/index.js';
import { setupTracing, type TestTracing } from './helpers.js';

// In `raw` mode every address is recorded in one form, lower case, whatever form its source gave: a send's arguments
// usually carry EIP-55 checksummed addresses, while nodes and bundlers often return them in lower case. A query on
// an address attribute then finds every span of a transaction, a user operation or a payment.

const CHAIN_ID = 84532;
const TX_HASH = `0x${'c3'.repeat(32)}`;
const USER_OP_HASH = `0x${'a1'.repeat(32)}`;
const BUNDLE_HASH = `0x${'b2'.repeat(32)}`;
/** Anvil's first test account, checksummed. */
const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
/** EntryPoint v0.7, checksummed. */
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
/** USDC on Base, checksummed. */
const ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const PAYMASTER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

let tracing: TestTracing;
beforeEach(() => {
  tracing = setupTracing();
});
afterEach(async () => {
  await tracing.teardown();
});

const attribute = (spanName: string, key: string): unknown =>
  tracing.spanNamed(spanName).attributes[key];

describe('address form in raw mode', () => {
  it('records blockchain.tx.from and blockchain.tx.to in lower case', () => {
    createTxTracker().startSend({ chainId: CHAIN_ID, from: ACCOUNT, to: RECIPIENT }).end(TX_HASH);
    expect(attribute(`send ${CHAIN_ID}`, 'blockchain.tx.from')).toBe(ACCOUNT.toLowerCase());
    expect(attribute(`send ${CHAIN_ID}`, 'blockchain.tx.to')).toBe(RECIPIENT.toLowerCase());
  });

  it('records one form of blockchain.user_operation.entry_point on send and confirm', () => {
    const tracker = createTxTracker();
    tracker
      .startUserOperationSend({ chainId: CHAIN_ID, sender: ACCOUNT, entryPoint: ENTRY_POINT })
      .end({ userOpHash: USER_OP_HASH });
    tracker
      .startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH })
      .end({ success: true, entryPoint: ENTRY_POINT.toLowerCase(), transactionHash: BUNDLE_HASH });
    const key = 'blockchain.user_operation.entry_point';
    expect(attribute(`send ${CHAIN_ID}`, key)).toBe(ENTRY_POINT.toLowerCase());
    expect(attribute(`confirm ${CHAIN_ID}`, key)).toBe(ENTRY_POINT.toLowerCase());
  });

  it('records one form of blockchain.user_operation.sender on send and confirm', () => {
    const tracker = createTxTracker();
    tracker
      .startUserOperationSend({ chainId: CHAIN_ID, sender: ACCOUNT, entryPoint: ENTRY_POINT })
      .end({ userOpHash: USER_OP_HASH });
    tracker
      .startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH })
      .end({ success: true, sender: ACCOUNT.toLowerCase(), transactionHash: BUNDLE_HASH });
    const key = 'blockchain.user_operation.sender';
    expect(attribute(`send ${CHAIN_ID}`, key)).toBe(ACCOUNT.toLowerCase());
    expect(attribute(`confirm ${CHAIN_ID}`, key)).toBe(ACCOUNT.toLowerCase());
  });

  it('records blockchain.user_operation.paymaster in lower case', () => {
    createTxTracker()
      .startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH })
      .end({ success: true, paymaster: PAYMASTER, transactionHash: BUNDLE_HASH });
    expect(attribute(`confirm ${CHAIN_ID}`, 'blockchain.user_operation.paymaster')).toBe(
      PAYMASTER.toLowerCase(),
    );
  });

  it('records blockchain.call_batch.sender in lower case', () => {
    createTxTracker()
      .startCallBatchSend({ chainId: CHAIN_ID, sender: ACCOUNT })
      .end({ id: '0x01' });
    expect(attribute(`send ${CHAIN_ID}`, 'blockchain.call_batch.sender')).toBe(
      ACCOUNT.toLowerCase(),
    );
  });

  it('records blockchain.payment.payer, recipient and asset in lower case', () => {
    createTxTracker()
      .startPayment({
        chainId: CHAIN_ID,
        protocol: 'x402',
        payer: ACCOUNT,
        recipient: RECIPIENT,
        asset: ASSET,
        amount: 1n,
      })
      .end({ status: 'settled', hash: TX_HASH });
    const span = `payment ${CHAIN_ID}`;
    expect(attribute(span, 'blockchain.payment.payer')).toBe(ACCOUNT.toLowerCase());
    expect(attribute(span, 'blockchain.payment.recipient')).toBe(RECIPIENT.toLowerCase());
    expect(attribute(span, 'blockchain.payment.asset')).toBe(ASSET.toLowerCase());
  });

  it('records the payer the settlement reports in lower case', () => {
    createTxTracker()
      .startPayment({ chainId: CHAIN_ID, protocol: 'x402' })
      .end({ status: 'settled', hash: TX_HASH, payer: ACCOUNT });
    expect(attribute(`payment ${CHAIN_ID}`, 'blockchain.payment.payer')).toBe(
      ACCOUNT.toLowerCase(),
    );
  });

  it('records addresses inside function arguments and revert reasons in lower case', () => {
    const tracker = createTxTracker({ recordFunctionArguments: true });
    tracker.startSend({ chainId: CHAIN_ID, functionArguments: [RECIPIENT, 5n] }).end(TX_HASH);
    tracker.startUserOperationConfirm({ chainId: CHAIN_ID, userOpHash: USER_OP_HASH }).end({
      success: false,
      revertReason: `NotAllowed(${ACCOUNT})`,
      transactionHash: BUNDLE_HASH,
    });
    expect(attribute(`send ${CHAIN_ID}`, 'blockchain.contract.function.arguments')).toBe(
      `["${RECIPIENT.toLowerCase()}","5"]`,
    );
    expect(attribute(`confirm ${CHAIN_ID}`, 'blockchain.tx.revert.reason')).toBe(
      `NotAllowed(${ACCOUNT.toLowerCase()})`,
    );
  });
});
