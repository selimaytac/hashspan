# Security policy

## Reporting a vulnerability

Please **do not** open a public issue. Report vulnerabilities privately through GitHub's private vulnerability
reporting: <https://github.com/selimaytac/hashspan/security/advisories/new> (or **Security → Report a vulnerability**
on this repository).

Please include the affected package and version, the configuration (address mode, error message mode, adapter), a
reproduction or a test that shows the problem, and the impact you see.

You can expect an acknowledgement within 5 business days. We then confirm or decline the report, agree on a fix and a
disclosure date with you, release the fix, and publish a GitHub security advisory that credits you unless you prefer
not to be named.

## Security model

hashspan never signs or broadcasts transactions and needs no private keys. It runs inside the application it
instruments and records telemetry about that application's transactions and payments.

**Trusted:** the application's own code and configuration, including callbacks it passes (`hash`, `redact`) and the
OpenTelemetry SDK and exporters it sets up.

**Untrusted** ([ADR 0025](docs/adr/0025-untrusted-input.md)): everything a remote party sends (RPC nodes, bundlers,
x402 servers and facilitators, the CDP API, inbound Baggage), and the values the application passes to traced calls.
hashspan validates and bounds what it records from them, and never lets them make the instrumentation throw into or
change a traced call.

**In scope**, for example:

- Data recorded that the configured privacy settings should keep out: an address in `off` or `hashed` mode, an error
  message in `off` mode, a URL path or query in a sanitized message.
- Instrumentation that throws into, delays or changes the result of the application's call.
- Memory, time or spans that a remote party can make grow without bound.
- The release process: anything that could publish a package not built from this repository's `main`.

**Out of scope:**

- Values recorded because the application turned them on (`raw` addresses, `raw` error messages,
  `recordFunctionArguments`), or allowed by its `redact` hook.
- Spans of other instrumentation in the same trace, which follow their own settings (see the
  [privacy notes](packages/core/README.md#privacy-notes)).
- What a transaction hash reveals on chain: anyone can look a transaction up in a block explorer.
- Weaknesses of the application's own OpenTelemetry pipeline, such as exporting over plain HTTP.

## Supported versions

Only the latest minor release receives security fixes while the project is below 1.0.
