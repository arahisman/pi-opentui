import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiHost } from "../src/host/controller.ts";
import { ProjectionCache } from "../src/core/projection-cache.ts";
import { projectAdvice } from "../src/core/telemetry.ts";

const delivered = {
  notes: [{
    adviceId: "real-note",
    advisor: "Reviewer",
    note: "Check error handling",
  }],
};

test("feedback projection follows appended entries, invalid updates, and current branch", () => {
  const manager = SessionManager.inMemory();
  const cache = new ProjectionCache();
  const delivery = manager.appendCustomMessageEntry(
    "advisor", "Advice", true, delivered,
  );
  manager.appendCustomEntry("pi-omp-advisor-inbox", {
    items: [{ adviceId: "pending-note", note: "Still considering" }],
  });
  cache.sync(manager, undefined, 0);
  expect(cache.advice[0]?.feedback).toBeUndefined();
  manager.appendCustomEntry("pi-opentui-advisor-feedback", {
    noteId: "real-note",
    rating: "useful",
    timestamp: "2026-11-13T10:00:00Z",
    source: "assistant",
  });
  cache.sync(manager, undefined, 0);
  expect(cache.advice[0]?.feedback?.rating).toBe("useful");
  expect(cache.advice[1]?.status).toBe("pending");
  manager.appendCustomEntry("pi-opentui-advisor-feedback", {
    noteId: "real-note",
    rating: "invalid",
    timestamp: "2026-11-13T10:00:00Z",
    source: "assistant",
  });
  manager.appendCustomMessageEntry("advisor", "Repeated delivery", true, delivered);
  cache.sync(manager, undefined, 0);
  expect(cache.advice).toEqual(projectAdvice(manager.getBranch()));
  expect(cache.advice[0]?.feedback?.rating).toBe("useful");
  manager.branch(delivery);
  cache.sync(manager, undefined, 0);
  expect(cache.advice).toHaveLength(1);
  expect(cache.advice[0]?.feedback).toBeUndefined();
});

test("clean host exposes voluntary feedback tool and persists ratings across reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-feedback-"));
  const agentDir = join(directory, "agent");
  let host: PiHost | undefined;
  try {
    host = await PiHost.create({ cwd: directory, agentDir, clean: true });
    const tool = host.session.agent.state.tools.find(
      (tool) => tool.name === "advisor_feedback",
    );
    expect(tool).toBeDefined();
    const run = (args: Record<string, unknown>) =>
      tool!.execute("feedback-test", args);
    const validate = (args: Record<string, string>) =>
      validateToolArguments(tool!, {
        type: "toolCall",
        id: "validated-feedback",
        name: "advisor_feedback",
        arguments: args,
      });
    expect(validate({ action: "list" })).toEqual({ action: "list" });
    expect(validate({
      action: "rate", noteId: "real-note", rating: "useful",
    })).toMatchObject({ rating: "useful" });
    expect(() => validate({
      action: "rate", noteId: "real-note", rating: "accepted",
    })).toThrow("Validation failed");
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(tool!.execute(
      "cancelled-feedback", { action: "list" }, cancelled.signal,
    )).rejects.toThrow("cancelled");
    expect((await run({ action: "list" })).details).toEqual({ notes: [] });

    const manager = host.session.sessionManager;
    manager.appendMessage({
      role: "user", content: "Offline feedback fixture", timestamp: Date.now(),
    });
    const delivery = manager.appendCustomMessageEntry(
      "advisor", "Advice", true, delivered,
    );
    manager.appendCustomEntry("pi-omp-advisor-inbox", {
      items: [{ adviceId: "pending-note", note: "Pending" }],
    });
    expect((await run({ action: "list" })).details).toMatchObject({
      notes: [{ id: "real-note", status: "delivered" }],
    });
    await expect(run({
      action: "rate", noteId: "pending-note", rating: "useful",
    })).rejects.toThrow("not delivered");
    await expect(run({
      action: "rate", noteId: "unknown", rating: "useful",
    })).rejects.toThrow("Unknown advisor note");
    await expect(run({
      action: "rate", noteId: "real-note", rating: "accepted",
    })).rejects.toThrow("useful or harmful");
    await expect(run({
      action: "rate", noteId: "real-note", rating: "useful", reason: "x".repeat(501),
    })).rejects.toThrow("500");
    const result = await run({
      action: "rate",
      noteId: "real-note",
      rating: "useful",
      reason: "Confirmed the missing failure path",
    });
    expect(result.details).toMatchObject({
      noteId: "real-note", feedback: { rating: "useful", source: "assistant" },
    });
    expect((await run({ action: "list" })).details).toMatchObject({
      notes: [{ feedback: { rating: "useful" } }],
    });
    expect(host.snapshot().advice[0]?.feedback?.reason).toBe(
      "Confirmed the missing failure path",
    );
    const usefulEntry = manager.getLeafId()!;
    await run({ action: "rate", noteId: "real-note", rating: "harmful" });
    expect(host.snapshot().advice[0]?.feedback?.rating).toBe("harmful");
    const file = host.session.sessionFile!;
    await host.close();
    host = await PiHost.create({
      cwd: directory, agentDir, clean: true, sessionFile: file,
    });
    expect(host.snapshot().advice[0]?.feedback?.rating).toBe("harmful");
    host.session.sessionManager.branch(usefulEntry);
    expect(host.snapshot().advice[0]?.feedback?.rating).toBe("useful");
    host.session.sessionManager.branch(delivery);
    expect(host.snapshot().advice[0]?.feedback).toBeUndefined();
  } finally {
    await host?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
