// The matcher of watchUserOperation() (src/confirm/user-operation-event.ts) against the copy in @hashspan/cdp and
// viem's list of EntryPoints: both copies must name the same EntryPoints and find the same operation
// (docs/adr/0031-watch-user-operation.md, Consequences).
import { getAddress, type Hex, toEventSelector } from 'viem';
import * as accountAbstraction from 'viem/account-abstraction';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_ENTRY_POINTS as CDP_ENTRY_POINTS,
  userOperationReceiptFromBundle,
} from '../../cdp/src/user-operation.js';
import {
  CANONICAL_ENTRY_POINTS,
  findUserOperation,
  MAX_BUNDLE_LOGS,
  USER_OPERATION_EVENT_TOPIC,
} from '../src/confirm/user-operation-event.js';
import { userOperationEventLog as eventLog } from './mock-bundler.js';

const ENTRY_POINT = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const SENDER = '0x1111111111111111111111111111111111111111';
const OTHER_SENDER = '0x6666666666666666666666666666666666666666';
const PAYMASTER = '0x7777777777777777777777777777777777777777';
const FORGER = '0x9999999999999999999999999999999999999999';
const BUNDLE = `0x${'b2'.repeat(32)}`;
const OP_HASH = `0x${'a1'.repeat(32)}` as Hex;
const OTHER_OP_HASH = `0x${'a2'.repeat(32)}` as Hex;

const receipt = (logs: unknown[], extra: Record<string, unknown> = {}) => ({
  transactionHash: BUNDLE,
  blockNumber: '0x2a',
  to: ENTRY_POINT,
  logs,
  ...extra,
});

