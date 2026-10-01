---
"@hashspan/viem": patch
---

A traced `waitForTransactionReceipt` behaves like viem's own with any options object: frozen options no longer throw
"Cannot redefine property: onReplaced", and an `onReplaced` callback inherited from a prototype is called again.
The adapter now passes viem an object whose prototype is the caller's options instead of a copy.
