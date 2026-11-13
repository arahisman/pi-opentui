import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ConfigurationDraft } from "../src/core/configuration.ts";
import type { KeyEvent, PasteEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { PiHost } from "../src/host/controller.ts";
import { OverlayManager } from "../src/ui/overlays.ts";
import {
  SettingsPanel,
  type DisplaySettings,
  type SettingsCallbacks,
} from "../src/ui/settings-panel.ts";

async function setup(
  callbacks: Pick<SettingsCallbacks, "loadConfiguration"> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "pi-settings-panel-"));
  const host = await PiHost.create({
    cwd: root,
    agentDir: join(root, "agent"),
    clean: true,
    extensionFactories: [
      (pi) =>
        pi.registerProvider("settings-fixture", {
          api: "openai-completions",
          apiKey: "offline",
          baseUrl: "http://127.0.0.1:9",
          models: ["first", "second"].map((id) => ({
            id,
            name: id === "first" ? "First model" : "Second model",
            input: ["text"],
            reasoning: true,
            contextWindow: 100000,
            maxTokens: 1000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          })),
        }),
    ],
  });
  await host.selectModel("settings-fixture", "first");
  const renderer = await createTestRenderer({
    width: 110,
    height: 30,
    kittyKeyboard: true,
  });
  const overlay = new OverlayManager(renderer.renderer);
  const key = (event: KeyEvent) => overlay.handleKey(event);
  const paste = (event: PasteEvent) => {
    event.preventDefault();
    overlay.handlePaste(new TextDecoder().decode(event.bytes));
  };
  renderer.renderer.keyInput.on("keypress", key);
  renderer.renderer.keyInput.on("paste", paste);
  let display: DisplaySettings = {
    sidebarVisible: true,
    thinkingExpanded: false,
    toolsExpanded: false,
  };
  let applied = 0;
  const panel = new SettingsPanel(host, overlay, {
    getDisplay: () => ({ ...display }),
    applyDisplay: (patch) => {
      display = patch;
      applied++;
    },
    ...callbacks,
  });
  const choose = async (query: string) => {
    await renderer.mockInput.pasteBracketedText(query);
    renderer.mockInput.pressEnter();
    await Bun.sleep(5);
    await renderer.renderOnce();
  };
  return {
    ...renderer,
    root,
    host,
    overlay,
    panel,
    choose,
    get display() {
      return display;
    },
    get applied() {
      return applied;
    },
    cleanup: async () => {
      panel.cancel();
      renderer.renderer.keyInput.off("keypress", key);
      renderer.renderer.keyInput.off("paste", paste);
      overlay.dispose();
      await host.close();
      await renderer.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Preferences stages model choice and Cancel preserves model and session", async () => {
  const s = await setup();
  try {
    const session = s.host.session;
    const settingsPath = join(s.root, "agent", "settings.json");
    const settingsBefore = existsSync(settingsPath)
      ? readFileSync(settingsPath, "utf8")
      : undefined;
    await s.panel.open();
    await s.renderOnce();
    const frame = s.captureCharFrame();
    expect(frame).toContain("Preferences");
    expect(frame).toContain("Max workers");
    expect(frame).toContain("Unavailable");
    await s.choose("Main agent");
    await s.choose("Second model");
    expect(s.captureCharFrame()).toContain("Changes not applied");
    expect(s.host.session.model?.id).toBe("first");
    await s.choose("[ Cancel ]");
    expect(s.overlay.isOpen).toBe(false);
    expect(s.host.session.model?.id).toBe("first");
    expect(s.host.session).toBe(session);
    expect(
      existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : undefined,
    ).toBe(settingsBefore);
  } finally {
    await s.cleanup();
  }
});

test("Display tab changes remain staged, Apply persists at an idle boundary without changing session", async () => {
  const s = await setup();
  try {
    const session = s.host.session;
    await s.panel.open();
    s.mockInput.pressTab();
    s.mockInput.pressTab();
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain("Reasoning blocks");
    await s.choose("Reasoning blocks");
    expect(s.display.thinkingExpanded).toBe(false);
    expect(s.applied).toBe(0);
    await s.panel.apply();
    expect(s.applied).toBe(1);
    expect(s.display.thinkingExpanded).toBe(true);
    expect(s.host.session).toBe(session);
    expect(s.overlay.isOpen).toBe(false);
  } finally {
    await s.cleanup();
  }
});

test("Apply waits for idle and pending Cancel prevents a later model change", async () => {
  const s = await setup();
  let idle!: () => void;
  const originalWait = s.host.session.waitForIdle;
  try {
    await s.panel.open();
    await s.choose("Main agent");
    await s.choose("Second model");
    s.host.session.waitForIdle = () =>
      new Promise<void>((resolve) => {
        idle = resolve;
      });
    const pending = s.panel.apply();
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain("next safe boundary");
    expect(s.host.session.model?.id).toBe("first");
    s.mockInput.pressKey("\x1b");
    idle();
    await pending;
    expect(s.host.session.model?.id).toBe("first");
    expect(s.overlay.isOpen).toBe(false);
  } finally {
    s.host.session.waitForIdle = originalWait;
    await s.cleanup();
  }
});

