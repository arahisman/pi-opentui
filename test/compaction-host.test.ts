import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { PiHost } from "../src/host/controller.ts";

const usage = { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 101,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

for (const outcome of ["success", "error", "cancel"] as const) {
  test(`real SDK extension abort then compact reports active state and ${outcome}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-compaction-lifecycle-"));
    const agentDir = join(directory, "agent");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      compaction: { enabled: false, keepRecentTokens: 64, reserveTokens: 32 },
    }));
    let context: ExtensionContext | undefined;
    let attempted = false;
    let release!: () => void;
    let started!: () => void;
    const active = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let host: PiHost | undefined;
    let run: Promise<void> | undefined;
    const events: string[] = [];
    const extension: ExtensionFactory = (pi) => {
      pi.on("agent_start", (_event, ctx) => { context = ctx; });
      pi.registerProvider("compaction-offline", {
        name: "Compaction offline fixture", baseUrl: "http://127.0.0.1:9",
        apiKey: "offline", api: "openai-completions",
        models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
          contextWindow: 100_000, maxTokens: 1000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple: (model, _ctx, options) => {
          const stream = createAssistantMessageEventStream();
          const message: AssistantMessage = { role: "assistant", api: model.api,
            provider: model.provider, model: model.id, timestamp: Date.now(),
            content: [], stopReason: "aborted", errorMessage: "The operation was aborted.", usage };
          options?.signal?.addEventListener("abort", () => {
            stream.push({ type: "error", reason: "aborted", error: message });
            stream.end();
          }, { once: true });
          queueMicrotask(() => context!.abort());
          return stream;
        },
      });
      pi.on("session_before_compact", async (event) => {
        started();
        await Promise.race([
          gate,
          new Promise<never>((_resolve, reject) => {
            event.signal.addEventListener("abort", () => reject(new Error("Compaction aborted")), { once: true });
          }),
        ]);
        return { compaction: {
          get summary() {
            if (outcome === "error") throw new Error("Offline summary failure");
            return "Offline compacted summary";
          },
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore } };
      });
      pi.on("agent_settled", async (_event, ctx) => {
        if (attempted) return;
        attempted = true;
        await new Promise<void>((resolve) => ctx.compact({
          onComplete: () => resolve(), onError: () => resolve(),
        }));
      });
    };
    try {
      host = await PiHost.create({ cwd: directory, agentDir, clean: true, extensionFactories: [extension] });
      await host.selectModel("compaction-offline", "fixture");
      const manager = host.session.sessionManager;
      manager.appendMessage({ role: "user", content: "Old context ".repeat(500), timestamp: 1 });
      manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "compaction-offline",
        model: "fixture", content: [{ type: "text", text: "Earlier answer" }],
        stopReason: "stop", timestamp: 2, usage });
      host.on("event", (event) => events.push(event.type));
      run = host.send("Continue the fixture");
      await active;
      expect(host.snapshot().status).toBe("compacting");
      expect(host.snapshot().compaction).toMatchObject({ automatic: false, reason: "manual" });
      expect(host.transcript.some((row) => row.kind === "error")).toBe(false);
      if (outcome === "cancel") await host.abort();
      else release();
      await run;
      expect(host.snapshot().compaction).toBeUndefined();
      expect(host.snapshot().status).toBe("idle");
      expect(host.transcript.some((row) => row.kind === "error")).toBe(outcome !== "success");
      expect(events.indexOf("message_end")).toBeLessThan(events.indexOf("compaction_start"));
      expect(events).toContain("compaction_end");
      if (outcome === "cancel")
        expect(host.bridge.notifications).toContainEqual({ message: "Compaction cancelled", type: "info" });
      if (outcome === "error")
        expect(host.bridge.notifications.some((note) => note.type === "error" && note.message.includes("Offline summary failure"))).toBe(true);
      if (outcome === "success") {
        const file = host.session.sessionFile!;
        await host.close();
        host = await PiHost.create({ cwd: directory, agentDir, clean: true, sessionFile: file });
        expect(host.transcript.some((row) => row.kind === "error")).toBe(false);
        expect(host.transcript.some((row) => row.kind === "compaction")).toBe(true);
      }
    } finally {
      release();
      await run;
      await host?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}


for (const [trigger, outcome] of [
  ["manual", "success"], ["manual", "cancel"], ["manual", "error"],
  ["threshold", "success"], ["overflow", "success"],
] as const) {
  test(`native ${trigger} compaction tracks ${outcome} without a false idle gap`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-native-compaction-"));
    const agentDir = join(directory, "agent");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      compaction: { enabled: trigger !== "manual", keepRecentTokens: 64, reserveTokens: 32 },
    }));
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = new Promise<void>((resolve) => { started = resolve; });
    let requests = 0;
    let host: PiHost | undefined;
    let run: Promise<unknown> | undefined;
    const extension: ExtensionFactory = (pi) => {
      pi.registerProvider("native-compaction-offline", {
        name: "Native compaction fixture", baseUrl: "http://127.0.0.1:9",
        apiKey: "offline", api: "openai-completions",
        models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
          contextWindow: trigger === "threshold" ? 1024 : 100_000, maxTokens: 100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple: (model) => {
          requests++;
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            const overflow = trigger === "overflow" && requests === 1;
            const message: AssistantMessage = {
              role: "assistant", api: model.api, provider: model.provider, model: model.id,
              timestamp: Date.now(), content: [{ type: "text", text: "Offline response" }],
              stopReason: overflow ? "error" : "stop",
              ...(overflow ? { errorMessage: "maximum context length is 100000 tokens" } : {}),
              usage: trigger === "threshold" ? { ...usage, input: 1000, totalTokens: 1001 } : usage,
            };
            if (overflow) stream.push({ type: "error", reason: "error", error: message });
            else stream.push({ type: "done", reason: "stop", message });
            stream.end();
          });
          return stream;
        },
      });
      pi.on("session_before_compact", async (event) => {
        started();
        await Promise.race([
          gate,
          new Promise<never>((_resolve, reject) => {
            event.signal.addEventListener("abort", () => reject(new Error("Compaction aborted")), { once: true });
          }),
        ]);
        return { compaction: {
          get summary() {
            if (outcome === "error") throw new Error("Manual offline failure");
            return "Native offline summary";
          },
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore } };
      });
    };
    try {
      host = await PiHost.create({ cwd: directory, agentDir, clean: true, extensionFactories: [extension] });
      await host.selectModel("native-compaction-offline", "fixture");
      const manager = host.session.sessionManager;
      manager.appendMessage({ role: "user", content: "Earlier context ".repeat(500), timestamp: 1 });
      manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "native-compaction-offline",
        model: "fixture", content: [{ type: "text", text: "Earlier result" }],
        stopReason: "stop", timestamp: 2, usage });
      if (trigger === "manual")
        manager.appendMessage({ role: "user", content: "Current task ".repeat(100), timestamp: 3 });
      run = trigger === "manual" ? host.compact() : host.send("Continue offline");
      const settled = Promise.allSettled([run]);
      await Promise.race([
        active,
        settled.then(([result]) => {
          throw result.status === "rejected"
            ? result.reason
            : new Error("Operation finished before compaction started");
        }),
      ]);
      expect(host.snapshot().status).toBe("compacting");
      expect(host.snapshot().compaction).toMatchObject({
        reason: trigger, automatic: trigger !== "manual",
      });
      await expect(host.compact()).rejects.toThrow("already running");
      if (outcome === "cancel") await host.abort();
      else release();
      const [result] = await settled;
      if (outcome === "error") {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(String(result.reason)).toContain("Manual offline failure");
      } else expect(result.status).toBe("fulfilled");
      expect(host.snapshot().compaction).toBeUndefined();
      expect(host.snapshot().status).toBe("idle");
      expect(host.transcript.some((row) => row.kind === "compaction")).toBe(outcome === "success");
      if (trigger === "manual") expect(requests).toBe(0);
      if (trigger === "overflow") expect(requests).toBe(2);
      run = undefined;
    } finally {
      release();
      if (run) await Promise.allSettled([run]);
      await host?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
