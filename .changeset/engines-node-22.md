---
"@hashspan/core": minor
"@hashspan/viem": minor
---

Require Node.js 22.3 or later (`engines`). Node.js 18 and 20 have reached end of life, and `hashed` address mode relies
on `process.getBuiltinModule`, available from Node.js 22.3; the packages are built for that target.
