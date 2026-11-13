import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ProjectionCache } from "../src/core/projection-cache.ts";
import { projectTranscript } from "../src/core/session-data.ts";
import {
  projectAdvice,
  projectCompactions,
  projectUsage,
} from "../src/core/telemetry.ts";
import { PiHost } from "../src/host/controller.ts";

const assistant = (
  content: AssistantMessage["content"],
  timestamp = 1000,
): AssistantMessage => ({
  role: "assistant",
  api: "openai-completions",
  provider: "offline",
  model: "fixture",
  timestamp,
  content,
  stopReason: "stop",
  usage: {
    input: 7,
    output: 3,
    cacheRead: 2,
    cacheWrite: 0,
    totalTokens: 12,
    cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
  },
});
function largeManager(size = 50_010): SessionManager {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const entries: Parameters<typeof SessionManager.inMemory>[2] = [
    { type: "session", version: 3, id: randomUUID(), timestamp, cwd: "/tmp" },
  ];
  for (let index = 0; index < size; index++)
    entries.push({
      type: "message",
      id: `entry-${index}`,
      parentId: index ? `entry-${index - 1}` : null,
      timestamp,
      message: {
        role: "user",
        timestamp: index,
        content: [
          {
            type: "text",
            text: `Historical row ${index} with enough text to represent a real saved conversation.`,
          },
        ],
      },
    });
  return SessionManager.inMemory("/tmp", undefined, entries);
}

