import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import type {
  ExtensionFactory,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

const networkAttempts: string[] = [];
const denyNetwork = (..._args: unknown[]): never => {
  networkAttempts.push("network access attempted");
  throw new Error("Installed-module smoke prohibits network access");
};
globalThis.fetch = Object.assign(denyNetwork, { preconnect: denyNetwork });
net.Socket.prototype.connect = denyNetwork;
http.request = denyNetwork;
http.get = denyNetwork;
https.request = denyNetwork;
https.get = denyNetwork;
syncBuiltinESMExports();
const isolatedAgent = process.env.PI_CODING_AGENT_DIR!;
assert.equal(resolve(isolatedAgent), resolve(join(homedir(), ".pi", "agent")));
assert.equal(existsSync(join(isolatedAgent, "auth.json")), false);
const manifest: {
  source: string;
  path: string;
  name: string;
  version: string;
}[] = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const { PiHost, replacedPresentation, hostEditorFactory } =
  await import("../../src/host/controller.ts");
const { UserCancelledInteractionError } =
  await import("../../src/host/extension-ui.ts");
let startups = 0,
  shutdowns = 0,
  inputCalls = 0,
  widgetDisposals = 0,
  submissions = 0;
const sentinel: ExtensionFactory = (pi) => {
  pi.on("session_start", (_event, ctx) => {
    startups++;
    assert.equal(ctx.mode, "tui");
    for (const name of [
      "onTerminalInput",
      "setWidget",
      "setStatus",
      "getEditorComponent",
      "getToolsExpanded",
      "custom",
      "notify",
    ] as const)
      assert.equal(typeof ctx.ui[name], "function", name);
    assert.equal(ctx.ui.theme.name, "opencode");
    ctx.ui.onTerminalInput(() => {
      inputCalls++;
    });
    ctx.ui.setWidget("installed-smoke-sentinel", () => ({
      render: () => ["sentinel"],
      invalidate() {},
      dispose: () => {
        widgetDisposals++;
      },
    }));
    ctx.ui.setStatus("installed-smoke-sentinel", "ready");
  });
  pi.on("session_shutdown", () => {
    shutdowns++;
  });
};
const host = await PiHost.create({
  cwd: process.cwd(),
  agentDir: isolatedAgent,
  extensionFactories: [sentinel],
  deferBind: true,
});
host.on("submit", () => {
  submissions++;
});
const deniedDialogs: string[] = [];
host.on("change", () => {
  const dialog = host.bridge.activeDialog;
  if (dialog && dialog.kind !== "custom") {
    deniedDialogs.push(`${dialog.kind}: ${dialog.title}`);
    host.bridge.cancelDialog();
  }
});
let questionnaireSelected: string | undefined,
  questionnaireCustom: string | undefined,
  questionnaireCancelled = false,
  questionnaireExplicitCancel = false,
  questionnaireNestedCancelError: string | undefined;
let extensionErrors: unknown[] = [],
  hostErrors: string[] = [],
  loadedPaths: string[] = [],
  commands: string[] = [],
  tools: string[] = [],
  skillNames: string[] = [];
try {
  await host.attach();
  extensionErrors = host.session.resourceLoader.getExtensions().errors;
  hostErrors = [...host.diagnostics];
  assert.deepEqual(extensionErrors, []);
  assert.deepEqual(
    hostErrors.filter((error) => !error.startsWith("Presentation replaced:")),
    [],
  );
  assert.deepEqual(deniedDialogs, []);
  loadedPaths = host.session.resourceLoader
    .getExtensions()
    .extensions.map((extension) => extension.path);
  tools = host.session.getAllTools().map((tool) => tool.name);
  commands = host.commands().map((command) => command.name);
  skillNames = host.session.resourceLoader
    .getSkills()
    .skills.map((skill) => skill.name);
  for (const required of [
    "questionnaire",
    "subagent",
    "history_search",
    "history_get",
    "session_search",
    "session_list",
    "session_read",
    "lsp_diagnostics",
    "lsp_hover",
  ])
    assert(
      tools.includes(required),
      `Missing tool ${required}: ${tools.join(", ")}`,
    );
  assert(
    tools.some((name) => /web.*search|search.*web/.test(name)),
    `Missing web search tool: ${tools.join(", ")}`,
  );
  for (const required of ["advisor", "lsp", "session-sync"])
    assert(commands.includes(required), `Missing command ${required}`);
  assert(
    skillNames.includes("using-superpowers"),
    "Superpowers skills were not discovered",
  );
  const firstAdvisorFactory = host.bridge.getEditorComponent();
  assert(
    firstAdvisorFactory && firstAdvisorFactory !== hostEditorFactory,
    "Installed advisor must wrap the host baseline editor factory",
  );
  assert.equal(loadedPaths.some(replacedPresentation), false);
  const questionnaire = host.session.extensionRunner
    .getAllRegisteredTools()
    .find((tool) => tool.definition.name === "questionnaire")!.definition;
  const params = {
    questions: [
      {
        id: "smoke",
        label: "Smoke",
        prompt: "Smoke preference",
        options: [{ value: "safe", label: "Safe local answer" }],
        allowOther: false,
      },
    ],
  };
  const ask = () =>
    questionnaire.execute(
      "installed-smoke-questionnaire",
      params,
      undefined,
      undefined,
      host.session.extensionRunner.createContext() as ExtensionToolContext,
    );
  const ready = async () => {
    for (
      let attempt = 0;
      attempt < 100 &&
      !(
        host.bridge.activeDialog?.kind === "custom" &&
        host.bridge.activeDialog.component
      );
      attempt++
    )
      await Bun.sleep(5);
    assert.equal(host.bridge.activeDialog?.kind, "custom");
    assert(
      host.bridge.renderCustom(70).join("\n").includes("Smoke preference"),
    );
  };
  const selected = ask();
  await ready();
  host.bridge.handleCustomInput("\r");
  const selectedResult = await selected;
  questionnaireSelected = (
    selectedResult.details as { answers: { value: string }[] }
  ).answers[0]?.value;
  assert.equal(questionnaireSelected, "safe");
  const customParams = {
    questions: [{ ...params.questions[0]!, allowOther: true }],
  };
  const custom = questionnaire.execute(
    "installed-smoke-custom",
    customParams,
    undefined,
    undefined,
    host.session.extensionRunner.createContext() as ExtensionToolContext,
  );
  await ready();
  host.bridge.handleCustomInput("\x1b[B");
  host.bridge.handleCustomInput("\r");
  host.bridge.handleCustomInput("typed local answer");
  host.bridge.handleCustomInput("\r");
  const customDetails = (await custom).details as {
    answers: { value: string; wasCustom: boolean }[];
  };
  questionnaireCustom = customDetails.answers[0]?.value;
  assert.equal(questionnaireCustom, "typed local answer");
  assert.equal(customDetails.answers[0]?.wasCustom, true);
  const cancelled = questionnaire.execute(
    "installed-smoke-cancel",
    customParams,
    undefined,
    undefined,
    host.session.extensionRunner.createContext() as ExtensionToolContext,
  );
  await ready();
  host.bridge.handleCustomInput("\x1b[B");
  host.bridge.handleCustomInput("\r");
  host.bridge.handleCustomInput("\x1b");
  assert.equal(
    host.bridge.activeDialog?.kind,
    "custom",
    "Escape in questionnaire text editor must return to its options",
  );
  host.bridge.handleCustomInput("\x1b");
  questionnaireCancelled = ((await cancelled).details as { cancelled: boolean })
    .cancelled;
  assert.equal(questionnaireCancelled, true);
  const explicitlyCancelled = ask();
  await ready();
  host.bridge.cancelDialog();
  questionnaireExplicitCancel = (
    (await explicitlyCancelled).details as { cancelled: boolean }
  ).cancelled;
  assert.equal(questionnaireExplicitCancel, true);
  const nestedCancelled = questionnaire.execute(
    "installed-smoke-force-cancel",
    customParams,
    undefined,
    undefined,
    host.session.extensionRunner.createContext() as ExtensionToolContext,
  );
  await ready();
  host.bridge.handleCustomInput("\x1b[B");
  host.bridge.handleCustomInput("\r");
  host.bridge.cancelDialog();
  await assert.rejects(nestedCancelled, (error) => {
    assert(error instanceof UserCancelledInteractionError);
    assert(!(error instanceof TypeError));
    questionnaireNestedCancelError = error.name;
    return true;
  });
  assert.equal(host.bridge.pendingDialogCount, 0);
  const inputOnce = () => {
    host.bridge.processTerminalInput("x");
    host.bridge.setEditorText("local draft");
    host.bridge.handleEditorInput("\r");
  };
  inputOnce();
  assert.equal(inputCalls, 1);
  assert.equal(submissions, 1);
  await host.reload();
  const reloadedAdvisorFactory = host.bridge.getEditorComponent();
  assert(
    reloadedAdvisorFactory && reloadedAdvisorFactory !== hostEditorFactory,
    "Advisor must wrap the fresh host baseline after reload",
  );
  assert.notEqual(
    reloadedAdvisorFactory,
    firstAdvisorFactory,
    "Reload must recreate the advisor factory",
  );
  inputOnce();
  assert.equal(inputCalls, 2);
  assert.equal(submissions, 2);
  assert.equal(startups, 2);
  assert.equal(shutdowns, 1);
  assert.equal(widgetDisposals, 1);
  assert.deepEqual(
    [...host.session.getAllTools().map((tool) => tool.name)].sort(),
    [...tools].sort(),
  );
  extensionErrors = host.session.resourceLoader.getExtensions().errors;
  hostErrors = host.diagnostics.filter(
    (error) => !error.startsWith("Presentation replaced:"),
  );
  assert.deepEqual(extensionErrors, []);
  assert.deepEqual(hostErrors, []);
  assert.deepEqual(deniedDialogs, []);
} finally {
  await host.close();
}
assert.equal(shutdowns, 2);
assert.equal(widgetDisposals, 2);
assert.deepEqual(networkAttempts, []);
console.log(
  `INSTALLED_MODULES_RESULT ${JSON.stringify({ loadedPackages: manifest.map(({ name, version }) => `${name}@${version}`), loadedPaths, tools, commands, skillCount: skillNames.length, extensionErrors, hostErrors, networkAttempts, startups, shutdowns, inputCalls, submissions, widgetDisposals, questionnaireSelected, questionnaireCustom, questionnaireCancelled, questionnaireExplicitCancel, questionnaireNestedCancelError, advisorEditorWrapper: host.bridge.getEditorComponent() !== undefined && host.bridge.getEditorComponent() !== hostEditorFactory, presentationOwners: loadedPaths.filter(replacedPresentation), filteredPresentationDiagnostics: host.diagnostics.filter((error) => error.startsWith("Presentation replaced:")) })}`,
);
