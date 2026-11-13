# Alpha acceptance scope

The release is an installable Pi frontend: it must launch with an isolated clean agent directory, load as a Pi extension, preserve session ownership across native handoff, restore terminal state on exit, and operate without optional private modules.

Required checks are strict typechecking, the behavioral test suite, actual terminal rendering/resize tests, visual inspection, and installation of the exact release archive in an isolated temporary home. Tests use offline fixtures; provider calls are not part of release verification.

Optional adapters must fail explicitly and leave native preferences usable. Malformed optional settings must not be overwritten. No private credentials, local skills or model subscriptions are shipped.

See [RELEASE.md](RELEASE.md) for the recorded release results and README for supported versions and limitations.
