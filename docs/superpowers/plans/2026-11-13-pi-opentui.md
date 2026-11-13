# pi-opentui implementation plan

Goal: deliver the agreed installable OpenTUI frontend and Pi extension with tested module compatibility.
Architecture: OpenTUI owns terminal; Pi SDK owns sessions/tools/models/resources; adapters normalize optional modules without inventing data. Native component bridge supports Pi extension dialogs. Global installations and running benchmarks remain untouched during development.
Spec: ../specs/2026-11-13-pi-opentui.md

1. Establish package, exact runtime contracts and compatibility inventory. Save reference requirements and installation boundaries. Verify isolated Bun/OpenTUI test renderer plus installed Pi SDK load.
2. Implement domain state/reducers, session projections, accounting/advisor/compaction adapters and persistent UI preferences/drafts. Test real fixture variants, missing modules and no-double-counting.
3. Implement OpenTUI layout, conversation and single sidebar with virtualized/bounded history, theme and resize-safe independent scrolling. Test captures and actual input/resize.
4. Implement composer, commands, overlays and all approved screen families; bridge extension select/confirm/input/editor/custom components. Check keyboard parity/focus and fallback behavior.
5. Connect actual Pi SDK lifecycle, resources, command handlers, model/auth/settings/session operations and optional integration capabilities. Add installable extension/CLI handoff and clean-mode launch. Verify mock-provider end-to-end without consuming subscriptions.
6. Exercise installed modules and package in isolated environments. Render and inspect full visual matrix, resize stress and clean shutdown; fix failures. Independent review, focused recheck, README/install/package deliverable.

Review focus: misleading costs or lost child usage; dialog/input deadlock; competing renderers touching stdout; session switch losing source/draft/branch; resize causing scroll/focus corruption; optional modules failing clean install; successful UI masking failed tools/provider operations.
