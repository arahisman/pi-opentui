# Public alpha verification

Version: `0.1.0-alpha.1` · verified 2026-11-13 on macOS arm64.

## Results

- Strict TypeScript check passed.
- Full behavioral suite: **162 passed, 0 failed, 4,488 assertions across 25 files** (27.05 seconds). This machine also had the optional modules needed for the installed-module tests; those tests use isolated configuration and offline fixtures.
- 35 actual OpenTUI terminal-cell captures completed. Conversation and narrow-sidebar screenshots were visually inspected. No separate HTML recreation of the interface was used.
- The exact release archive was installed with production dependencies in a temporary isolated HOME, using **Node 26.4.0**, Pi SDK 1.5.2 and bundled Bun 1.4.4.
- Installed CLI help and Pi extension discovery passed.
- Actual PTY standalone launch, resize and exit restored terminal state.
- Actual native Pi extension handoff and return passed; the child process exited before return.
- Model-request audit observed no model calls during these installed-package checks.
- Temporary installation was removed after verification.
- All 27 packaged files matched the checkout after the clean-install check.
- Voluntary advisor feedback was checked through the actual registered SDK tool, including invalid IDs, cancellation, reopening and branch navigation. History ordering, relative-time refresh, selection and scrolling have regression coverage.
- Independent release review approved package metadata, optional-config failure isolation, privacy hygiene and palette attribution.

Archive: `pi-opentui-0.1.0-alpha.1.tgz`

SHA256: `da5165f8c0a76ac74b3f283b99685d6052453d62dabffec321d6e511e9cbabd5`

## Scope and limitations

These results validate the local macOS arm64 release path, not Linux/Windows, external services or every third-party Pi extension. The GitHub workflow runs typechecking, tests and package composition checks on Linux; its result is independent of the local results recorded here. Live model subscriptions and remote MCP services were not exercised.

Optional adapters remain optional. No private plugins, account credentials, extracted Claude Code skills, local benchmark sessions or development captures are shipped in the npm archive. Its contents are limited by the package's `files` list. The repository includes one screenshot made from offline fixture data.

## Reproduce

Use the commands in the README. `npm run verify:package` writes detailed local evidence under `.artifacts/verification/package-install.json`, including exact commands, exit statuses and archive hash. That directory is ignored by Git. A run records its own results; this document does not imply a later checkout was checked without running the commands again.
