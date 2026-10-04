---
'@hashspan/core': patch
---

In `off` and `hashed` address mode, an address that follows another hex value directly (`0x…0x<address>`) is now
recognised: a `0x` starts a new hex value. Before, the first value took the second address's leading `0`, and the
remaining 40 digits were recorded as they were. Found by the new property-based tests. A `0` followed by an `x` that starts no hex value stays part of the value before it, so an address ending in `0` and
followed by text such as `xyz` is recognised too.
