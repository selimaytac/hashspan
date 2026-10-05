---
'@hashspan/core': patch
---

A user operation receipt whose `success` is not a boolean (missing, `null`, a string) now ends the confirm span as a
failure with `error.type` `_OTHER`, and its confirmation duration sample carries `error.type` `_OTHER`, with no fee
sample. A transaction receipt with an unknown status already ends this way. Until now such a span ended without an
error status and its sample had no outcome label.
