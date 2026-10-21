---
'@hashspan/faults': minor
---

Add the fault kind `truncate` (ADR 0032): the proxy sends the headers, with a `content-length` larger than what
follows, and part of the body, then resets the connection, so the client gets those bytes and then a reset, a
response cut off mid-body. The reset follows a few milliseconds after the bytes were written, which keeps it from
being lost on a keep-alive connection that has carried many exchanges. Like `reset`, it never reaches the node.
