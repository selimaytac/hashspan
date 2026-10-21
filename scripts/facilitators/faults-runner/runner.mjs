// The faults proxy of the facilitator matrix, run in the `e14-faults` container inside Anvil's network namespace:
// `@hashspan/faults` in front of FAULT_UPSTREAM (Anvil on 127.0.0.1), with the rules of FAULT_SCENARIO. It prints one
// JSON line with its URL, then a JSON line with the request counts by method each time they change; the harness reads
// both with `docker logs`. Remote upstreams stay refused: the upstream is loopback inside the namespace.
import { startFaultProxy } from '@hashspan/faults';
import { parseScenario } from './scenario.mjs';

const upstream = process.env.FAULT_UPSTREAM ?? 'http://127.0.0.1:8545';
const rules = parseScenario(process.env.FAULT_SCENARIO);
const proxy = await startFaultProxy(upstream);
proxy.set(rules);
console.log(JSON.stringify({ proxy: proxy.url }));

let last = '';
const report = () => {
  const line = JSON.stringify({ requests: proxy.requests() });
  if (line !== last) {
    last = line;
    console.log(line);
  }
};
report();
const timer = setInterval(report, 200);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    clearInterval(timer);
    report();
    proxy.stop().finally(() => process.exit(0));
  });
}
