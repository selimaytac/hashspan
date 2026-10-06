import { describe, expect, it, vi } from 'vitest';
import { classifiedErrorName, sendFailure } from '../src/send-error.js';

/** An error named `name` with `cause`, as viem builds them (own `name` and `cause`). */
const named = (name: string, cause?: unknown): Error => {
  const error = new Error(name, cause === undefined ? undefined : { cause });
  error.name = name;
  return error;
};

describe('the classified error of a failed send', () => {
  it('is the error under one wrapper', () => {
    for (const wrapper of [
      'TransactionExecutionError',
      'ContractFunctionExecutionError',
      'EstimateGasExecutionError',
      'UserOperationExecutionError',
    ]) {
      expect(classifiedErrorName(named(wrapper, named('NonceTooLowError')))).toBe(
        'NonceTooLowError',
      );
    }
  });

  it('is the error under two wrappers, as writeContract throws it', () => {
    const error = named(
      'ContractFunctionExecutionError',
      named('TransactionExecutionError', named('InsufficientFundsError', named('RpcRequestError'))),
    );
    expect(classifiedErrorName(error)).toBe('InsufficientFundsError');
  });

  it('is undefined for an error that is not a wrapper, so the thrown class is recorded', () => {
    expect(classifiedErrorName(named('UserRejectedRequestError', named('RpcRequestError')))).toBe(
      undefined,
    );
    expect(classifiedErrorName(new TypeError('boom'))).toBeUndefined();
    expect(classifiedErrorName(undefined)).toBeUndefined();
    expect(classifiedErrorName('TransactionExecutionError')).toBeUndefined();
  });

  it('is undefined when nothing named is under the wrappers', () => {
    // A cause without a name, such as a raw JSON-RPC error object, or no cause at all.
    expect(
      classifiedErrorName(named('TransactionExecutionError', { code: -32000 })),
    ).toBeUndefined();
    expect(classifiedErrorName(named('TransactionExecutionError'))).toBeUndefined();
    expect(
      classifiedErrorName(
        named('TransactionExecutionError', named('ContractFunctionExecutionError')),
      ),
    ).toBeUndefined();
  });

  it('is undefined for a cyclic or a deep chain of wrappers', () => {
    const cyclic = named('TransactionExecutionError');
    const inner = named('ContractFunctionExecutionError', cyclic);
    Object.defineProperty(cyclic, 'cause', { value: inner });
    expect(classifiedErrorName(cyclic)).toBeUndefined();

    let deep: Error = named('NonceTooLowError');
    for (let i = 0; i < 20; i++) deep = named('TransactionExecutionError', deep);
    expect(classifiedErrorName(deep)).toBeUndefined();
  });

  it('runs no getter: a name or cause behind an accessor is not read', () => {
    const cause = vi.fn(() => named('NonceTooLowError'));
    const error = named('TransactionExecutionError');
    Object.defineProperty(error, 'cause', { get: cause });
    expect(classifiedErrorName(error)).toBeUndefined();
    expect(cause).not.toHaveBeenCalled();

    const name = vi.fn(() => 'TransactionExecutionError');
    const getterName = Object.defineProperty(new Error('x'), 'name', { get: name });
    expect(classifiedErrorName(getterName)).toBeUndefined();
    expect(name).not.toHaveBeenCalled();
  });

  it('never throws, also for a Proxy whose traps throw', () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('trap');
        },
      },
    );
    expect(classifiedErrorName(hostile)).toBeUndefined();
    expect(classifiedErrorName(named('TransactionExecutionError', hostile))).toBeUndefined();
  });

  it('becomes the error type of the fail options, next to the end time', () => {
    const at = new Date(1_000);
    expect(sendFailure(named('TransactionExecutionError', named('NonceTooLowError')), at)).toEqual({
      endTime: at,
      errorType: 'NonceTooLowError',
    });
    expect(sendFailure(named('UserRejectedRequestError'))).toEqual({});
  });
});
