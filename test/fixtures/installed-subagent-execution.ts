import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const directory = process.argv[2]!,
  mode = process.argv[3] ?? "foreground";
const networkAttempts: string[] = [];
const denyNetwork = (..._args: unknown[]): never => {
  networkAttempts.push("network attempt");
  throw new Error("Installed subagent execution fixture prohibits networking");
};
globalThis.fetch = Object.assign(denyNetwork, { preconnect: denyNetwork });
const socketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args: unknown[]) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const path =
    typeof first === "string"
      ? first
      : first && typeof first === "object" && "path" in first
        ? first.path
        : undefined;
  if (typeof path === "string" && path.startsWith(directory))
    return socketConnect.apply(this, args as Parameters<typeof socketConnect>);
  return denyNetwork();
};
http.request = denyNetwork;
http.get = denyNetwork;
https.request = denyNetwork;
https.get = denyNetwork;
syncBuiltinESMExports();
const { PiHost, replacedPresentation } =
  await import("../../src/host/controller.ts");
const { Application } = await import("../../src/ui/application.ts");
const { createTestRenderer } = await import("@opentui/core/testing");
const agent = process.env.PI_CODING_AGENT_DIR!;
assert.equal(existsSync(join(agent, "auth.json")), false);
const host = await PiHost.create({ cwd: process.cwd(), agentDir: agent });
const setup = await createTestRenderer({ width: 120, height: 36 });
const app = new Application(setup.renderer, host, () => {});
let report: Record<string, unknown> = {},
  runId: string | undefined,
  runnerPid: number | undefined;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};
const tool = host.session.extensionRunner
  .getAllRegisteredTools()
  .find((tool) => tool.definition.name === "subagent")!.definition;
const nativeAction = (params: Record<string, unknown>) =>
  tool.execute(
    "offline-status",
    params,
    undefined,
    undefined,
    host.session.extensionRunner.createContext() as import("@earendil-works/pi-coding-agent").ExtensionToolContext,
  );
let resultUsage:
  | { input: number; output: number; cacheRead: number; cost: number }
  | undefined;
let jobState = "",
  editorUsable = false,
  finalStatus = "";
