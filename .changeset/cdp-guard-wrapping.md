---
'@hashspan/cdp': patch
---

Wrapping a result of the SDK can no longer fail a call that succeeded: an account, quote or network-scoped account
that cannot be wrapped, such as a frozen one, is returned as it is, untraced, and one such account in
`listAccounts` leaves the others traced. An account is marked as wrapped only once all its methods were replaced,
and wrapping it again traces each call once. A call whose options throw when read is made untraced.
