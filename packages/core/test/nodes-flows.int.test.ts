// Runs the flows of the dev-node matrix (scripts/nodes/) on a local Anvil, the binary scripts/install-anvil.sh pins,
// and checks the answers against the vendored execution-apis schemas: the fee history validates, and every receipt
// validates except for the one field Anvil adds that the spec at the pinned commit does not list, `blockTimestamp`
// (a JSON number). That difference is what the matrix reports, so the test pins it rather than hiding it.
import { afterAll, describe, expect, it } from 'vitest';
import { runFlows } from '../../../scripts/nodes/flows.mjs';
import { probe } from '../../../scripts/nodes/probes.mjs';
import { buildResult, resultProblems, resultText } from '../../../scripts/nodes/result.mjs';
import { client } from '../../../scripts/nodes/rpc.mjs';
import { loadSpec } from '../../../scripts/nodes/schemas.mjs';
import { genesisOf } from '../../../scripts/nodes/setup.mjs';
import { targets } from '../../../scripts/nodes/targets.mjs';
import { startAnvil } from '../../viem/test/start-anvil.js';

const { instance, rpcUrl } = await startAnvil({
  binary: new URL('../../../.tools/bin/anvil', import.meta.url).pathname,
});
afterAll(async () => {
  await instance.stop();
});

const spec = loadSpec();
const rpc = client(rpcUrl);
const genesis = await genesisOf(rpc, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
const probes = await probe(rpc);
const flows = await runFlows({ rpc, chainId: genesis.chainId, probes, node: targets.anvil }, spec);

type Row = {
  flow: string;
  call: string;
  field: string;
  kind: string;
  got: unknown;
  outcome: string;
  known?: string;
};
const rows: Row[] = flows.flatMap((f: { checks: Row[] }) => f.checks);
const BLOCK_TIMESTAMP = ['/ additionalProperties blockTimestamp (number)'];

describe('dev-node flows on Anvil', () => {
  it('runs every flow, as Anvil offers every probed feature', () => {
    expect(probes).toEqual({
      eth_simulateV1: 'supported',
      debug_traceTransaction: 'supported',
      eth_getBlockReceipts: 'supported',
      eip7702: 'supported',
      eip4844: 'supported',
      eth_sendTransaction: 'supported',
    });
    expect(
      flows.map((f: { flow: string; status: string; error?: string }) => [
        f.flow,
        f.status,
        f.error,
      ]),
    ).toEqual(flows.map((f: { flow: string }) => [f.flow, 'run', undefined]));
    expect(genesis.chainId).toBe(31337);
  });

  it('validates the fee history against the schema and the spec rows of its lengths', () => {
    const feeHistory = rows.filter((r) => r.flow === 'fee-history' && r.kind === 'spec');
    expect(feeHistory.map((r) => [r.field, r.outcome])).toEqual([
      ['schema', 'match'],
      ['baseFeePerGas length', 'match'],
      ['reward length', 'match'],
    ]);
  });

  it('validates every receipt but for blockTimestamp, which the pinned spec does not list', () => {
    const receipts = rows.filter(
      (r) => r.field === 'schema' && /receipt/i.test(r.call) && r.flow !== 'block-receipts',
    );
    // One per mined transaction: deploy, three transfers, emit, the reverted and out-of-gas sends, 7702 and 4844.
    expect(receipts.length).toBe(9);
    for (const r of receipts)
      expect({ call: `${r.flow} ${r.call}`, got: r.got }).toEqual({
        call: `${r.flow} ${r.call}`,
        got: BLOCK_TIMESTAMP,
      });
    const block = rows.find((r) => r.flow === 'block-receipts' && r.field === 'schema');
    expect(block?.got).toEqual(['/0 additionalProperties blockTimestamp (number)']);
    // Nothing else of the spec differs on Anvil.
    const other = rows.filter(
      (r) => r.kind === 'spec' && r.outcome !== 'match' && r.field !== 'schema',
    );
    expect(other).toEqual([]);
  });

  it('records the types and statuses the transactions asked for', () => {
    const types = rows.filter((r) => r.field === 'type').map((r) => [r.flow, r.got]);
    expect(types).toEqual([
      ['deploy', '0x2'],
      ['legacy', '0x0'],
      ['eip2930', '0x1'],
      ['eip1559', '0x2'],
      ['logs', '0x2'],
      ['revert-reason', '0x2'],
      ['out-of-gas', '0x2'],
      ['eip7702', '0x4'],
      ['eip4844', '0x3'],
    ]);
    expect(rows.find((r) => r.flow === 'eip4844' && r.field === 'wrapper accepted')?.got).toBe(
      'v1',
    );
    expect(rows.find((r) => r.flow === 'eip7702' && r.field === 'delegation')?.got).toBe(
      'to the contract',
    );
  });

  it('shows the concurrent sends as distinct nonces or as the known foundry#17354', () => {
    const row = rows.find((r) => r.field === 'distinct nonces');
    // The race of foundry#17354 is fixed after v1.8.5 and does not show on every run.
    expect(row?.outcome === 'match' || row?.known === 'foundry#17354').toBe(true);
  });

  it('builds a result that passes the host-data check', () => {
    const result = buildResult({
      harness: { commit: 'test' },
      spec: { commit: 'test' },
      node: { name: 'anvil', title: 'Anvil', version: 'test' },
      runDate: '2026-10-21',
      genesis,
      probes,
      flows,
    });
    expect(resultProblems(resultText(result))).toEqual([]);
  });
});
