# Alpha 0.1.0-alpha.3 verification

The npm distribution is named `@arahisman/pi-opentui`: npm rejected `pi-opentui` because it is too similar to the existing `pi-open-tui`. The command and GitHub project remain `pi-opentui`.

Changes are limited to package name/version, gallery preview metadata, installation documentation and making the package smoke checker derive the installed path from the actual packed package name. Runtime source is unchanged from [alpha.2](releases/0.1.0-alpha.2.md), whose 170 tests, real inspector regression and visual checks remain applicable.

## New checks

- Strict TypeScript checking passed.
- The scoped archive was installed with production dependencies in an isolated temporary HOME under Node26.4.0. Installed CLI help, extension discovery, actual PTY launch/resize/exit and native Pi handoff/return all passed. No provider calls were made; the temporary installation was removed.
- All 28 packaged files matched the checkout after installation.
- The `pi-package` keyword is present and `pi.image` points to the public screenshot. These make the package eligible for catalog discovery; immediate listing is not claimed.

Archive: `arahisman-pi-opentui-0.1.0-alpha.3.tgz`

SHA256: `10bff2c4e733281e14c8a6941d54cfa73945688e035d0557020413c76bbd9da2`

Detailed local evidence is generated under ignored `.artifacts/verification/`. Other platform and extension limitations in the README still apply.

## Current main: compaction presentation fix (after alpha.3)

The checkout now keeps a dedicated progress block and animated compacting status during manual, automatic and extension-triggered compaction. Successful compaction hides only its associated interrupted-response error; cancellation and failures remain visible. Session messages are retained unchanged, and the presentation attribution respects the active branch and reopening.

Verification: strict TypeScript checking passed; the complete suite passed 187 tests with 4,723 assertions across 29 files. This includes actual SDK lifecycle fixtures, extension-origin abort/compact, native manual/threshold/overflow paths, cancellation/failure, persisted attribution, selection, real PTY resize/exit, and native Pi handoff. All model providers used by tests were offline fixtures. Actual rendered wide and narrow compaction screens were inspected. Detailed local logs and screenshots are under ignored `.artifacts/verification/`.

These source changes are newer than the published alpha.3 archive; that archive and its checksum above remain unchanged.
