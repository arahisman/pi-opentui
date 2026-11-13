# Alpha 0.1.0-alpha.4 verification

This release includes the compaction presentation fix introduced after [alpha.3](releases/0.1.0-alpha.3.md).

Context compaction has a dedicated progress block and animated compacting status during manual, automatic and extension-triggered operations. Escape cancels compaction. A successful compaction hides only its associated interrupted-response error; cancellation and failures remain visible. Original session messages remain unchanged, and attribution respects the active branch and reopening.

## Verification

- The runtime source passed the complete suite: 187 tests, 4,723 assertions, 29 files. Strict TypeScript checking passed.
- Coverage includes actual SDK extension-origin abort/compact, manual/threshold/overflow operations, cancellation/failure, reopening and branch changes, selection stability, actual PTY resize/exit and native Pi handoff.
- Actual rendered compaction screens were inspected at 150×46 and 68×32 terminal cells.
- All model providers used by tests were offline fixtures; no paid calls were made.

The release archive passed isolated installation, extension discovery, standalone PTY startup/resize/exit and native Pi handoff/return. All packaged files matched the checkout byte for byte. Its checksum is attached to the GitHub release. Detailed local evidence is retained under ignored `.artifacts/verification/`.

Other platform and extension limitations in the README still apply.

Archive: `arahisman-pi-opentui-0.1.0-alpha.4.tgz`

SHA256: `a3aca73934cf09e098bac50cd298c837304d5c8b1ab059f92291762a64c54c23`
