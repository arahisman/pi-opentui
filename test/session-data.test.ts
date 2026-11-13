import { describe, expect, test, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUsage, projectTranscript } from "../src/core/session-data.ts";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const temp = () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-session-data-"));
  directories.push(directory);
  return directory;
};
const total = (input = 7) => ({
  responses: 1,
  unreportedResponses: 0,
  unpricedResponses: 0,
  tokens: { input, output: 3, cacheRead: 0, cacheWrite: 0 },
  estimatedCost: 0.1,
});
const assistant = {
  type: "message",
  id: "assistant",
  message: {
    role: "assistant",
    timestamp: 1,
    model: "m",
    provider: "p",
    usage: {
      input: 5,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0.2 },
    },
    content: [],
  },
};
function session(file: string, parentSession?: string) {
  writeFileSync(
    file,
    JSON.stringify({
      type: "session",
      version: 3,
      id: file,
      timestamp: "2026-01-01T00:00:00Z",
      cwd: "/tmp",
      ...(parentSession ? { parentSession } : {}),
    }) +
      "\n" +
      JSON.stringify(assistant) +
      "\n",
  );
}
function ledger(root: string, overrides: Record<string, unknown> = {}) {
  mkdirSync(`${root}.usage`, { recursive: true });
  writeFileSync(
    `${root}.usage/summary.json`,
    JSON.stringify({
      version: 1,
      rootSession: root,
      updatedAt: new Date().toISOString(),
      totals: total(),
      byModel: { "p/m": total() },
      byAgent: { main: { ...total(), role: "main" } },
      ...overrides,
    }),
  );
}

