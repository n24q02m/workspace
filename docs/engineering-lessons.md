# Engineering lessons

These entries were recovered from the working ledgers this repository kept at its root
until 2026-11-11: the notes of a discontinued automated assistant that proposed changes
under one remit -- performance (`bolt.md`). The entries are kept verbatim, each in the
shape it was written. The `**Commit:**` line under a heading names the commit that
landed that entry, so a settled question can be found in the repository history before
the same change is proposed again. A few entries quote the paths the ledgers occupied
before this move; those paths no longer exist.

# Performance (`bolt.md`)

## 2025-02-28 - Avoid array allocations in tight loops

**Commit:** `a4dee12`

**Learning:** For rendering large strings from arrays (e.g. converting 10,000+ sheet rows to CSV or text), chaining array methods like `row.map(cell => cell || '').join(',')` inside a `forEach` loop causes high object allocation overhead, slowing execution and increasing garbage collection pressure.
**Action:** Replace `Array.prototype.forEach`, `.map()`, and `.join()` in tight loops with primitive nested `for` loops and direct string concatenation. This drastically lowers GC pressure and speeds up execution for large datasets.
