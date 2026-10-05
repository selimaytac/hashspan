---
'@hashspan/core': patch
---

A user operation receipt whose `success` is present but not a boolean (`null`, a string, a number) now ends the
confirm span as a failure with `error.type` `_OTHER`, and its confirmation duration sample carries `error.type`
`_OTHER`, with no fee sample, as a transaction receipt with an unknown status does. Until now such a span ended
without an error status and its sample had no outcome label. A receipt without `success`, as `@hashspan/cdp` reports
an operation whose outcome it does not know, ends as before: no error and no outcome label. `success` is read from an
own data property only.