describe('findUserOperation', () => {
  it('names the event signature as viem computes it', () => {
    expect(
      toEventSelector('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)'),
    ).toBe(USER_OPERATION_EVENT_TOPIC);
  });

  it('names the same EntryPoints as @hashspan/cdp, and every one viem names', () => {
    expect([...CANONICAL_ENTRY_POINTS].sort()).toEqual([...CDP_ENTRY_POINTS].sort());
    const fromViem = Object.entries(accountAbstraction)
      .filter(([name, value]) => /^entryPoint\d+Address$/.test(name) && typeof value === 'string')
      .map(([, value]) => (value as string).toLowerCase());
    expect(fromViem.length).toBeGreaterThan(0);
    expect(fromViem.filter((address) => !CANONICAL_ENTRY_POINTS.has(address))).toEqual([]);
  });

  it('finds the one operation of the sender, with the event values and the bundle hash and block', () => {
    const raw = receipt([
      eventLog({ sender: OTHER_SENDER, userOpHash: OTHER_OP_HASH }),
      eventLog({ paymaster: PAYMASTER, success: false, nonce: 5n }),
    ]);
    expect(findUserOperation(raw, { bundleHash: BUNDLE, sender: SENDER })).toEqual({
      kind: 'one',
      userOpHash: OP_HASH,
      receipt: {
        success: false,
        actualGasCost: 1_000n,
        actualGasUsed: 500n,
        sender: getAddress(SENDER),
        nonce: 5n,
        paymaster: getAddress(PAYMASTER),
        entryPoint: getAddress(ENTRY_POINT),
        transactionHash: BUNDLE,
        blockNumber: 42n,
      },
    });
  });

  it('gives the same receipt as @hashspan/cdp for one operation', () => {
    for (const address of CANONICAL_ENTRY_POINTS) {
      const raw = receipt([eventLog({ address, paymaster: PAYMASTER })], { to: FORGER });
      const found = findUserOperation(raw, {
        bundleHash: BUNDLE,
        sender: SENDER,
        userOpHash: OP_HASH,
      });
      expect(found.kind).toBe('one');
      expect(found.kind === 'one' && found.receipt).toEqual(
        userOperationReceiptFromBundle(raw, OP_HASH, SENDER),
      );
    }
  });

  it('counts the events of the called contract and of a canonical EntryPoint only', () => {
    // A forged event of another contract, with the sender's topics: not counted.
    const forged = eventLog({ address: FORGER, success: true });
    const real = eventLog({ success: false });
    const found = findUserOperation(receipt([real, forged]), {
      bundleHash: BUNDLE,
      sender: SENDER,
    });
    expect(found.kind === 'one' && found.receipt.success).toBe(false);
    expect(findUserOperation(receipt([forged]), { bundleHash: BUNDLE, sender: SENDER })).toEqual({
      kind: 'none',
    });
    // The contract the bundle transaction called counts, like a non-canonical EntryPoint.
    expect(
      findUserOperation(receipt([forged], { to: FORGER }), { bundleHash: BUNDLE, sender: SENDER })
        .kind,
    ).toBe('one');
  });

  it('records none of several operations of the sender, unless the nonce or hash tells them apart', () => {
    const raw = receipt([
      eventLog({ nonce: 5n }),
      eventLog({ nonce: 6n, userOpHash: OTHER_OP_HASH }),
    ]);
    expect(findUserOperation(raw, { bundleHash: BUNDLE, sender: SENDER })).toEqual({
      kind: 'several',
    });
    const byNonce = findUserOperation(raw, { bundleHash: BUNDLE, sender: SENDER, nonce: 6n });
    expect(byNonce.kind === 'one' && byNonce.userOpHash).toBe(OTHER_OP_HASH);
    const byHash = findUserOperation(raw, {
      bundleHash: BUNDLE,
      sender: SENDER,
      userOpHash: OP_HASH,
    });
    expect(byHash.kind === 'one' && byHash.receipt.nonce).toBe(5n);
    expect(findUserOperation(raw, { bundleHash: BUNDLE, sender: SENDER, nonce: 7n })).toEqual({
      kind: 'none',
    });
  });

  it('matches the sender in any letter case, and no other sender', () => {
    const raw = receipt([eventLog({ sender: getAddress(SENDER) })]);
    expect(findUserOperation(raw, { bundleHash: BUNDLE, sender: SENDER }).kind).toBe('one');
    expect(findUserOperation(raw, { bundleHash: BUNDLE, sender: OTHER_SENDER }).kind).toBe('none');
  });

  it('records nothing from the receipt of another transaction', () => {
    expect(
      findUserOperation(receipt([eventLog()], { transactionHash: `0x${'cc'.repeat(32)}` }), {
        bundleHash: BUNDLE,
        sender: SENDER,
      }),
    ).toEqual({ kind: 'other transaction' });
  });

  it('skips malformed logs', () => {
    const good = eventLog();
    const malformed = [
      null,
      42,
      { ...good, topics: good.topics.slice(0, 3) },
      { ...good, topics: [`0x${'00'.repeat(32)}`, ...good.topics.slice(1)] },
      { ...good, topics: 'nope' },
      { ...good, data: `${good.data}00` },
      { ...good, data: undefined },
      { ...good, data: `0x${'zz'.repeat(128)}` },
      { ...good, topics: [good.topics[0], '0x01', good.topics[2], good.topics[3]] },
      { ...good, address: 'not an address' },
    ];
    for (const log of malformed) {
      expect(findUserOperation(receipt([log]), { bundleHash: BUNDLE, sender: SENDER })).toEqual({
        kind: 'none',
      });
    }
    expect(
      findUserOperation(receipt([...malformed, good]), { bundleHash: BUNDLE, sender: SENDER }).kind,
    ).toBe('one');
  });

  it(`reads up to ${MAX_BUNDLE_LOGS} logs, and matches nothing in a receipt with more`, () => {
    const filler = eventLog({ sender: OTHER_SENDER });
    const atBound = [...Array.from({ length: MAX_BUNDLE_LOGS - 1 }, () => filler), eventLog()];
    expect(findUserOperation(receipt(atBound), { bundleHash: BUNDLE, sender: SENDER }).kind).toBe(
      'one',
    );
    expect(
      findUserOperation(receipt([eventLog(), ...atBound]), { bundleHash: BUNDLE, sender: SENDER }),
    ).toEqual({ kind: 'too many logs' });
    // A sparse array is not walked.
    expect(
      findUserOperation(receipt(new Array(2 ** 32 - 1)), { bundleHash: BUNDLE, sender: SENDER }),
    ).toEqual({ kind: 'too many logs' });
  });

  it('records the block only when it is a quantity', () => {
    for (const blockNumber of [undefined, 42, '0x', `0x${'1'.repeat(65)}`, 'a block']) {
      const found = findUserOperation(receipt([eventLog()], { blockNumber }), {
        bundleHash: BUNDLE,
        sender: SENDER,
      });
      expect(found.kind === 'one' && found.receipt.blockNumber).toBeUndefined();
    }
  });
});
