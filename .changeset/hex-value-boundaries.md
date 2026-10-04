---
'@hashspan/core': patch
---

In `off` and `hashed` address mode, an address that follows another hex value directly (`0x…0x<address>`) is now
recognised: a `0x` starts a new hex value. Before, the first value took the second address's leading `0`, and the
remaining 40 digits were recorded as they were. Found by the new property-based tests.
