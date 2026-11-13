import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createTestRenderer } from "@opentui/core/testing";
import { TextAttributes, type CapturedFrame } from "@opentui/core";
import { PiHost } from "../src/host/controller.ts";
import { Application } from "../src/ui/application.ts";

const output = resolve(process.argv[2] ?? ".artifacts/screens");
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), "pi-opentui-visual-"));
let modelRequests = 0;
const host = await PiHost.create({
  cwd: temporary,
  agentDir: join(temporary, "agent"),
  clean: true,
  extensionFactories: [
    (pi) =>
      pi.registerProvider("visual-fixture", {
        name: "Visual fixture · no API calls",
        api: "openai-completions",
        apiKey: "offline",
        baseUrl: "http://127.0.0.1:9",
        streamSimple: () => {
          modelRequests++;
          throw new Error("Visual fixtures must not make a model request");
        },
        models: [
          {
            id: "sol",
            name: "Sol",
            input: ["text"],
            reasoning: true,
            contextWindow: 500000,
            maxTokens: 32000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      }),
  ],
});
await host.selectModel("visual-fixture", "sol");
const setup = await createTestRenderer({
  width: 150,
  height: 46,
  kittyKeyboard: true,
});
const copiedSelections: string[] = [];
setup.renderer.copyToClipboardOSC52 = (text) => {
  copiedSelections.push(text);
  return true;
};
const app = new Application(setup.renderer, host, () => {});
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const cssColor = (color: { toInts(): number[] }) => {
  const [r, g, b, a] = color.toInts();
  return `rgba(${r},${g},${b},${(a ?? 255) / 255})`;
};
function html(frame: CapturedFrame) {
  return `<html><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;background:#0a0a0a}body{font:16.6px/20px Menlo,monospace}.row{height:20px;white-space:pre;overflow:hidden}.row span{display:inline-block;height:20px;vertical-align:top}</style></head><body>${frame.lines
    .map(
      (line) =>
        `<div class="row">${line.spans
          .map((span) => {
            let fg = cssColor(span.fg),
              bg = cssColor(span.bg);
            if (span.attributes & TextAttributes.INVERSE) [fg, bg] = [bg, fg];
            return `<span style="color:${fg};background:${bg};font-weight:${span.attributes & TextAttributes.BOLD ? "bold" : "normal"};font-style:${span.attributes & TextAttributes.ITALIC ? "italic" : "normal"};text-decoration:${span.attributes & TextAttributes.UNDERLINE ? "underline" : "none"};opacity:${span.attributes & TextAttributes.DIM ? 0.65 : 1}">${escape(span.text)}</span>`;
          })
          .join("")}</div>`,
    )
    .join("")}</body></html>`;
}
async function capture(name: string) {
  await Bun.sleep(40);
  await setup.renderOnce();
  const frame = setup.captureSpans();
  writeFileSync(join(output, `${name}.json`), JSON.stringify(frame));
  const markup = html(frame);
  writeFileSync(join(output, `${name}.html`), markup);
  await page.setViewportSize({
    width: frame.cols * 10,
    height: frame.rows * 20,
  });
  await page.setContent(markup);
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await page.screenshot({ path: join(output, `${name}.png`) });
  console.log(name, `${frame.cols}x${frame.rows}`);
}
try {
  await capture("01-welcome");
  host.session.sessionManager.appendMessage({
    role: "user",
    content: "Проверь отмену задачи и восстановление сессии.",
    timestamp: Date.now(),
  });
  host.session.sessionManager.appendMessage({
    role: "assistant",
    api: "openai-completions",
    provider: "visual-fixture",
    model: "sol",
    timestamp: Date.now(),
    stopReason: "stop",
    content: [
      {
        type: "text",
        text: "Исправил повторную отмену. Очистка завершается до применения настроек.\n\n```diff\n async def stop(self):\n     task = self.active_task\n-    task.cancel()\n+    if not task.cancelling():\n+        task.cancel()\n     await asyncio.shield(task)\n```\n\nПовторная отмена и смена настроек проверены. Все четыре теста проходят.",
      },
      {
        type: "toolCall",
        id: "read-1",
        name: "read",
        arguments: { path: "tests/test_engine.py" },
      },
    ],
    usage: {
      input: 18000,
      output: 4000,
      cacheRead: 43000,
      cacheWrite: 0,
      totalTokens: 65000,
      cost: {
        input: 0.05,
        output: 0.12,
        cacheRead: 0.01,
        cacheWrite: 0,
        total: 0.18,
      },
    },
  });
  host.session.sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "read-1",
    toolName: "read",
    isError: false,
    content: [
      {
        type: "text",
        text: "4 tests passed. Cancellation and recovery preserve saved state.",
      },
    ],
    timestamp: Date.now(),
  });
  host.session.sessionManager.appendCustomMessageEntry(
    "pi-omp-advisor",
    "Check preserved state",
    true,
    {
      notes: [
        {
          adviceId: "n1",
          advisor: "DeepSeek",
          model: "deepseek-flash",
          shortTitle: "Сохранение состояния",
          note: "Проверь сохранение результата перед обновлением статуса.",
          createdAt: Date.now() - 120_000,
        },
        {
          adviceId: "n2",
          advisor: "metis",
          model: "deepseek-flash",
          shortTitle: "Повторный полный прогон",
          note: "Повтори всю проверку без изменений исходников.",
          createdAt: Date.now() - 15_000,
        },
      ],
    },
  );
  for (const [noteId, rating, reason] of [
    ["n1", "useful", "Выявлен пропущенный путь сохранения."],
    ["n2", "harmful", "Повтор не добавляет доказательств при неизменных входах."],
  ])
    host.session.sessionManager.appendCustomEntry(
      "pi-opentui-advisor-feedback",
      { noteId, rating, reason, timestamp: new Date().toISOString(), source: "assistant" },
    );
  host.session.sessionManager.appendSessionInfo("Cancellation & recovery");
  host.session.refreshContext();
  host.emit("change");
  for (
    let tries = 0;
    tries < 150 &&
    !setup.captureCharFrame().includes("Исправил повторную отмену");
    tries++
  ) {
    await Bun.sleep(20);
    await setup.renderOnce();
  }
  await capture("02-conversation");
  app.commandPalette();
  await capture("03-commands");
  app.overlays.close();
  app.models();
  await capture("04-models");
  app.overlays.close();
  await app.settings();
  await capture("05-settings");
  app.overlays.close();
  await app.sessions();
  await capture("06-sessions");
  app.overlays.close();
  app.usage();
  await capture("07-usage");
  app.overlays.close();
  app.context();
  await capture("08-context");
  app.overlays.close();
  app.advisor();
  await capture("09-advisor");
  app.overlays.close();
  await app.connections();
  await capture("15-connections");
  app.overlays.close();
  app.tree();
  await capture("16-tree");
  app.overlays.close();
  await app.submit("/login");
  await capture("17-providers");
  setup.mockInput.pressEnter();
  await capture("18-sign-in-methods");
  app.overlays.close();
  host.bridge.setEditorText("");
  await setup.mockInput.typeText("/mo");
  await capture("19-completion");
  host.bridge.setEditorText("");
  app.advisor();
  setup.mockInput.pressEnter();
  await capture("20-advisor-detail");
  if (!setup.captureCharFrame().includes("Related entry:"))
    throw new Error("Advisor detail did not expose its actual message linkage");
  app.overlays.close();

  const sessionFile = host.session.sessionFile;
  if (!sessionFile)
    throw new Error("Request capture requires the saved fixture session");
  const eventsDirectory = `${sessionFile}.usage/events`;
  mkdirSync(eventsDirectory, { recursive: true });
  const eventBase = {
    version: 1,
    rootSession: sessionFile,
    sessionFile,
    sessionId: host.session.sessionManager.getSessionId(),
    reported: true,
    reasoning: null,
  };
  const events = [
    {
      ...eventBase,
      eventId: "visual-main",
      timestamp: new Date(Date.now() - 3).toISOString(),
      role: "primary",
      provider: "visual-fixture",
      model: "sol",
      tokens: { input: 18000, output: 4000, cacheRead: 43000, cacheWrite: 0 },
      estimatedCost: 0.18,
    },
    {
      ...eventBase,
      eventId: "visual-child",
      timestamp: new Date(Date.now() - 2).toISOString(),
      sessionId: "visual-child",
      role: "subagent",
      provider: "visual-fixture",
      model: "muse",
      tokens: { input: 8000, output: 1400, cacheRead: 6000, cacheWrite: 0 },
      estimatedCost: 0.02,
    },
    {
      ...eventBase,
      eventId: "visual-advisor",
      timestamp: new Date(Date.now() - 1).toISOString(),
      role: "advisor",
      advisor: "DeepSeek",
      provider: "visual-fixture",
      model: "deepseek-flash",
      tokens: { input: 2000, output: 700, cacheRead: 0, cacheWrite: 0 },
      estimatedCost: 0.005,
    },
    {
      ...eventBase,
      eventId: "visual-compaction",
      requestId: "visual-compaction",
      timestamp: new Date().toISOString(),
      role: "compaction",
      phase: "started",
      provider: "visual-fixture",
      model: "sol-summary",
      reported: false,
      tokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
      estimatedCost: null,
    },
  ];
  writeFileSync(
    join(eventsDirectory, "visual.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  host.emit("change");
  app.requests();
  await capture("21-request-list");
  app.overlays.handlePaste("sol ·");
  setup.mockInput.pressEnter();
  await capture("22-request-detail");
  if (!setup.captureCharFrame().includes("Input: 18k"))
    throw new Error(
      "Request detail did not display the selected measured request",
    );
  app.overlays.close();

  const authCaptures: { kind: string; cancelled: boolean }[] = [];
  const authFile = join(temporary, "agent/auth.json");
  const authBefore = existsSync(authFile)
    ? readFileSync(authFile, "utf8")
    : undefined;
  for (const kind of ["oauth", "device", "secret"] as const) {
    const runtime = host.session.modelRuntime;
    const getProviders = runtime.getProviders;
    const login = runtime.login;
    const catalog = getProviders.call(runtime);
    const oauthProvider = catalog.find((provider) => provider.auth.oauth);
    const keyProvider = catalog.find((provider) => provider.auth.apiKey?.login);
    if (!oauthProvider || !keyProvider)
      throw new Error(
        "Installed SDK auth metadata is unavailable for offline fixtures",
      );
    let started = false,
      cancelled = false,
      finished = false;
    try {
      runtime.getProviders = () => [
        {
          ...(kind === "secret" ? keyProvider : oauthProvider),
          id: "visual-auth-fixture",
          name: "Offline sign-in fixture",
          getModels: () => [],
          auth:
            kind === "secret"
              ? { apiKey: keyProvider.auth.apiKey }
              : { oauth: oauthProvider.auth.oauth },
        },
      ];
      runtime.login = async (_provider, _type, interaction) => {
        started = true;
        try {
          if (kind === "secret") {
            await interaction.prompt({
              type: "secret",
              message: "Paste API key",
            });
            throw new Error(
              "Offline secret fixture must be cancelled, not submitted",
            );
          }
          interaction.notify(
            kind === "oauth"
              ? {
                  type: "auth_url",
                  url: "https://example.invalid/sign-in",
                  instructions:
                    "Open this link in your browser to continue sign-in.",
                }
              : {
                  type: "device_code",
                  verificationUri: "https://example.invalid/device",
                  userCode: "DEMO-4821",
                  intervalSeconds: 5,
                  expiresInSeconds: 600,
                },
          );
          return await new Promise<never>((_resolve, reject) => {
            const abort = () =>
              reject(new Error("Offline sign-in fixture cancelled"));
            if (interaction.signal?.aborted) abort();
            else
              interaction.signal?.addEventListener("abort", abort, {
                once: true,
              });
          });
        } finally {
          cancelled = interaction.signal?.aborted === true;
          finished = true;
        }
      };
      await app.submit("/login");
      await Bun.sleep(20);
      setup.mockInput.pressEnter();
      await Bun.sleep(20);
      setup.mockInput.pressEnter();
      for (let tries = 0; tries < 50 && !started; tries++) await Bun.sleep(5);
      if (!started)
        throw new Error(`Offline ${kind} sign-in fixture did not start`);
      if (kind === "secret") {
        const dummy = "offline-private-fixture-value";
        app.overlays.handlePaste(dummy);
        await setup.renderOnce();
        if (setup.captureCharFrame().includes(dummy))
          throw new Error("Secret fixture was echoed in the terminal cells");
      }
      await capture(
        kind === "oauth"
          ? "23-oauth-waiting"
          : kind === "device"
            ? "24-device-code-waiting"
            : "25-secret-input-masked",
      );
      const capturedAuth = setup.captureCharFrame();
      if (
        kind === "oauth" &&
        !capturedAuth.includes("https://example.invalid/sign-in")
      )
        throw new Error("OAuth waiting link was not rendered");
      if (kind === "device" && !capturedAuth.includes("Code: DEMO-4821"))
        throw new Error("Device-code waiting state was not rendered");
      if (
        kind === "secret" &&
        (!capturedAuth.includes("Secret input") ||
          !capturedAuth.includes("•••"))
      )
        throw new Error("Secret input was not visibly masked");
    } finally {
      app.overlays.close();
      for (let tries = 0; tries < 100 && !finished; tries++) await Bun.sleep(5);
      runtime.getProviders = getProviders;
      runtime.login = login;
      app.overlays.close();
    }
    if (!cancelled || !finished)
      throw new Error(`Offline ${kind} sign-in did not settle on cancellation`);
    authCaptures.push({ kind, cancelled });
  }
  const authAfter = existsSync(authFile)
    ? readFileSync(authFile, "utf8")
    : undefined;
  if (authBefore !== authAfter)
    throw new Error("Offline auth captures changed credential storage");
  if (modelRequests !== 0)
    throw new Error("Visual capture attempted a model request");
  writeFileSync(
    join(output, "auth-fixture-verification.json"),
    JSON.stringify(
      {
        interactions: authCaptures,
        credentialStorageUnchanged: true,
        modelRequests,
        browserActions: false,
      },
      null,
      2,
    ),
  );
  app.commandPalette("compact");
  await capture("26-command-search");
  app.overlays.close();
  host.session.sessionManager.appendMessage({
    role: "assistant",
    api: "openai-completions",
    provider: "visual-fixture",
    model: "sol",
    timestamp: Date.now(),
    stopReason: "toolUse",
    content: [
      {
        type: "toolCall",
        id: "preview-read",
        name: "read",
        arguments: { path: "src/engine.ts" },
      },
      {
        type: "toolCall",
        id: "preview-code",
        name: "codemode",
        arguments: {
          code: "const result = await tools.runChecks();\nreturn result;",
        },
      },
      {
        type: "toolCall",
        id: "preview-write",
        name: "write",
        arguments: { path: "src/engine.ts", content: "await cleanup();" },
      },
    ],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  for (const [id, toolName, text] of [
    [
      "preview-read",
      "read",
      "async function stop() {\n  await cleanup();\n  saveSession();\n}\n\n// More source below…",
    ],
    [
      "preview-code",
      "codemode",
      "checks: 17 passed\nerrors: 0\nduration: 2.1s",
    ],
    [
      "preview-write",
      "write",
      "Updated src/engine.ts\nSession cleanup is atomic.",
    ],
  ])
    host.session.sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: id!,
      toolName: toolName!,
      isError: false,
      content: [{ type: "text", text: text! }],
      timestamp: Date.now(),
    });
  host.invalidateProjection();
  host.emit("change");
  await Bun.sleep(50);
  app.shell.setToolDisplay("compact");
  await capture("27-actions-compact");
  app.shell.setToolDisplay("full");
  await capture("28-actions-full");
  app.shell.setToolDisplay("collapsed");
  await capture("29-actions-collapsed");
  app.shell.setToolDisplay("compact");
  host.bridge.notify(
    "Sol–Pi · Observation Pack\n4,684 context tokens avoided. Session state preserved.",
    "info",
  );
  await capture("30-notification-panel");
  setup.renderer.root.findDescendantById("notifications")!.visible = false;
  setup.mockInput.pressKey("x", { ctrl: true });
  await capture("31-leader-mode");
  setup.mockInput.pressKey("z");
  Object.defineProperty(host.session, "isStreaming", {
    configurable: true,
    get: () => true,
  });
  host.bridge.setWorkingMessage("Checking changes");
  await capture("32-working-indicator");
  delete (host.session as unknown as { isStreaming?: boolean }).isStreaming;
  host.session.sessionManager.appendCompaction(
    "## Progress\nImplementation and checks complete.\n<read-files>\nsrc/engine.ts\ntest/recovery.test.ts\n</read-files>",
    null,
    61000,
  );
  host.session.sessionManager.appendCustomMessageEntry(
    "workspace-check",
    "**Workspace checks**\n\nSource files and saved state verified.\n\n```ts\nawait session.flush();\n```",
    true,
  );
  host.invalidateProjection();
  host.emit("change");
  await capture("33-system-extension-blocks");
  const selectionRows = setup.captureCharFrame().split("\n");
  const selectionY = selectionRows.findIndex((line) =>
    line.includes("Usage & context"),
  );
  const selectionX = selectionRows[selectionY]!.indexOf("Usage & context");
  await setup.mockMouse.pressDown(selectionX, selectionY);
  await setup.mockMouse.emitMouseEvent("drag", selectionX + 3, selectionY);
  host.emit("change");
  await capture("34-selection-during-refresh");
  await setup.mockMouse.emitMouseEvent("drag", selectionX + 14, selectionY);
  await setup.mockMouse.release(selectionX + 14, selectionY);
  host.emit("change");
  await capture("35-selection-after-copy");
  if (setup.renderer.getSelection()?.getSelectedText() !== "Usage & context")
    throw new Error("Selection was lost after copy/refresh");
  if (copiedSelections.at(-1) !== "Usage & context")
    throw new Error("Selection copy transport did not receive final text");
  setup.renderer.clearSelection();
  const originalSnapshot = host.snapshot.bind(host);
  host.snapshot = () => ({
    ...originalSnapshot(),
    status: "compacting",
    compaction: {
      startedAt: Date.now() - 12_000,
      automatic: true,
      reason: "threshold",
      tokensBefore: 137000,
    },
  });
  host.emit("change");
  await capture("36-compacting-context");
  setup.resize(68, 32);
  await capture("37-compacting-context-narrow");
  setup.resize(150, 46);
  host.snapshot = originalSnapshot;
  host.emit("change");
  const question = host.bridge.select("Как обработать конфликт файлов?", [
    "Сохранить обе версии",
    "Остановиться и показать diff",
    "Свой ответ",
  ]);
  await capture("10-question");
  host.bridge.cancelDialog();
  await question;
  await Bun.sleep(25);
  app.showError(
    "Provider connection interrupted. Session and draft are saved.",
  );
  await capture("11-error");
  app.overlays.close();
  setup.resize(68, 32);
  host.bridge.setEditorText("А ещё проверь сохранность черновика…");
  await capture("12-narrow");
  app.shell.toggleSidebar();
  await capture("13-narrow-sidebar");
  app.shell.toggleSidebar();
  setup.resize(30, 12);
  app.commandPalette();
  await capture("14-tiny");
} finally {
  app.dispose();
  await host.close();
  await setup.dispose();
  await browser.close();
  rmSync(temporary, { recursive: true, force: true });
}
