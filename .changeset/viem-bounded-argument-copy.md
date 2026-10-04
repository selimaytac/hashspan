---
'@hashspan/viem': patch
---

`writeContract` reads the call's arguments only to tell the overloads of a function apart, and its copies of the
arguments and of the ABI are bounded (100 000 values; an ABI of at most 10 000 items). Before, it copied every
argument before the call even for a function without overloads, so a wide or sparse argument added work on the
caller's path. Past a bound, no function selector is recorded; the call is unchanged.
