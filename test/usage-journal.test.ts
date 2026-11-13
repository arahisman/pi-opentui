import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadUsageJournal } from "../src/core/usage-journal.ts";
import { loadUsage } from "../src/core/session-data.ts";
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-journal-"));
  directories.push(directory);
  const root = join(directory, "root.jsonl"),
    events = `${root}.usage/events`;
  writeFileSync(
    root,
    JSON.stringify({
      type: "session",
      id: "root",
      timestamp: "2026-01-01T00:00:00Z",
      cwd: directory,
    }) + "\n",
  );
  mkdirSync(events, { recursive: true });
  return { root, events };
}
function event(root: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    eventId: "event",
    timestamp: "2026-01-01T00:00:01Z",
    rootSession: root,
    sessionFile: root,
    sessionId: "main",
    role: "primary",
    provider: "p",
    model: "m",
    reported: true,
    tokens: { input: 10, output: 3, cacheRead: 2, cacheWrite: 1 },
    reasoning: null,
    estimatedCost: 0.1,
    ...overrides,
  };
}
function write(path: string, events: unknown[]) {
  writeFileSync(
    path,
    events.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
}
const native = [
  {
    type: "message",
    id: "native",
    message: {
      role: "assistant",
      timestamp: 1,
      provider: "p",
      model: "m",
      usage: {
        input: 999,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 9 },
      },
    },
  },
];
test("missing summary recovers main, child, advisor and compaction totals without native addition", () => {
  const { root, events } = fixture();
  write(join(events, "a.jsonl"), [
    event(root),
    event(root, {
      eventId: "child",
      sessionId: "child",
      sessionFile: join(events, "child.jsonl"),
      role: "subagent",
      model: "child-model",
    }),
    event(root, {
      eventId: "advisor",
      role: "advisor",
      advisor: "Muse",
      model: "advisor-model",
    }),
    event(root, {
      eventId: "compact",
      role: "compaction",
      model: "summary-model",
    }),
  ]);
  const before = readFileSync(join(events, "a.jsonl"), "utf8"),
    usage = loadUsage(root, native);
  expect(usage.source).toBe("ledger");
  expect(usage.coverage).toBe("all-reported-agents");
  expect(usage.totals.input).toBe(40);
  expect(usage.totals.cost).toBe(0.4);
  expect(Object.keys(usage.byModel)).toHaveLength(4);
  expect(Object.keys(usage.byAgent)).toContain("main:advisor:Muse");
  expect(readFileSync(join(events, "a.jsonl"), "utf8")).toBe(before);
});
test("request starts/results dedupe by session and request across files; pending counts unknown, known zero remains priced", () => {
  const { root, events } = fixture(),
    started = event(root, {
      eventId: "start",
      requestId: "call",
      phase: "started",
      reported: false,
      tokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
      estimatedCost: null,
    });
  write(join(events, "a.jsonl"), [
    started,
    event(root, {
      eventId: "complete",
      requestId: "call",
      phase: "completed",
      estimatedCost: 0,
    }),
    event(root, {
      eventId: "pending",
      requestId: "pending",
      phase: "started",
      reported: false,
      tokens: {},
      estimatedCost: null,
    }),
    event(root, { eventId: "unpriced", estimatedCost: null }),
  ]);
  write(join(events, "z.jsonl"), [
    started,
    event(root, {
      eventId: "duplicate",
      requestId: "call",
      phase: "completed",
      tokens: { input: 999, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
    event(root, {
      eventId: "other-session",
      sessionId: "child",
      requestId: "call",
      estimatedCost: 0,
    }),
  ]);
  const result = loadUsageJournal(root).projection!;
  expect(result.totals.responses).toBe(4);
  expect(result.totals.input).toBe(30);
  expect(result.totals.missingUsage).toBe(1);
  expect(result.totals.unpriced).toBe(2);
  expect(result.totals.cost).toBe(0);
  expect(result.byAgent["child:primary:"]!.cost).toBe(0);
});
test("incomplete unterminated tail is explicit; completed malformed lines or records reject the whole journal", () => {
  const { root, events } = fixture(),
    file = join(events, "events.jsonl");
  write(file, [event(root)]);
  appendFileSync(file, '{"unfinished":');
  let result = loadUsageJournal(root);
  expect(result.projection?.totals.responses).toBe(1);
  expect(result.diagnostics[0]!.message).toContain("incomplete trailing");
  appendFileSync(file, "\n");
  result = loadUsageJournal(root);
  expect(result.projection).toBeUndefined();
  expect(result.diagnostics[0]!.message).toContain("Invalid usage event JSON");
  write(file, [
    event(root),
    event(root, {
      eventId: "bad",
      phase: "completed",
      tokens: { input: -2, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  ]);
  result = loadUsageJournal(root);
  expect(result.projection).toBeUndefined();
  expect(result.diagnostics[0]!.message).toContain("tokens");
});
test("wrong-root journal cannot supply totals for another session", () => {
  const { root, events } = fixture();
  write(join(events, "events.jsonl"), [
    event(root, { rootSession: join(events, "other.jsonl") }),
  ]);
  const result = loadUsage(root, native);
  expect(result.source).toBe("native");
  expect(result.totals.input).toBe(999);
  expect(result.warning).toContain("different rootSession");
});
test("stale summary with valid events retains full coverage and never adds summary or native totals", () => {
  const { root, events } = fixture();
  write(join(events, "events.jsonl"), [
    event(root),
    event(root, { eventId: "child", sessionId: "child", role: "subagent" }),
  ]);
  writeFileSync(
    `${root}.usage/summary.json`,
    JSON.stringify({
      version: 1,
      rootSession: root,
      updatedAt: "1970-01-01T00:00:00Z",
      totals: {
        responses: 1,
        unreportedResponses: 0,
        unpricedResponses: 0,
        tokens: { input: 9999, output: 0, cacheRead: 0, cacheWrite: 0 },
        estimatedCost: 20,
      },
      byModel: {},
      byAgent: {},
    }),
  );
  const result = loadUsage(root, native);
  expect(result.source).toBe("ledger");
  expect(result.totals.input).toBe(20);
  expect(result.coverage).toBe("all-reported-agents");
  expect(result.warning).toContain("predates");
});
test("event freshness and cache invalidation recover journal changes under existing summary", () => {
  const { root, events } = fixture(),
    file = join(events, "events.jsonl");
  write(file, [event(root)]);
  expect(loadUsageJournal(root).projection?.totals.input).toBe(10);
  appendFileSync(file, JSON.stringify(event(root, { eventId: "new" })) + "\n");
  expect(loadUsageJournal(root).projection?.totals.input).toBe(20);
  const future = new Date(Date.now() + 5000);
  utimesSync(file, future, future);
  expect(loadUsageJournal(root).projection?.totals.responses).toBe(2);
});
test("journal predating a native assistant is diagnosed without double counting", () => {
  const { root, events } = fixture();
  write(join(events, "events.jsonl"), [event(root)]);
  const latest = [
    {
      ...native[0],
      message: {
        ...native[0]!.message,
        timestamp: Date.parse("2026-01-02T00:00:00Z"),
      },
    },
  ];
  const result = loadUsage(root, latest);
  expect(result.source).toBe("ledger");
  expect(result.totals.input).toBe(10);
  expect(result.warning).toContain("may predate the latest main assistant");
});
test("empty or absent journal falls back to main only", () => {
  const { root, events } = fixture();
  expect(loadUsage(root, native).coverage).toBe("main-only");
  writeFileSync(join(events, "empty.jsonl"), "");
  expect(loadUsage(root, native).source).toBe("native");
  rmSync(events, { recursive: true });
  expect(loadUsage(root, native).source).toBe("native");
});
test("relative parent-session ancestry recovers the root's shared journal", () => {
  const { root, events } = fixture(),
    leaf = join(root + ".usage", "leaf.jsonl");
  writeFileSync(
    leaf,
    JSON.stringify({
      type: "session",
      id: "leaf",
      parentSession: "../root.jsonl",
    }) + "\n",
  );
  write(join(events, "child.jsonl"), [
    event(root, { sessionId: "child", sessionFile: leaf, role: "subagent" }),
  ]);
  const result = loadUsage(leaf, native);
  expect(result.source).toBe("ledger");
  expect(result.rootSession).toBe(root);
  expect(result.totals.input).toBe(10);
});
test("valid final JSON without newline is counted and all-pending cost remains unknown", () => {
  const { root, events } = fixture(),
    file = join(events, "pending.jsonl");
  writeFileSync(
    file,
    JSON.stringify(
      event(root, {
        phase: "started",
        requestId: "pending",
        reported: false,
        tokens: {
          input: null,
          output: null,
          cacheRead: null,
          cacheWrite: null,
        },
        estimatedCost: null,
      }),
    ),
  );
  const result = loadUsageJournal(root);
  expect(result.diagnostics).toEqual([]);
  expect(result.projection?.totals.responses).toBe(1);
  expect(result.projection?.totals.missingUsage).toBe(1);
  expect(result.projection?.totals.unpriced).toBe(1);
  expect(result.projection?.totals.cost).toBeNull();
});
test("malformed completed event falls back with explicit diagnostics even when prior records are valid", () => {
  const { root, events } = fixture();
  write(join(events, "events.jsonl"), [
    event(root),
    event(root, {
      eventId: "bad",
      phase: "completed",
      estimatedCost: "unknown",
    }),
  ]);
  const result = loadUsage(root, native);
  expect(result.source).toBe("native");
  expect(result.coverage).toBe("main-only");
  expect(result.totals.input).toBe(999);
  expect(result.warning).toContain("estimatedCost");
});

test("request detail uses the same completion deduplication as aggregate usage and does not expose extra payload", () => {
  const { root, events } = fixture();
  write(join(events, "main.jsonl"), [
    event(root, {
      eventId: "started",
      requestId: "r",
      phase: "started",
      reported: false,
      tokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
      estimatedCost: null,
    }),
    event(root, {
      eventId: "completed",
      requestId: "r",
      phase: "completed",
      secret: "must-not-be-exported",
    }),
    event(root, {
      eventId: "pending",
      requestId: "p",
      phase: "started",
      reported: false,
      tokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
      estimatedCost: null,
    }),
  ]);
  const result = loadUsageJournal(root);
  expect(result.requests).toHaveLength(2);
  expect(result.requests?.find((record) => record.id === "main:r")?.state).toBe(
    "completed",
  );
  expect(result.requests?.find((record) => record.id === "main:p")?.state).toBe(
    "pending",
  );
  expect(
    result.requests?.reduce((sum, record) => sum + record.usage.input, 0),
  ).toBe(result.projection?.totals.input);
  expect(JSON.stringify(result.requests)).not.toContain("must-not-be-exported");
});
