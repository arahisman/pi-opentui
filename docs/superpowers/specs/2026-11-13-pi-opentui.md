# pi-opentui — agreed product and compatibility requirements

Build a redistributable, installable Pi package with a real OpenTUI frontend, preserving Pi's SDK, model subscriptions, tools, resource discovery and persistent session semantics. No edits to Pi core. No changes to ongoing benchmarks or global model/auth configuration.

## Authoritative visual references

Approved main screen: OpenCode-inspired terminal layout with a single scrolling sidebar.
Approved screen families: exec-f92767c2-e09a-482f-a34e-f36c89d24feb.png (welcome, palette, completion, sessions), exec-1c9ff0b1-df03-48cc-b5a8-d33d6d98aac1.png (models, settings, sign-in, connections), exec-883c610a-0e4a-49b2-ba7c-c0f82b7aaba0.png (usage, context, advisor detail, session tree), exec-c51b5ed9-0264-471f-8eaa-42b8021e86a2.png (questions, tools, errors, narrow viewport), all in the same directory.

Palette comes from the installed OpenCode palette in ~/.pi/agent/local-packages/experiment/opencode-palette.json. Solid terminal colors, consistent spacing and bounded geometry; no web UI pretending to be a terminal.

## Scope

- Chat with streaming text/thinking, styled Markdown, expandable tool calls/results, readable edits/diffs, queued follow-up/steering and cancel/retry.
- One independently scrollable sidebar: concise usage by model and truthful aggregate totals first, current context/cache/compaction next, then advisor history. Agent activity, MCP/LSP/extension health available without duplicate panels.
- All usage includes main/subagents/advisor/compaction where actually reported; distinguish missing usage, unpriced calls and API-equivalent estimates from subscription quota. Use existing ledger when available without double counting; native-session fallback when absent. Persist/restore navigation and drafts appropriately.
- Advisor history uses actual names/models, notes, disposition and message linkage; never invent acceptance or model recommendations. Without advisor show an honest optional-module state.
- Welcome, command palette, slash completion, model/reasoning selection, settings with safe apply, session search/list/resume, session tree/branching, context and usage details, advisor details, provider connection/status, tools and extension dialogs.
- OpenCode-style keyboard and mouse behavior: Ctrl+P palette, Enter send/select, Shift+Enter newline, Esc close/cancel, model/session/new-session leader shortcuts, visible hints, search, text selection/copy where terminal permits. Preserve useful Pi commands through discovery. Keyboard accessible overlays and focus restoration.
- Resize must preserve draft/focus/scroll and avoid overflow, duplicate renderers/listeners, stale geometry or terminal artifacts. Narrow screens collapse sidebar to a reachable overlay. Independent scroll and user-controlled return to latest.
- Fullscreen native OpenTUI rendering, stable redraw scheduling and bounded long-history rendering; no model call for UI operations.
- Installable package plus CLI launcher; Pi extension provides entry/discovery. Package must not silently take over ordinary Pi sessions or break noninteractive modes. Standalone works with clean Pi and no optional packages.
- Existing experiment accounting/compaction/RTK/questionnaire, subagents, advisor, history, session search, Superpowers/skills, web access, notification, LSP and MCP retain their nonvisual behavior. Replace competing visual layers through host capability handling rather than loading multiple sidebars. Arbitrary Pi custom dialog components need a compatible bridge or explicit tested presentation, never silently ignored.
- Preserve saved sessions, source requirements, tools, auth, compaction behavior and model defaults. Unavailable plugins must not crash UI. Do not expose credentials in screens/logs.

## Architecture decision to validate

Pi 1.5.2 RPC drops custom component UIs, so use SDK with a complete ExtensionUIContext host and explicit native component compatibility bridge. OpenTUI owns terminal render/input. Use the installed SDK contracts; include built-in MCP/codemode/tool-search factories explicitly. Run a compatible isolated Bun runtime instead of changing the global runtime while benchmarks run. No production-only hardcoded user paths; installed local paths are discovery inputs/tests, not package requirements.

## Completion evidence

Real OpenTUI offscreen rendering and input/resize tests at wide, narrow and tiny dimensions; visual screenshots rendered from actual captured terminal cells and inspected against reference families; real Pi SDK integration with clean and installed-module fixtures; session resume/draft, no-key offline mock-model streaming/tool/error/dialog smoke tests; package archive install in a clean isolated agent directory; verify launch and teardown restore terminal resources. Typecheck/test/build/package checks and independent review. Document exact supported contracts, meaningful limitations and installation. A passing screenshot alone does not prove compatibility.
