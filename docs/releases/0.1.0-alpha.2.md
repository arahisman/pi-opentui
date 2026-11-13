# Alpha 0.1.0-alpha.2 verification

Verified 2026-11-13 on macOS arm64. Earlier release evidence: [0.1.0-alpha.1](releases/0.1.0-alpha.1.md).

## Changes

- Fixed a reproduced crash on the second Down key in the installed subagent inspector. Its Markdown renderer used the Pi SDK theme before initialization; the bridge now supplies its live theme to SDK components.
- Ctrl+X then Down opens the registered subagent inspector; Ctrl+X then Left/Right changes the selected agent. Missing extensions are reported locally and never turned into model prompts.
- Replaced the incompatible inline subagent shortcut hints and bounded their displayed width. Ordinary token-usage arrows remain intact.
- Normalized the verified Kitty functional-arrow encodings before native Pi dispatch, preserving modifiers and leaving unrelated input unchanged.
- Kept detached async subagent lifecycle unchanged. No global plugin files, running jobs or other sessions were modified.

## Evidence

- **170 tests passed, 0 failed; 4,581 assertions across 27 files** (27.71 seconds).
- Strict TypeScript checking passed.
- Regression reproduced the original second-Down failure against the actually installed fleet component before the fix. Post-fix checks navigate to child Markdown transcripts through actual Application keyboard dispatch, including plain Kitty arrows and the new leader shortcuts, with no provider calls.
- [Actual installed inspector screenshot](images/subagent-inspector.png) was rasterized from OpenTUI's real terminal-cell capture after selecting a child and was visually inspected. It shows the preserved editor draft behind the inspector.
- A race observed in the session-switch test was corrected by waiting for the actual session transition and settling it before fixture disposal, rather than depending on a 25ms delay.
- The exact archive was installed in an isolated temporary HOME with Node26.4.0, Pi SDK1.5.2 and bundled Bun1.4.4. CLI help, extension discovery, actual PTY standalone launch/resize/exit and native Pi handoff/return passed. The temporary installation was removed.
- All 28 packaged files matched the checkout byte for byte after verification.
- Independent review approved keyboard routing, draft preservation, dialog ownership and theme initialization.

Archive: `pi-opentui-0.1.0-alpha.2.tgz`

SHA256: `044a21f44a077f66bb747622da89a833e7774b320bcce3e51b18c1968ffedcb9`

## Limits

Other operating systems and arbitrary third-party extensions remain unverified by these local results. CI results are separate from this local evidence. Background-job survival and recovery remain governed by the installed subagent extension. Detailed local check logs are generated under ignored `.artifacts/verification/`; see the README for reproduction commands.
