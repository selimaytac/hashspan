// The one contract the flows deploy, assembled here from opcodes so no compiler is needed. Its first calldata byte
// picks what it does: 0x01 emits `Ping(uint256)` with 42, 0x02 reverts with `Error("nope")`, 0x03 reverts with the
// custom error `Custom(uint256)` with 7, 0x04 loops until it runs out of gas; anything else stops.
import { concatHex, encodeAbiParameters, toEventSelector, toFunctionSelector } from 'viem';

/** The event and the errors of the contract, by selector. */
export const PING_TOPIC = toEventSelector('Ping(uint256)');
export const ERROR_SELECTOR = toFunctionSelector('Error(string)');
export const CUSTOM_SELECTOR = toFunctionSelector('Custom(uint256)');

/** Calldata of each behaviour. */
export const CALL = { emit: '0x01', reason: '0x02', custom: '0x03', loop: '0x04' };

const OP = {
  STOP: 0x00,
  EQ: 0x14,
  SHR: 0x1c,
  CALLDATALOAD: 0x35,
  CODECOPY: 0x39,
  MSTORE: 0x52,
  JUMP: 0x56,
  JUMPI: 0x57,
  JUMPDEST: 0x5b,
  PUSH1: 0x60,
  PUSH2: 0x61,
  PUSH32: 0x7f,
  DUP1: 0x80,
  LOG1: 0xa1,
  RETURN: 0xf3,
  REVERT: 0xfd,
};

const hexBytes = (hex) => Buffer.from(hex.slice(2), 'hex');

/**
 * Assembles a list of opcodes, `[op, operand]` pushes, `{ label }` jump destinations and `{ push: label }` jumps
 * (PUSH2 of the label's offset), followed by `data` blobs addressed by `{ data: name }` pushes (PUSH2 of the offset)
 * and `{ size: name }` pushes (PUSH2 of the length). Returns the bytes as hex.
 */
export function assemble(program, data = {}) {
  const size = (item) => {
    if (typeof item === 'number') return 1;
    if (Array.isArray(item)) return 1 + hexBytes(item[1]).length;
    if ('label' in item) return 1;
    return 3;
  };
  const labels = {};
  let offset = 0;
  for (const item of program) {
    if (item?.label !== undefined) labels[item.label] = offset;
    offset += size(item);
  }
  const blobs = {};
  for (const [name, hex] of Object.entries(data)) {
    blobs[name] = { offset, length: hexBytes(hex).length };
    offset += blobs[name].length;
  }
  const push2 = (n) => [OP.PUSH2, (n >> 8) & 0xff, n & 0xff];
  const out = [];
  for (const item of program) {
    if (typeof item === 'number') out.push(item);
    else if (Array.isArray(item)) out.push(item[0], ...hexBytes(item[1]));
    else if ('label' in item) out.push(OP.JUMPDEST);
    else if ('push' in item) out.push(...push2(labels[item.push]));
    else if ('data' in item) out.push(...push2(blobs[item.data].offset));
    else out.push(...push2(blobs[item.size].length));
  }
  for (const hex of Object.values(data)) out.push(...hexBytes(hex));
  return `0x${Buffer.from(out).toString('hex')}`;
}

const reasonPayload = concatHex([
  ERROR_SELECTOR,
  encodeAbiParameters([{ type: 'string' }], ['nope']),
]);
const customPayload = concatHex([
  CUSTOM_SELECTOR,
  encodeAbiParameters([{ type: 'uint256' }], [7n]),
]);

/** Reverts with a data blob: copies it to memory 0 and reverts with it. */
const revertWith = (name) => [
  { size: name },
  { data: name },
  [OP.PUSH1, '0x00'],
  OP.CODECOPY,
  { size: name },
  [OP.PUSH1, '0x00'],
  OP.REVERT,
];

/** The runtime code of the contract. */
export const RUNTIME = assemble(
  [
    [OP.PUSH1, '0x00'],
    OP.CALLDATALOAD,
    [OP.PUSH1, '0xf8'],
    OP.SHR,
    ...['emit', 'reason', 'custom', 'loop'].flatMap((name, i) => [
      OP.DUP1,
      [OP.PUSH1, `0x0${i + 1}`],
      OP.EQ,
      { push: name },
      OP.JUMPI,
    ]),
    OP.STOP,
    { label: 'emit' },
    [OP.PUSH1, '0x2a'],
    [OP.PUSH1, '0x00'],
    OP.MSTORE,
    [OP.PUSH32, PING_TOPIC],
    [OP.PUSH1, '0x20'],
    [OP.PUSH1, '0x00'],
    OP.LOG1,
    OP.STOP,
    { label: 'reason' },
    ...revertWith('reason'),
    { label: 'custom' },
    ...revertWith('custom'),
    { label: 'loop' },
    { push: 'loop' },
    OP.JUMP,
  ],
  { reason: reasonPayload, custom: customPayload },
);

/** Creation code: copies the runtime that follows it to memory and returns it. */
export const INITCODE = (() => {
  const runtime = hexBytes(RUNTIME);
  const prefix = assemble(
    [
      { size: 'runtime' },
      { data: 'runtime' },
      [OP.PUSH1, '0x00'],
      OP.CODECOPY,
      { size: 'runtime' },
      [OP.PUSH1, '0x00'],
      OP.RETURN,
    ],
    { runtime: RUNTIME },
  );
  if (!prefix.endsWith(runtime.toString('hex')))
    throw new Error('initcode does not end with the runtime');
  return prefix;
})();