describe("transcript projection", () => {
  test("real Pi entry shapes preserve blocks, custom visibility, tool linkage, compaction and source immutability", () => {
    const entries = [
      {
        type: "message",
        id: "u",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Привет 🌍" },
            {
              type: "image",
              mimeType: "image/png",
              data: "private-image-data",
            },
          ],
        },
      },
      {
        type: "message",
        id: "a",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "reason" },
            { type: "text", text: "Answer" },
            {
              type: "toolCall",
              id: "call",
              name: "read",
              arguments: { path: "α.txt" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "r",
        message: {
          role: "toolResult",
          toolCallId: "call",
          toolName: "read",
          content: [{ type: "text", text: "file" }],
          isError: true,
        },
      },
      {
        type: "custom",
        id: "state",
        customType: "private",
        data: { content: "hidden" },
      },
      {
        type: "custom_message",
        id: "c",
        customType: "advisor",
        content: "Advice",
        display: true,
      },
      {
        type: "custom_message",
        id: "hidden",
        content: "secret",
        display: false,
      },
      {
        type: "message",
        id: "c2",
        message: {
          role: "custom",
          customType: "notice",
          content: [{ type: "text", text: "Notice" }],
          display: true,
        },
      },
      {
        type: "compaction",
        id: "compact",
        summary: "Summary",
        tokensBefore: 12000,
      },
      { type: "branch_summary", id: "branch", summary: "Branch" },
    ];
    const before = JSON.stringify(entries),
      rows = projectTranscript(entries);
    expect(rows.map((row) => row.kind)).toEqual([
      "text",
      "image",
      "thinking",
      "text",
      "toolCall",
      "toolResult",
      "custom",
      "custom",
      "compaction",
      "branchSummary",
    ]);
    expect(rows[0]!.text).toBe("Привет 🌍");
    expect(rows[5]!.resultFor).toBe(rows[4]!.id);
    expect(rows[5]!.isError).toBe(true);
    expect(rows[8]!.tokensBefore).toBe(12000);
    rows[4]!.arguments!.path = "changed";
    expect(JSON.stringify(entries)).toBe(before);
    expect(JSON.stringify(rows)).not.toContain("private-image-data");
    expect(
      projectTranscript([...entries, { type: "custom", id: "later" }]).map(
        (row) => row.id,
      ),
    ).toEqual(rows.map((row) => row.id));
  });
  test("redacted reasoning and orphan tool results do not manufacture linkage", () => {
    const rows = projectTranscript([
      {
        type: "message",
        id: "a",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "secret", redacted: true }],
          errorMessage: "Provider failed",
        },
      },
      {
        type: "message",
        id: "r",
        message: {
          role: "toolResult",
          toolCallId: "missing",
          content: "orphan",
        },
      },
    ]);
    expect(rows[0]!.text).toBe("[redacted thinking]");
    expect(rows[1]!.kind).toBe("error");
    expect(rows[2]!.resultFor).toBeUndefined();
  });
  test("custom renderers receive detached message details and registered entry data only", () => {
    const entries = [
      {
        type: "custom_message",
        id: "notice",
        timestamp: "2026-01-01T00:00:00Z",
        customType: "notice",
        content: "Visible notice",
        display: true,
        details: { status: "ready" },
      },
      {
        type: "custom",
        id: "widget",
        customType: "widget",
        data: { progress: 2 },
      },
      {
        type: "custom",
        id: "private",
        customType: "private-state",
        data: { secret: "internal state" },
      },
      {
        type: "custom_message",
        id: "hidden",
        customType: "widget",
        display: false,
        content: "hidden even with renderer",
      },
    ];
    const before = JSON.stringify(entries);
    expect(projectTranscript(entries).map((row) => row.entryId)).toEqual([
      "notice",
    ]);
    const rows = projectTranscript(entries, {
      hasEntryRenderer: (customType) => customType === "widget",
    });
    expect(rows.map((row) => row.entryId)).toEqual(["notice", "widget"]);
    expect(rows[0]!.customMessage).toMatchObject({
      role: "custom",
      customType: "notice",
      content: "Visible notice",
      details: { status: "ready" },
      timestamp: Date.parse("2026-01-01T00:00:00Z"),
    });
    expect(rows[1]!.customEntry).toMatchObject({
      type: "custom",
      customType: "widget",
      data: { progress: 2 },
    });
    (rows[0]!.customMessage!.details as { status: string }).status = "changed";
    (rows[0]!.details as { status: string }).status = "also changed";
    (rows[1]!.customEntry!.data as { progress: number }).progress = 3;
    expect(JSON.stringify(entries)).toBe(before);
    expect(JSON.stringify(rows)).not.toContain("internal state");
  });
  test("summary messages preserve metadata, extension roles stay visible and unsupported blocks are labeled safely", () => {
    const rows = projectTranscript([
      {
        type: "message",
        id: "summary",
        message: {
          role: "compactionSummary",
          summary: "Kept context",
          tokensBefore: 9000,
        },
      },
      {
        type: "message",
        id: "branch",
        message: { role: "branchSummary", summary: "Other branch" },
      },
      {
        type: "message",
        id: "extension",
        message: {
          role: "notification",
          content: [{ type: "text", text: "Done" }],
        },
      },
      {
        type: "message",
        id: "future",
        message: {
          role: "assistant",
          content: [{ type: "audio", data: "private audio data" }],
        },
      },
      {
        type: "message",
        id: "system",
        message: { role: "system", content: "private system instructions" },
      },
      {
        type: "context_edit",
        id: "edit",
        replacement: { content: "private replacement" },
      },
      {
        type: "message",
        id: "hidden",
        message: {
          role: "notification",
          display: false,
          content: "hidden notification",
        },
      },
    ]);
    expect(rows.map((row) => row.kind)).toEqual([
      "compaction",
      "branchSummary",
      "custom",
      "custom",
    ]);
    expect(rows[0]!.tokensBefore).toBe(9000);
    expect(rows[2]).toMatchObject({
      role: "notification",
      customType: "notification",
      text: "Done",
    });
    expect(rows[3]!.text).toBe("[unsupported block: audio]");
    expect(JSON.stringify(rows)).not.toContain("private");
    expect(JSON.stringify(rows)).not.toContain("hidden notification");
  });
});

