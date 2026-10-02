// A setup file (vitest.config.ts): it replaces the global `fetch` before any test file imports a library, so that
// only loopback requests reach the network. AgentKit sends an analytics event, unawaited, when a wallet provider is
// created and when an action runs, with no option to turn it off; a failed request ends the process
// (coinbase/agentkit#1531). The stub answers those requests, and any other one, with an empty 200 and records them.
import { vi } from 'vitest';

const ANALYTICS_HOST = 'cca-lite.coinbase.com';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Requests that did not go to localhost, by kind; tests expect no `unexpected` ones. */
export const offline: { analytics: string[]; unexpected: string[] } = {
  analytics: [],
  unexpected: [],
};

const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (LOOPBACK.has(url.hostname)) return realFetch(input, init);
  (url.hostname === ANALYTICS_HOST ? offline.analytics : offline.unexpected).push(url.href);
  return Promise.resolve(new Response(null, { status: 200 }));
});
