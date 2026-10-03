---
'@hashspan/viem': patch
---

A revert reason cut to its 1024-character bound no longer keeps part of a hex value that the cut splits: the part left
was too short to be recognised as an address, so in `off` and `hashed` address mode most of an address in a long
revert reason could be recorded. The hex value at the cut is now dropped whole.