describe("authoritative usage discovery", () => {
  test("relative and absolute parentSession ancestry uses shared ledger once", () => {
    const directory = temp(),
      root = join(directory, "root.jsonl"),
      middle = join(directory, "middle.jsonl"),
      leaf = join(directory, "leaf.jsonl");
    session(root);
    session(middle, "root.jsonl");
    session(leaf, middle);
    ledger(root);
    const result = loadUsage(leaf, [assistant]);
    expect(result.source).toBe("ledger");
    expect(result.rootSession).toBe(root);
    expect(result.totals.input).toBe(7);
    expect(result.totals.cost).toBe(0.1);
    expect(result.diagnostics).toEqual([]);
  });
  test("missing ledger gives honest main-only native fallback", () => {
    const root = join(temp(), "root.jsonl");
    session(root);
    const result = loadUsage(root, [assistant]);
    expect(result.source).toBe("native");
    expect(result.coverage).toBe("main-only");
    expect(result.totals.input).toBe(5);
    expect(result.diagnostics).toEqual([]);
  });
  test("cycles, missing parents and depth limit are bounded explicit diagnostics", () => {
    const directory = temp(),
      root = join(directory, "root.jsonl"),
      child = join(directory, "child.jsonl");
    session(root, child);
    session(child, root);
    expect(loadUsage(root, []).diagnostics[0]!.code).toBe("ancestry");
    session(root, "missing.jsonl");
    expect(loadUsage(root, []).warning).toContain(
      "Cannot read Pi session header",
    );
    for (let i = 0; i < 65; i++)
      session(
        join(directory, `${i}.jsonl`),
        i < 64 ? `${i + 1}.jsonl` : undefined,
      );
    expect(loadUsage(join(directory, "0.jsonl"), []).warning).toContain(
      "depth limit",
    );
  });
  test("wrong-root, invalid JSON, invalid counters and stale timestamps fall back explicitly", () => {
    const root = join(temp(), "root.jsonl");
    session(root);
    ledger(root, { rootSession: "wrong" });
    expect(loadUsage(root, [assistant]).diagnostics[0]!.code).toBe("malformed");
    writeFileSync(`${root}.usage/summary.json`, "{broken");
    expect(loadUsage(root, [assistant]).source).toBe("native");
    ledger(root, { totals: total(-1) });
    expect(loadUsage(root, [assistant]).warning).toContain(
      "Invalid ledger token",
    );
    ledger(root, { updatedAt: "1970-01-01T00:00:00.000Z" });
    expect(loadUsage(root, [assistant]).diagnostics[0]!.code).toBe("stale");
  });
  test("malformed groups fall back and an acknowledged incomplete tail stays visible", () => {
    const root = join(temp(), "root.jsonl");
    session(root);
    ledger(root, { byModel: [] });
    expect(loadUsage(root, [assistant]).source).toBe("native");
    ledger(root, { incompleteTail: true });
    const result = loadUsage(root, [assistant]);
    expect(result.source).toBe("ledger");
    expect(result.warning).toContain("incomplete journal tail");
  });
  test("new journal events invalidate a stale summary", () => {
    const root = join(temp(), "root.jsonl");
    session(root);
    ledger(root);
    mkdirSync(`${root}.usage/events`);
    const event = join(`${root}.usage/events`, "agent.jsonl");
    writeFileSync(event, "{}\n");
    const future = new Date(Date.now() + 5000);
    utimesSync(event, future, future);
    const result = loadUsage(root, [assistant]);
    expect(result.source).toBe("native");
    expect(result.warning).toContain("newer than its summary");
  });
});

test("not-yet-written new sessions are quiet while missing parents and malformed headers remain diagnostic", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-new-usage-"));
  directories.push(directory);
  const path = join(directory, "not-yet-written.jsonl");
  expect(
    loadUsage(path, [], { allowMissingSession: true }).diagnostics,
  ).toHaveLength(0);
  expect(loadUsage(path, []).diagnostics).toHaveLength(1);
  writeFileSync(path, "invalid json\n");
  expect(
    loadUsage(path, [], { allowMissingSession: true }).diagnostics,
  ).toHaveLength(1);
  writeFileSync(
    path,
    JSON.stringify({ type: "session", parentSession: "missing-parent.jsonl" }) +
      "\n",
  );
  expect(
    loadUsage(path, [], { allowMissingSession: true }).diagnostics,
  ).toHaveLength(1);
});