test("Apply rejects externally changed settings before changing selected model", async () => {
  const s = await setup();
  try {
    await s.panel.open();
    await s.choose("Main agent");
    await s.choose("Second model");
    writeFileSync(
      join(s.root, "agent", "settings.json"),
      '{"changedExternally":true}',
    );
    await s.panel.apply();
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain("changed outside Preferences");
    expect(s.host.session.model?.id).toBe("first");
  } finally {
    await s.cleanup();
  }
});

test("Apply changes the selected main model only after explicit confirmation", async () => {
  const s = await setup();
  try {
    const session = s.host.session;
    await s.panel.open();
    await s.choose("Main agent");
    await s.choose("Second model");
    expect(s.host.session.model?.id).toBe("first");
    await s.panel.apply();
    expect(s.host.session.model?.id).toBe("second");
    expect(s.host.session).toBe(session);
    const saved = JSON.parse(
      readFileSync(join(s.root, "agent", "settings.json"), "utf8"),
    );
    expect(saved.defaultProvider).toBe("settings-fixture");
    expect(saved.defaultModel).toBe("second");
  } finally {
    await s.cleanup();
  }
});

function advisorProjects(root: string) {
  const resumed = join(root, "resumed-project");
  mkdirSync(resumed, { recursive: true });
  const module = join(
    root,
    "agent",
    "local-packages",
    "advisor",
    "src",
    "advisor",
    "watchdog-config.ts",
  );
  mkdirSync(dirname(module), { recursive: true });
  writeFileSync(
    module,
    'import {join} from "node:path"; export async function collectConfigCandidates(cwd) { return [{path:join(cwd,"WATCHDOG.yml")}]; }',
  );
  const initial =
    "main: false\nunknown: retain\nadvisors:\n  - name: Muse\n    model: settings-fixture/first\n    enabled: false\n";
  const launchedFile = join(root, "WATCHDOG.yml"),
    resumedFile = join(resumed, "WATCHDOG.yml");
  writeFileSync(launchedFile, initial);
  writeFileSync(resumedFile, initial);
  const manager = SessionManager.create(
    resumed,
    join(root, "resumed-sessions"),
  );
  manager.appendMessage({
    role: "user",
    content: "Resume project fixture",
    timestamp: Date.now(),
  });
  return {
    resumed,
    launchedFile,
    resumedFile,
    sessionFile: manager.getSessionFile()!,
    initial,
  };
}

test("cross-project resume discovers and applies Preferences in the active session project", async () => {
  let loadedCwd: string | undefined;
  const s = await setup({
    loadConfiguration: async (options, trusted) => {
      loadedCwd = options.cwd;
      return ConfigurationDraft.open(options, trusted);
    },
  });
  try {
    const projects = advisorProjects(s.root);
    await s.host.switchSession(projects.sessionFile);
    expect(s.host.options.cwd).toBe(s.root);
    expect(s.host.session.sessionManager.getCwd()).toBe(projects.resumed);
    await s.panel.open();
    expect(loadedCwd).toBe(projects.resumed);
    await s.choose("Advisor");
    await s.choose("Main-session advisor");
    await s.choose("Back");
    await s.panel.apply();
    expect(readFileSync(projects.launchedFile, "utf8")).toBe(projects.initial);
    expect(readFileSync(projects.resumedFile, "utf8")).toContain("main: true");
    expect(readFileSync(projects.resumedFile, "utf8")).toContain(
      "enabled: false",
    );
  } finally {
    await s.cleanup();
  }
});

test("a session switch during asynchronous Preferences discovery rejects the old project draft", async () => {
  let loaded!: () => void;
  let finish!: () => void;
  const loading = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const s = await setup({
    loadConfiguration: async (options, trusted) => {
      const draft = await ConfigurationDraft.open(options, trusted);
      loaded();
      await pending;
      return draft;
    },
  });
  try {
    const projects = advisorProjects(s.root);
    const opening = s.panel.open();
    await loading;
    await s.host.switchSession(projects.sessionFile);
    finish();
    await opening;
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain("Session or project changed");
    expect(readFileSync(projects.launchedFile, "utf8")).toBe(projects.initial);
    expect(readFileSync(projects.resumedFile, "utf8")).toBe(projects.initial);
  } finally {
    finish();
    await s.cleanup();
  }
});

test("Apply rejects a project identity change while waiting for idle without writing either project", async () => {
  const s = await setup();
  let release!: () => void;
  const session = s.host.session;
  const originalWait = session.waitForIdle;
  const originalCwd = session.sessionManager.getCwd;
  try {
    const projects = advisorProjects(s.root);
    await s.panel.open();
    await s.choose("Advisor");
    await s.choose("Main-session advisor");
    await s.choose("Back");
    let waits = 0;
    session.waitForIdle = () =>
      ++waits === 1
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : Promise.resolve();
    const applying = s.panel.apply();
    session.sessionManager.getCwd = () => projects.resumed;
    release();
    await applying;
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain("Session or project changed");
    expect(readFileSync(projects.launchedFile, "utf8")).toBe(projects.initial);
    expect(readFileSync(projects.resumedFile, "utf8")).toBe(projects.initial);
  } finally {
    session.waitForIdle = originalWait;
    session.sessionManager.getCwd = originalCwd;
    await s.cleanup();
  }
});