try {
  assert.deepEqual(host.session.resourceLoader.getExtensions().errors, []);
  assert(host.session.getAllTools().some((tool) => tool.name === "subagent"));
  await host.selectModel("offline-subagent-fixture", "parent");
  await host.send(
    "Run the installed offline delegate fixture, then report completion.",
  );
  const result = host.session.messages.find(
    (message) =>
      message.role === "toolResult" && message.toolName === "subagent",
  );
  assert(
    result && result.role === "toolResult",
    "Actual SDK tool pipeline did not return subagent result",
  );
  assert.equal(result.isError, false, JSON.stringify(result));
  const details = result.details as {
    results?: {
      exitCode: number;
      usage: { input: number; output: number; cacheRead: number; cost: number };
    }[];
    asyncId?: string;
    asyncDir?: string;
  };
  if (mode === "background") {
    runId = details.asyncId;
    assert(
      runId && details.asyncDir,
      "Native async launch did not return job identity",
    );
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const state = await nativeAction({ action: "status", id: runId });
      finalStatus = state.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      assert(!state.isError, finalStatus);
      jobState = /^State: ([^\n]+)/m.exec(finalStatus)?.[1] ?? "";
      const statusPath = join(details.asyncDir, "status.json");
      if (existsSync(statusPath)) {
        const disk = JSON.parse(readFileSync(statusPath, "utf8"));
        if (typeof disk.pid === "number") {
          runnerPid = disk.pid;
          writeFileSync(
            join(directory, "owned-run.json"),
            JSON.stringify({
              pid: runnerPid,
              asyncDir: details.asyncDir,
              runId,
            }),
          );
        }
      }
      const events = existsSync(join(directory, "provider-events.jsonl"))
        ? readFileSync(join(directory, "provider-events.jsonl"), "utf8")
        : "";
      if (
        events
          .split("\n")
          .some(
            (line) =>
              line &&
              JSON.parse(line).type === "request" &&
              JSON.parse(line).model === "child",
          )
      )
        break;
      if (["failed", "stopped", "rejected", "partial"].includes(jobState))
        throw new Error(finalStatus);
      await Bun.sleep(30);
    }
    assert(
      runnerPid && alive(runnerPid),
      `Native runner was not live: ${finalStatus}`,
    );
    assert(!["complete", "failed", "stopped"].includes(jobState), finalStatus);
    await setup.mockInput.typeText("Draft while detached child runs");
    await Bun.sleep(25);
    await setup.renderOnce();
    assert.equal(
      host.bridge.getEditorText(),
      "Draft while detached child runs",
    );
    editorUsable = setup
      .captureCharFrame()
      .includes("Draft while detached child runs");
    assert(editorUsable);
    writeFileSync(join(directory, "release-child"), "continue");
    while (Date.now() < deadline) {
      const state = await nativeAction({ action: "status", id: runId });
      finalStatus = state.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      jobState = /^State: ([^\n]+)/m.exec(finalStatus)?.[1] ?? "";
      if (
        (jobState === "complete" &&
          finalStatus.includes("Process terminal: observed")) ||
        ["failed", "stopped", "rejected", "partial", "paused"].includes(
          jobState,
        )
      )
        break;
      await Bun.sleep(30);
    }
    assert.equal(jobState, "complete", finalStatus);
    assert(finalStatus.includes("Process terminal: observed"), finalStatus);
    const disk = JSON.parse(
      readFileSync(join(details.asyncDir, "status.json"), "utf8"),
    );
    const step = disk.steps?.[0];
    assert(step, "Native status did not retain child usage");
    assert.equal(step.tokens?.input, 13, JSON.stringify(disk));
    assert.equal(step.tokens?.output, 7, JSON.stringify(disk));
    resultUsage = {
      input: step.tokens.input,
      output: step.tokens.output,
      cacheRead: 0,
      cost: step.totalCost.costUsd,
    };
    const childSession = step.sessionFile ?? disk.sessionFile;
    assert(
      typeof childSession === "string" && childSession.startsWith(directory),
      "Native child session is not owned by this fixture",
    );
    const assistant = readFileSync(childSession, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find(
        (entry) =>
          entry.type === "message" && entry.message.role === "assistant",
      );
    assert(assistant?.message.usage, "Persisted child did not report usage");
    resultUsage.cacheRead = assistant.message.usage.cacheRead;
    const transcript = await nativeAction({
      action: "status",
      id: runId,
      options: { view: "transcript", lines: 80 },
    });
    assert(
      JSON.stringify(transcript.content).includes("OFFLINE_CHILD_RESULT"),
      JSON.stringify(transcript),
    );
    await host.send("Inspect completed background run through native status.");
    assert.equal(
      host.bridge.getEditorText(),
      "Draft while detached child runs",
    );
    while (Date.now() < deadline && runnerPid && alive(runnerPid))
      await Bun.sleep(30);
    assert(
      runnerPid && !alive(runnerPid),
      "Detached runner remained alive after native terminal completion",
    );
  } else {
    assert.equal(details.results?.[0]?.exitCode, 0, JSON.stringify(details));
    resultUsage = details.results[0].usage;
  }
  assert.equal(resultUsage?.input, 13);
  assert.equal(resultUsage?.output, 7);
  assert.equal(resultUsage?.cacheRead, 3);
  assert.equal(resultUsage?.cost, 0.01);
  await Bun.sleep(25);
  if (!host.bridge.getToolsExpanded())
    setup.mockInput.pressKey("o", { ctrl: true });
  for (let attempt = 0; attempt < 100; attempt++) {
    await setup.renderOnce();
    if (setup.captureCharFrame().includes("OFFLINE_CHILD_RESULT")) break;
    await Bun.sleep(10);
  }
  const frame = setup.captureCharFrame();
  assert(
    frame.includes("OFFLINE_CHILD_RESULT"),
    `Expanded native plugin result is missing from actual frame:\n${frame}`,
  );
  assert(
    host.transcript.some(
      (row) =>
        row.kind === "toolResult" && row.text.includes("OFFLINE_CHILD_RESULT"),
    ),
  );
  report = {
    childExit: 0,
    childUsage: resultUsage,
    ...(mode === "background"
      ? {
          backgroundState: jobState,
          editorUsableWhileRunning: editorUsable,
          detachedPid: runnerPid,
          runnerStopped: runnerPid !== undefined && !alive(runnerPid),
          parentPid: process.pid,
          nativeStatus: finalStatus,
        }
      : {}),
    visibleNativeResult: true,
    networkAttempts,
    presentationOwners: host.session.resourceLoader
      .getExtensions()
      .extensions.map((extension) => extension.path)
      .filter(replacedPresentation),
    hostErrors: host.diagnostics,
  };
} finally {
  try {
    if (runId && runnerPid && alive(runnerPid)) {
      try {
        await nativeAction({ action: "stop", id: runId });
      } finally {
        const deadline = Date.now() + 1500;
        while (alive(runnerPid) && Date.now() < deadline) await Bun.sleep(30);
        if (alive(runnerPid)) process.kill(runnerPid, "SIGKILL");
      }
    }
  } finally {
    app.dispose();
    try {
      await host.close();
    } finally {
      await setup.dispose();
    }
  }
}
const events = readFileSync(join(directory, "provider-events.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const requests = events.filter((event) => event.type === "request");
if (mode === "foreground")
  assert.deepEqual(
    requests.map((event) => event.model),
    ["parent", "child", "parent"],
  );
else
  assert.equal(requests.filter((event) => event.model === "child").length, 1);
const starts = events.filter((event) => event.type === "start"),
  parent = starts.find((event) => event.mode === "tui"),
  child = starts.find((event) => event.mode === "print");
assert(
  parent && child,
  "Actual foreground child session did not bind its print-mode extension context",
);
assert.notEqual(child.sessionId, parent.sessionId);
assert.notEqual(child.sessionFile, parent.sessionFile);
assert.equal(child.hasUI, false, `Child context: ${JSON.stringify(child)}`);
assert(
  events.some(
    (event) => event.type === "stop" && event.sessionId === child.sessionId,
  ),
  "Child did not release its runtime",
);
assert.deepEqual(networkAttempts, []);
assert.equal(
  events.filter((event) => event.type === "network").length,
  0,
  "Detached worker attempted networking",
);
const auth = existsSync(join(agent, "auth.json"))
  ? JSON.parse(readFileSync(join(agent, "auth.json"), "utf8"))
  : {};
assert.deepEqual(auth, {}, "Offline execution must not persist credentials");
console.log(
  `INSTALLED_SUBAGENT_RESULT ${JSON.stringify({ ...report, requests: requests.map((event) => event.model), childMode: child.mode, childNodeVersion: child.nodeVersion, childHasUI: child.hasUI, separateSession: child.sessionId !== parent.sessionId, childStopped: true, credentialStorageEmpty: true })}`,
);
