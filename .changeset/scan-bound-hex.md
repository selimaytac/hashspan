---
'@hashspan/core': patch
---

`sanitized` error messages: a hex value that is still cut at the end of the scanned part of a long first line, and is
no longer than the hex values kept, is dropped instead of recorded in part.