describe("long-session projection cache", () => {
  test("50k-entry idle/editor and streaming cycles never rewalk or reproject base history", () => {
    const manager = largeManager(),
      cache = new ProjectionCache();
    let branchReads = 0,
      entryReads = 0;
    const branch = manager.getBranch.bind(manager),
      entry = manager.getEntry.bind(manager);
    manager.getBranch = (...args) => {
      branchReads++;
      return branch(...args);
    };
    manager.getEntry = (id) => {
      entryReads++;
      return entry(id);
    };
    cache.sync(manager, undefined, 0);
    const entries = cache.entries,
      transcript = cache.transcript;
    const baseline = { ...cache.work },
      revision = cache.revision;
    const started = performance.now();
    for (let cycle = 0; cycle < 1000; cycle++) {
      cache.sync(manager, undefined, 0);
      cache.usage(undefined);
      expect(cache.transcript).toBe(transcript);
    }
    const idleMs = performance.now() - started;
    expect(cache.entries).toBe(entries);
    expect(cache.work).toEqual({ ...baseline, usageLoads: 1 });
    expect(cache.revision).toBe(revision);
    expect(branchReads).toBe(1);
    expect(entryReads).toBe(0);
    for (let token = 1; token <= 400; token++) {
      cache.sync(
        manager,
        {
          type: "message",
          id: "live:123",
          message: assistant([{ type: "text", text: `stream-${token}` }], 123),
        },
        token,
      );
      expect(cache.transcript.at(-1)?.text).toBe(`stream-${token}`);
      expect(cache.entries.length).toBe(50_011);
      expect(cache.transcript.length).toBe(50_011);
      cache.usage(undefined);
    }
    expect(branchReads).toBe(1);
    expect(entryReads).toBe(0);
    expect(cache.work.transcriptEntries).toBe(50_010);
    expect(cache.work.adviceEntries).toBe(50_010);
    expect(cache.work.nativeUsageEntries).toBe(50_010);
    expect(cache.work.liveEntries).toBe(400);
    cache.sync(manager, undefined, 401);
    expect(cache.entries.length).toBe(50_010);
    expect(cache.transcript.length).toBe(50_010);
    console.info(
      `Projection performance: 50,010 source entries, 1,000 idle cycles ${idleMs.toFixed(1)}ms; base branch reads ${branchReads}; 400 streaming tails, no base rescans`,
    );
    expect(idleMs).toBeLessThan(2000);
  });

  test("append deltas preserve tool linkage, native usage, advisor inbox, custom visibility and compactions", () => {
    const manager = largeManager(),
      cache = new ProjectionCache();
    cache.sync(manager, undefined, 0);
    const baseReads = cache.work.branchReads,
      baseVisits = cache.work.transcriptEntries;
    const callId = manager.appendMessage(
      assistant([
        {
          type: "toolCall",
          id: "tool-1",
          name: "read",
          arguments: { path: "x.ts" },
        },
      ]),
    );
    cache.sync(manager, undefined, 0);
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      details: {},
      isError: false,
      timestamp: 1100,
    });
    cache.sync(manager, undefined, 0);
    expect(cache.transcript.at(-1)?.resultFor).toBe(`${callId}:0`);
    const resultIndex = cache.toolResults;
    expect(resultIndex.get(`${callId}:0`)?.text).toBe("result");
    const beforeLive = { ...cache.work };
    for (let token = 1; token <= 100; token++) {
      cache.sync(
        manager,
        {
          type: "message",
          id: "live:result",
          message: {
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "read",
            content: [{ type: "text", text: `partial-${token}` }],
          },
        },
        token,
      );
      expect(cache.toolResults).toBe(resultIndex);
      expect(cache.toolResults.get(`${callId}:0`)?.text).toBe(
        `partial-${token}`,
      );
    }
    expect(cache.work.transcriptEntries).toBe(beforeLive.transcriptEntries);
    cache.sync(manager, undefined, 101);
    expect(cache.toolResults.get(`${callId}:0`)?.text).toBe("result");
    manager.appendCustomEntry("pi-omp-advisor-inbox", {
      items: [{ adviceId: "a1", advisor: "Reviewer", note: "Pending thought" }],
    });
    cache.sync(manager, undefined, 0);
    expect(cache.advice.at(-1)?.status).toBe("pending");
    manager.appendCustomMessageEntry(
      "advisor",
      [{ type: "text", text: "Visible advice" }],
      true,
      {
        notes: [
          { adviceId: "a1", advisor: "Reviewer", note: "Delivered thought" },
        ],
      },
    );
    manager.appendCustomMessageEntry("hidden", "Private internal state", false);
    manager.appendCustomEntry("pi-omp-advisor-inbox", { items: [] });
    cache.sync(manager, undefined, 0);
    expect(cache.advice).toHaveLength(1);
    expect(cache.advice[0]?.status).toBe("delivered");
    expect(
      cache.transcript.some((row) => row.text === "Private internal state"),
    ).toBe(false);
    manager.appendCompaction("compacted", callId, 12345);
    cache.sync(manager, undefined, 0);
    const expected = manager.getBranch();
    expect(cache.transcript).toEqual(projectTranscript(expected));
    expect(cache.advice).toEqual(projectAdvice(expected));
    expect(cache.compactions).toEqual(projectCompactions(expected));
    expect([...cache.toolResults]).toEqual(
      projectTranscript(expected)
        .filter((row) => row.resultFor)
        .map((row) => [row.resultFor!, row]),
    );
    expect(cache.usage(undefined).totals).toEqual(
      projectUsage(expected).totals,
    );
    expect(cache.work.branchReads).toBe(baseReads);
    expect(cache.work.transcriptEntries - baseVisits).toBe(7);
    const beforeBranch = cache.work.branchReads;
    manager.branch("entry-4");
    cache.sync(manager, undefined, 0);
    expect(cache.work.branchReads).toBe(beforeBranch + 1);
    expect(cache.entries).toHaveLength(5);
    expect(cache.transcript).toHaveLength(5);
    expect(cache.advice).toEqual([]);
    expect(cache.toolResults.size).toBe(0);
    expect(cache.compactions).toEqual([]);
    expect(cache.usage(undefined).totals.responses).toBe(0);
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "New branch" }],
      timestamp: 1200,
    });
    cache.sync(manager, undefined, 0);
    expect(cache.work.branchReads).toBe(beforeBranch + 1);
    expect(cache.transcript.at(-1)?.text).toBe("New branch");
    cache.invalidate();
    cache.sync(manager, undefined, 0);
    expect(cache.work.branchReads).toBe(beforeBranch + 2);
  });

  test("external child journal and summary updates refresh independently of the parent leaf", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-projection-journal-"));
    try {
      const root = join(directory, "root.jsonl"),
        child = join(directory, "child.jsonl");
      const header = (file: string, parentSession?: string) =>
        writeFileSync(
          file,
          JSON.stringify({
            type: "session",
            version: 3,
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            cwd: directory,
            ...(parentSession ? { parentSession } : {}),
          }) + "\n",
        );
      header(root);
      header(child, root);
      const events = `${root}.usage/events`,
        summary = `${root}.usage/summary.json`;
      mkdirSync(events, { recursive: true });
      const total = (input: number) => ({
        responses: 1,
        unreportedResponses: 0,
        unpricedResponses: 0,
        tokens: { input, output: 2, cacheRead: 0, cacheWrite: 0 },
        estimatedCost: 0.1,
      });
      const writeSummary = (input: number) =>
        writeFileSync(
          summary,
          JSON.stringify({
            version: 1,
            rootSession: root,
            updatedAt: new Date().toISOString(),
            totals: total(input),
            byModel: { "p/m": total(input) },
            byAgent: { child: total(input) },
          }),
        );
      writeSummary(5);
      const cache = new ProjectionCache(),
        manager = largeManager();
      cache.sync(manager, undefined, 0);
      expect(cache.usage(child).totals.input).toBe(5);
      for (let index = 0; index < 100; index++)
        expect(cache.usage(child).totals.input).toBe(5);
      expect(cache.work.usageLoads).toBe(1);
      const eventFile = join(events, "child.jsonl"),
        summaryTime = statSync(summary).mtimeMs;
      const event = (id: string, input: number) => ({
        version: 1,
        eventId: id,
        sessionId: "child",
        rootSession: root,
        sessionFile: child,
        role: "subagent",
        provider: "p",
        model: "m",
        timestamp: new Date().toISOString(),
        reported: true,
        tokens: { input, output: 2, cacheRead: 0, cacheWrite: 0 },
        estimatedCost: 0.1,
      });
      writeFileSync(eventFile, JSON.stringify(event("one", 17)) + "\n");
      utimesSync(
        eventFile,
        new Date(summaryTime + 1000),
        new Date(summaryTime + 1000),
      );
      expect(cache.usage(child).totals.input).toBe(17);
      expect(cache.work.usageLoads).toBe(2);
      appendFileSync(eventFile, JSON.stringify(event("two", 20)) + "\n");
      utimesSync(
        eventFile,
        new Date(summaryTime + 2000),
        new Date(summaryTime + 2000),
      );
      expect(cache.usage(child).totals.input).toBe(37);
      expect(cache.work.usageLoads).toBe(3);
      writeSummary(99);
      utimesSync(
        summary,
        new Date(summaryTime + 3000),
        new Date(summaryTime + 3000),
      );
      expect(cache.usage(child).totals.input).toBe(99);
      expect(cache.work.usageLoads).toBe(4);
      expect(cache.work.branchReads).toBe(1);
      expect(cache.work.transcriptEntries).toBe(50_010);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

test("real PiHost snapshot/transcript/editor cycles cache SDK context and session history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-host-performance-"));
  let host: PiHost | undefined;
  try {
    const manager = largeManager(),
      file = join(directory, "long.jsonl");
    writeFileSync(
      file,
      [manager.getHeader(), ...manager.getEntries()]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    host = await PiHost.create({
      cwd: directory,
      agentDir: join(directory, "agent"),
      sessionFile: file,
      clean: true,
      extensionFactories: [
        (pi) => {
          pi.registerProvider("offline", {
            name: "Offline performance fixture",
            baseUrl: "http://127.0.0.1:9",
            apiKey: "offline-fixture",
            api: "openai-completions",
            models: [
              {
                id: "fixture",
                name: "Fixture",
                reasoning: false,
                input: ["text"],
                contextWindow: 32000,
                maxTokens: 2048,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          });
        },
      ],
    });
    await host.selectModel("offline", "fixture");
    const source = host.session.sessionManager;
    let branches = 0,
      contexts = 0,
      entriesCopies = 0;
    const getBranch = source.getBranch.bind(source),
      getEntries = source.getEntries.bind(source),
      getContext = host.session.getContextUsage.bind(host.session);
    source.getBranch = (...args) => {
      branches++;
      return getBranch(...args);
    };
    source.getEntries = () => {
      entriesCopies++;
      return getEntries();
    };
    host.session.getContextUsage = () => {
      contexts++;
      return getContext();
    };
    expect(host.snapshot().contextWindow).toBe(32000);
    expect(entriesCopies).toBe(1);
    const rows = host.transcript,
      revision = host.projectionRevision;
    const warmedBranches = branches,
      started = performance.now();
    for (let cycle = 0; cycle < 200; cycle++) {
      host.bridge.setEditorText(`Draft ${cycle}`);
      host.snapshot();
      expect(host.transcript).toBe(rows);
      host.bridge.renderEditor(100);
    }
    const elapsed = performance.now() - started;
    expect(branches).toBe(warmedBranches);
    expect(contexts).toBe(1);
    expect(entriesCopies).toBe(1);
    expect(warmedBranches).toBe(2);
    expect(host.projectionRevision).toBe(revision);
    source.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Appended directly" }],
      timestamp: 2000,
    });
    expect(host.transcript.at(-1)?.text).toBe("Appended directly");
    expect(host.projectionRevision).toBeGreaterThan(revision);
    source.branch("entry-10");
    expect(host.transcript).toHaveLength(11);
    host.invalidateProjection();
    host.snapshot();
    expect(contexts).toBe(2);
    console.info(
      `PiHost performance: 50,010 saved entries, 200 snapshot/transcript/native-editor cycles ${elapsed.toFixed(1)}ms; SDK context calls while idle 1`,
    );
    expect(elapsed).toBeLessThan(2000);
  } finally {
    await host?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
