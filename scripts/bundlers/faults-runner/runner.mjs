// The faults proxy of the bundler matrix, run in the `e16-faults` container inside Anvil's network namespace:
// `@hashspan/faults` in front of FAULT_UPSTREAM (Anvil on 127.0.0.1). Unlike the facilitator matrix's runner, it starts
// with no fault and applies the rules of FAULT_SCENARIO only on SIGUSR2 (`docker kill --signal SIGUSR2 e16-faults`),
// once the bundler is ready: a bundler sends eth_call and other requests while it starts, which a once-only fault
// would hit otherwise. SIGUSR1 is left alone, as Node.js keeps it for its inspector.
//
// It prints one JSON line with its URL, one when the rules are armed, then a JSON line with the request counts each
// time they change: `requests` since the proxy started (the egress check) and `sinceArmed` since the rules applied
// (whether a fault's method was reached). The harness reads them with `docker logs`.
import { startFaultProxy } from '@hashspan/faults';
import { parseScenario } from './scenario.mjs';

const upstream = process.env.FAULT_UPSTREAM ?? 'http://127.0.0.1:8545';
const rules = parseScenario(process.env.FAULT_SCENARIO);
const proxy = await startFaultProxy(upstream);
console.log(JSON.stringify({ proxy: proxy.url }));

/** Counts before the rules were armed: `set()` starts the proxy's counts again from 0. */
let before = {};
let armed = false;

const add = (a, b) => {
  const out = { ...a };
  for (const [method, n] of Object.entries(b)) out[method] = (out[method] ?? 0) + n;
  return out;
};

let last = '';
const report = () => {
  const now = proxy.requests();
  const line = JSON.stringify({
    requests: add(before, now),
    ...(armed ? { sinceArmed: now } : {}),
  });
  if (line !== last) {
    last = line;
    console.log(line);
  }
};
report();
const timer = setInterval(report, 200);

process.on('SIGUSR2', () => {
  if (armed) return;
  before = add(before, proxy.requests());
  proxy.set(rules);
  armed = true;
  console.log(JSON.stringify({ armed: true }));
  report();
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    clearInterval(timer);
    report();
    proxy.stop().finally(() => process.exit(0));
  });
}
