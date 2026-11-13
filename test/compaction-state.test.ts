import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CompactionState } from "../src/core/compaction-state.ts";
import { projectTranscript } from "../src/core/session-data.ts";

const aborted = () => ({
  role: "assistant" as const,
  api: "openai-completions" as const,
  provider: "offline",
  model: "fixture",
  content: [],
  stopReason: "aborted" as const,
  errorMessage: "The operation was aborted.",
  timestamp: 1,
  usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

for (const outcome of ["success", "error", "cancel"] as const) {
  test(`compaction interruption is provisional until ${outcome}`, () => {
    const manager = SessionManager.inMemory();
    const state = new CompactionState();
    const message = aborted();
    state.handle({ type: "message_end", message }, manager);
    const assistantEntryId = manager.appendMessage(message);
    expect(projectTranscript(manager.getBranch())).toHaveLength(1);
    state.handle({ type: "compaction_start", reason: "manual" }, manager);
    expect(state.active).toMatchObject({ automatic: false, reason: "manual" });
    expect(projectTranscript(manager.getBranch(), {
      isCompactionInterruption: (id) => state.interrupted.has(id),
    })).toEqual([]);
    const compactionEntryId = outcome === "success"
      ? manager.appendCompaction("Summary", assistantEntryId, 100)
      : undefined;
    const result = outcome === "success"
      ? { summary: "Summary", firstKeptEntryId: assistantEntryId, tokensBefore: 100 }
      : undefined;
    state.handle({ type: "compaction_end", reason: "manual", result,
      aborted: outcome === "cancel", willRetry: false,
      ...(outcome === "error" ? { errorMessage: "Summary failed" } : {}),
    }, manager);
    expect(state.active).toBeUndefined();
    expect(state.interrupted.size).toBe(0);
    const projected = projectTranscript(manager.getBranch());
    expect(projected.some((row) => row.kind === "error")).toBe(outcome !== "success");
    if (compactionEntryId) {
      expect(projected.some((row) => row.kind === "compaction")).toBe(true);
      manager.branch(assistantEntryId);
      expect(projectTranscript(manager.getBranch()).some((row) => row.kind === "error")).toBe(true);
    }
  });
}

test("explicit user abort and old aborted turns are never attributed to later compaction", () => {
  for (const explicitUserAbort of [true, false]) {
    const state = new CompactionState();
    const manager = SessionManager.inMemory();
    const message = aborted();
    if (explicitUserAbort) state.userAbort();
    state.handle({ type: "message_end", message }, manager);
    manager.appendMessage(message);
    state.handle({ type: "agent_settled", aborted: true }, manager);
    state.handle({ type: "compaction_start", reason: "threshold" }, manager);
    expect(state.interrupted.size).toBe(0);
    expect(state.active?.automatic).toBe(true);
    state.clear();
    expect(state.active).toBeUndefined();
  }
});
