import { test, expect, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { matchesKey } from "@earendil-works/pi-tui";
import { PiHost, hostEditorFactory } from "../src/host/controller.ts";
import { Application } from "../src/ui/application.ts";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

async function fixture(extensionFactories: ExtensionFactory[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "pi-opentui-app-"));
  const host = await PiHost.create({
    cwd: dir,
    agentDir: join(dir, "agent"),
    clean: true,
    extensionFactories,
  });
  const setup = await createTestRenderer({
    width: 140,
    height: 42,
    kittyKeyboard: true,
    exitOnCtrlC: false,
  });
  const app = new Application(setup.renderer, host, () => {});
  const frame = async () => {
    await Bun.sleep(25);
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  return {
    dir,
    host,
    setup,
    app,
    frame,
    dispose: async () => {
      app.dispose();
      await host.close();
      await setup.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("actual host UI routes native editing, Shift+Enter, commands and resize without losing draft", async () => {
  const f = await fixture();
  try {
    await f.setup.mockInput.typeText("hello");
    f.setup.mockInput.pressEnter({ shift: true });
    await f.setup.mockInput.typeText("world");
    expect(f.host.bridge.getEditorText()).toBe("hello\nworld");
    await f.frame();
    expect(f.app.shell.editor.plainText).toBe("hello\nworld");
    f.setup.mockInput.pressKey("p", { ctrl: true });
    expect(await f.frame()).toContain("Commands");
    f.setup.mockInput.pressEscape();
    expect(f.host.bridge.getEditorText()).toBe("hello\nworld");
    f.setup.resize(65, 24);
    await f.frame();
    f.setup.mockInput.pressKey("x", { ctrl: true });
    f.setup.mockInput.pressKey("b");
    expect(await f.frame()).toContain("Usage & context");
    f.setup.resize(150, 45);
    await f.frame();
    expect(f.host.bridge.getEditorText()).toBe("hello\nworld");
    f.setup.mockInput.pressKey("p", { ctrl: true });
    await f.setup.mockInput.typeText("usage");
    f.setup.mockInput.pressEnter();
    expect(await f.frame()).toContain("Usage · by model");
  } finally {
    await f.dispose();
  }
});

test("extension questions resolve and cancellation never hangs the host", async () => {
  const f = await fixture();
  try {
    const choice = f.host.bridge.select("Fixture question", ["Alpha", "Beta"]);
    expect(await f.frame()).toContain("Fixture question");
    f.setup.mockInput.pressArrow("down");
    f.setup.mockInput.pressEnter();
    expect(await choice).toBe("Beta");
    await f.frame();
    const input = f.host.bridge.input("Enter fixture value");
    await f.frame();
    f.setup.mockInput.pressEscape();
    expect(await input).toBeUndefined();
    const custom = f.host.bridge.custom((_tui, theme, _keys, done) => ({
      render: () => [theme.fg("accent", "Native question")],
      invalidate() {},
      handleInput: (raw: string) => {
        if (matchesKey(raw, "enter")) done("native answer");
      },
    }));
    expect(await f.frame()).toContain("Native question");
    f.setup.mockInput.pressEnter();
    expect(await custom).toBe("native answer");
  } finally {
    await f.dispose();
  }
});

test("draft remains isolated across session switches and is restored on return", async () => {
  const f = await fixture();
  const newSession = f.host.newSession.bind(f.host);
  let pendingSession: ReturnType<PiHost["newSession"]> | undefined;
  const startSession = spyOn(f.host, "newSession").mockImplementation(() => {
    pendingSession = newSession();
    return pendingSession;
  });
  try {
    f.host.session.sessionManager.appendSessionInfo("Fixture session");
    const first = f.host.session.sessionFile!;
    f.host.bridge.setEditorText("First draft");
    await f.frame();
    f.app["commandPalette"]("new");
    f.setup.mockInput.pressEnter();
    for (let attempt = 0; attempt < 100; attempt++) {
      await f.frame();
      if (pendingSession && f.host.session.sessionFile !== first) break;
    }
    expect(pendingSession).toBeDefined();
    expect(f.host.session.sessionFile).not.toBe(first);
    await pendingSession;
    f.host.bridge.setEditorText("Second draft");
    await f.frame();
    await f.host.switchSession(first);
    await f.frame();
    expect(f.host.bridge.getEditorText()).toBe("First draft");
  } finally {
    if (pendingSession) await Promise.allSettled([pendingSession]);
    startSession.mockRestore();
    await f.dispose();
  }
});

test("startup questions render before SDK bind settles and an existing draft survives attach", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-opentui-startup-"));
  let host = await PiHost.create({
    cwd: dir,
    agentDir: join(dir, "agent"),
    clean: true,
  });
  host.session.sessionManager.appendSessionInfo("Saved startup fixture");
  const sessionFile = host.session.sessionFile!;
  host.store.saveDraft(sessionFile, "Saved before launch");
  await host.close();
  let answer: string | undefined;
  host = await PiHost.create({
    cwd: dir,
    agentDir: join(dir, "agent"),
    clean: true,
    sessionFile,
    deferBind: true,
    extensionFactories: [
      (pi) => {
        pi.on("session_start", async (_event, ctx) => {
          answer = await ctx.ui.select("Startup decision", [
            "Continue",
            "Cancel",
          ]);
        });
      },
    ],
  });
  const setup = await createTestRenderer({
    width: 130,
    height: 35,
    kittyKeyboard: true,
  });
  const app = new Application(setup.renderer, host, () => {});
  try {
    const binding = host.attach();
    await Bun.sleep(30);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Startup decision");
    setup.mockInput.pressEnter();
    await binding;
    await Bun.sleep(30);
    await setup.renderOnce();
    expect(answer).toBe("Continue");
    expect(host.bridge.getEditorText()).toBe("Saved before launch");
    expect(host.bridge.native.terminal.columns).toBe(130);
  } finally {
    app.dispose();
    await host.close();
    await setup.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rename is a local persisted session command and never becomes a model prompt", async () => {
  const f = await fixture();
  try {
    await f.app.submit("/name Recovery investigation");
    expect(f.host.session.sessionName).toBe("Recovery investigation");
    expect(await f.frame()).toContain("Recovery investigation");
    expect(f.host.transcript).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});

test("closing provider browser sign-in aborts its real interaction contract without credentials or model traffic", async () => {
  const f = await fixture();
  const runtime = f.host.session.modelRuntime;
  const providers = runtime.getProviders;
  const login = runtime.login;
  const provider = runtime
    .getProviders()
    .find((provider) => provider.auth.oauth)!;
  let started = false,
    aborted = false;
  try {
    expect(provider).toBeDefined();
    runtime.getProviders = () => [provider];
    runtime.login = async (_id, _type, interaction) => {
      started = true;
      interaction.notify({
        type: "auth_url",
        url: "https://example.invalid/sign-in",
      });
      return await new Promise((_resolve, reject) =>
        interaction.signal!.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("Fixture sign-in cancelled"));
          },
          { once: true },
        ),
      );
    };
    await f.app.submit("/login");
    await f.frame();
    f.setup.mockInput.pressEnter();
    await f.frame();
    f.setup.mockInput.pressEnter();
    expect(await f.frame()).toContain("Continue sign-in");
    expect(started).toBe(true);
    f.setup.mockInput.pressEscape();
    await f.frame();
    expect(aborted).toBe(true);
    expect(f.host.transcript).toHaveLength(0);
  } finally {
    runtime.getProviders = providers;
    runtime.login = login;
    await f.dispose();
  }
});

test("extension and keyboard tool expansion share one state", async () => {
  const f = await fixture();
  try {
    f.host.bridge.setToolsExpanded(true);
    await f.frame();
    expect(f.app.shell.toolsExpanded).toBe(true);
    f.setup.mockInput.pressKey("o", { ctrl: true });
    await f.frame();
    expect(f.host.bridge.getToolsExpanded()).toBe(false);
    expect(f.app.shell.toolsExpanded).toBe(false);
  } finally {
    await f.dispose();
  }
});

test("extension working message honors visibility in the rendered footer", async () => {
  const f = await fixture();
  try {
    Object.defineProperty(f.host.session, "isStreaming", {
      configurable: true,
      get: () => true,
    });
    f.host.bridge.setWorkingMessage("Indexing selected project");
    f.host.bridge.setWorkingIndicator({ frames: ["◇"], intervalMs: 250 });
    const workingFrame = await f.frame();
    expect(workingFrame).toContain("Indexing selected project");
    expect(workingFrame).toContain("◇");
    f.host.bridge.setWorkingVisible(false);
    expect(await f.frame()).not.toContain("Indexing selected project");
  } finally {
    delete (f.host.session as unknown as { isStreaming?: boolean }).isStreaming;
    await f.dispose();
  }
});

test("replacing a native editor wrapper cannot overwrite a newer draft with older persisted text", async () => {
  const f = await fixture();
  try {
    f.host.store.saveDraft(
      f.host.session.sessionFile!,
      "Older persisted draft",
    );
    f.host.bridge.setEditorText("Newest unsaved draft");
    f.host.bridge.setEditorComponent((tui, theme, keybindings) =>
      hostEditorFactory(tui, theme, keybindings),
    );
    await f.frame();
    expect(f.host.bridge.getEditorText()).toBe("Newest unsaved draft");
  } finally {
    await f.dispose();
  }
});

test("native command completion handles Tab and Escape without opening a second menu or sidebar", async () => {
  const f = await fixture();
  try {
    f.setup.resize(68, 28);
    await f.frame();
    await f.setup.mockInput.typeText("/adv");
    await f.frame();
    const editor = f.host.bridge
      .editorComponent as typeof f.host.bridge.editorComponent & {
      capturesViewportInput: boolean;
    };
    expect(editor.capturesViewportInput).toBe(true);
    f.setup.mockInput.pressEscape();
    await f.frame();
    expect(editor.capturesViewportInput).toBe(false);
    expect(f.app.overlays.isOpen).toBe(false);
    expect(f.setup.captureCharFrame()).not.toContain("Usage & context");
    f.host.bridge.setEditorText("");
    await f.setup.mockInput.typeText("/adv");
    await f.frame();
    f.setup.mockInput.pressTab();
    await f.frame();
    expect(f.host.bridge.getEditorText().trim()).toBe("/advice");
    expect(f.app.overlays.isOpen).toBe(false);
    f.setup.mockInput.pressEnter();
    expect(await f.frame()).toContain("Advisor history");
    expect(f.host.transcript).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});

test("a native-only command cannot silently become a model prompt", async () => {
  const f = await fixture();
  try {
    await f.app.submit("/share");
    expect(await f.frame()).toContain("native Pi command");
    expect(f.host.transcript).toHaveLength(0);
    expect(f.host.bridge.getEditorText()).toBe("/share");
  } finally {
    await f.dispose();
  }
});

test("OAuth waiting transitions to cancellable manual input without cancelling browser login", async () => {
  const f = await fixture();
  const runtime = f.host.session.modelRuntime;
  const providers = runtime.getProviders;
  const login = runtime.login;
  const provider = runtime
    .getProviders()
    .find((provider) => provider.auth.oauth)!;
  const manual = new AbortController();
  let interactionSignal: AbortSignal | undefined;
  let promptRejected = false;
  let finish!: () => void;
  let showManual!: () => void;
  try {
    runtime.getProviders = () => [provider];
    runtime.login = async (_id, _type, interaction) => {
      interactionSignal = interaction.signal;
      interaction.notify({
        type: "auth_url",
        url: "https://example.invalid/sign-in",
      });
      await new Promise<void>((resolve) => {
        showManual = resolve;
      });
      const pending = interaction.prompt({
        type: "manual_code",
        message: "Paste callback",
        signal: manual.signal,
      });
      void pending.catch(() => {
        promptRejected = true;
      });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { type: "api_key" };
    };
    await f.app.submit("/login");
    await f.frame();
    f.setup.mockInput.pressEnter();
    await f.frame();
    f.setup.mockInput.pressEnter();
    expect(await f.frame()).toContain("Continue sign-in");
    showManual();
    expect(await f.frame()).toContain("Paste callback");
    expect(interactionSignal?.aborted).toBe(false);
    manual.abort();
    expect(await f.frame()).not.toContain("Paste callback");
    expect(promptRejected).toBe(true);
    expect(interactionSignal?.aborted).toBe(false);
    finish();
    expect(await f.frame()).not.toContain("Continue sign-in");
    expect(f.host.transcript).toHaveLength(0);
  } finally {
    finish?.();
    runtime.getProviders = providers;
    runtime.login = login;
    await f.dispose();
  }
});

for (const kind of ["auth_url", "device_code"] as const) {
  test(`successful ${kind} login dismisses its waiting view`, async () => {
    const f = await fixture();
    const runtime = f.host.session.modelRuntime;
    const providers = runtime.getProviders;
    const login = runtime.login;
    const provider = runtime
      .getProviders()
      .find((provider) => provider.auth.oauth)!;
    let finish!: () => void;
    try {
      runtime.getProviders = () => [provider];
      runtime.login = async (_id, _type, interaction) => {
        interaction.notify(
          kind === "auth_url"
            ? { type: kind, url: "https://example.invalid/login" }
            : {
                type: kind,
                verificationUri: "https://example.invalid/device",
                userCode: "TEST",
              },
        );
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { type: "api_key" };
      };
      await f.app.submit("/login");
      await f.frame();
      f.setup.mockInput.pressEnter();
      await f.frame();
      f.setup.mockInput.pressEnter();
      const title = kind === "auth_url" ? "Continue sign-in" : "Device sign-in";
      expect(await f.frame()).toContain(title);
      finish();
      expect(await f.frame()).not.toContain(title);
      expect(f.host.transcript).toHaveLength(0);
    } finally {
      finish?.();
      runtime.getProviders = providers;
      runtime.login = login;
      await f.dispose();
    }
  });
}

test("completed mouse selection copies Unicode text once, ignores empty selection and detaches on disposal", async () => {
  const f = await fixture();
  const copy = spyOn(f.setup.renderer, "copyToClipboardOSC52").mockReturnValue(
    true,
  );
  try {
    const text = new TextRenderable(f.setup.renderer, {
      id: "copy-selection-fixture",
      position: "absolute",
      left: 0,
      top: 2,
      width: 40,
      height: 1,
      content: "Привет мир",
      selectable: true,
    });
    f.setup.renderer.root.add(text);
    await f.frame();
    await f.setup.mockMouse.pressDown(0, 2);
    await f.setup.mockMouse.moveTo(5, 2);
    expect(copy).not.toHaveBeenCalled();
    await f.setup.mockMouse.release(5, 2);
    await f.frame();
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy.mock.calls[0]?.[0]).toContain("Привет");
    await f.setup.mockMouse.click(30, 2);
    expect(copy).toHaveBeenCalledTimes(1);
    const count = f.setup.renderer.listenerCount("selection");
    f.app.dispose();
    expect(f.setup.renderer.listenerCount("selection")).toBe(count - 1);
  } finally {
    copy.mockRestore();
    await f.dispose();
  }
});

test("Ctrl+Enter inserts a newline while Enter still submits", async () => {
  const f = await fixture();
  const send = spyOn(f.host, "send").mockResolvedValue(undefined);
  try {
    await f.setup.mockInput.typeText("first");
    f.setup.mockInput.pressEnter({ ctrl: true });
    await f.setup.mockInput.typeText("second");
    await f.frame();
    expect(f.host.bridge.getEditorText()).toBe("first\nsecond");
    expect(send).not.toHaveBeenCalled();
    f.setup.mockInput.pressEnter();
    await f.frame();
    expect(send).toHaveBeenCalledWith("first\nsecond", false);
    expect(f.host.bridge.getEditorText()).toBe("");
  } finally {
    send.mockRestore();
    await f.dispose();
  }
});

test("Ctrl+C clears a nonempty multiline draft without submitting or aborting", async () => {
  const f = await fixture();
  const send = spyOn(f.host, "send").mockResolvedValue(undefined);
  const abort = spyOn(f.host, "abort").mockResolvedValue(undefined);
  try {
    f.host.bridge.setEditorText("Привет\nмир");
    await f.frame();
    f.setup.mockInput.pressKey("c", { ctrl: true });
    await f.frame();
    expect(f.host.bridge.getEditorText()).toBe("");
    expect(f.app.shell.editor.plainText).toBe("");
    expect(send).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  } finally {
    send.mockRestore();
    abort.mockRestore();
    await f.dispose();
  }
});

test("leader mode dims the composer and action mode is reachable and persisted from the top bar", async () => {
  const f = await fixture();
  try {
    f.host.bridge.setEditorText("Keep this draft");
    await f.frame();
    const composer = f.setup.renderer.root.findDescendantById(
      "composer",
    ) as BoxRenderable;
    const before = composer.borderColor;
    f.setup.mockInput.pressKey("x", { ctrl: true });
    await f.frame();
    expect(composer.borderColor).not.toEqual(before);
    f.setup.mockInput.pressKey("b");
    await f.frame();
    expect(composer.borderColor).toEqual(before);
    expect(f.host.bridge.getEditorText()).toBe("Keep this draft");
    const toggle =
      f.setup.renderer.root.findDescendantById("tool-display-mode")!;
    await f.setup.mockMouse.click(toggle.x + 1, toggle.y);
    await f.frame();
    expect(f.app.shell.toolDisplay).toBe("full");
    expect(f.host.store.loadPreferences().toolDisplay).toBe("full");
    f.setup.mockInput.pressKey("o", { ctrl: true });
    await f.frame();
    expect(f.host.store.loadPreferences().toolDisplay).toBe("compact");
  } finally {
    await f.dispose();
  }
});

test("notifications have a separate opaque panel and severity border", async () => {
  const f = await fixture();
  try {
    f.host.bridge.notify(
      "A local notification with a readable background",
      "warning",
    );
    expect(await f.frame()).toContain("A local notification");
    const box = f.setup.renderer.root.findDescendantById(
      "notifications",
    ) as BoxRenderable;
    expect(box.visible).toBe(true);
    expect(box.border).toEqual(["left", "right"]);
    const bg = box.backgroundColor;
    expect(bg?.toInts().slice(0, 3)).toEqual([20, 20, 20]);
    f.setup.resize(40, 18);
    await f.frame();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(40);
  } finally {
    await f.dispose();
  }
});

test("unsupported clipboard transport is reported without resetting the input parser", async () => {
  const f = await fixture();
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const nativeCopy = f.setup.renderer.copyToClipboardOSC52.bind(
    f.setup.renderer,
  );
  let attempted = false;
  const copy = spyOn(
    f.setup.renderer,
    "copyToClipboardOSC52",
  ).mockImplementation((text) => {
    attempted = true;
    return nativeCopy(text);
  });
  try {
    f.setup.renderer.root.add(
      new TextRenderable(f.setup.renderer, {
        id: "native-copy-phase",
        position: "absolute",
        left: 0,
        top: 2,
        width: 40,
        height: 1,
        content: "Real clipboard selection",
        selectable: true,
      }),
    );
    await f.frame();
    await f.setup.mockMouse.pressDown(0, 2);
    await f.setup.mockMouse.emitMouseEvent("drag", 12, 2);
    await f.setup.mockMouse.release(12, 2);
    await f.frame();
    expect(
      errors.mock.calls
        .map((call) => call.map(String).join(" "))
        .filter((text) => /parser failure|InvalidPhase/.test(text)),
    ).toEqual([]);
    expect(attempted).toBe(true);
    expect(
      f.host.bridge.notifications.some((note) =>
        note.message.startsWith("Clipboard copy failed:"),
      ),
    ).toBe(true);
    expect(f.setup.renderer.getSelection()?.getSelectedText()).toBe(
      "Real clipboar",
    );
  } finally {
    copy.mockRestore();
    errors.mockRestore();
    await f.dispose();
  }
});


test("advisor menu ages refresh while idle without resetting the selected advice", async () => {
  const f = await fixture();
  let now = Date.parse("2026-01-02T00:00:00Z");
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const snapshot = f.host.snapshot();
  const advice: typeof snapshot.advice = [
    { id: "old", advisor: "Advisor", model: "fixture", title: "Older advice", text: "Older explanation", timestamp: new Date(now - 120_000).toISOString(), status: "delivered", entryId: "old", feedback: { rating: "useful", source: "assistant", reason: "Caught a bug", timestamp: new Date(now).toISOString() } },
    { id: "new", advisor: "Advisor", model: "fixture", title: "Newest advice", text: "New explanation", timestamp: new Date(now - 59_000).toISOString(), status: "delivered", entryId: "new" },
  ];
  const snapshotSpy = spyOn(f.host, "snapshot").mockImplementation(() => ({ ...snapshot, advice }));
  try {
    f.app.advisor();
    const initial = await f.frame();
    expect(initial.indexOf("Newest advice")).toBeLessThan(initial.indexOf("Older advice"));
    expect(initial).toContain("59 seconds ago");
    f.setup.mockInput.pressArrow("down");
    const refresh = spyOn(f.app.overlays, "refresh");
    await Bun.sleep(550);
    expect(refresh).not.toHaveBeenCalled();
    now += 1000;
    await Bun.sleep(550);
    const refreshed = await f.frame();
    expect(refreshed).toContain("1 minute ago");
    f.setup.mockInput.pressEnter();
    const detail = await f.frame();
    expect(detail).toContain("Older explanation");
    expect(detail).toContain("Executor feedback: useful · Caught a bug");
    expect(detail).toContain("Mark reviewed locally");
    now += 60_000;
    await Bun.sleep(550);
    expect(await f.frame()).toContain("3 minutes ago");
    f.app.overlays.openText({ title: "Unrelated panel", body: "Unrelated body" });
    refresh.mockClear();
    now += 60_000;
    await Bun.sleep(550);
    expect(refresh).not.toHaveBeenCalled();
    refresh.mockRestore();
  } finally {
    snapshotSpy.mockRestore();
    clock.mockRestore();
    await f.dispose();
  }
});


test("Ctrl+X arrows open the registered fleet inspector and switch agents without changing the draft", async () => {
  let selected = 0;
  let opened = 0;
  const factory: ExtensionFactory = (pi) => {
    pi.registerCommand("subagents-fleet", {
      handler: async (_args, ctx) => {
        opened++;
        await ctx.ui.custom<void>((tui, _theme, _keys, done) => ({
          render: () => [`Fleet selected agent ${selected}`],
          invalidate() {},
          handleInput: (data) => {
            if (matchesKey(data, "down")) selected++;
            else if (matchesKey(data, "up")) selected--;
            else if (matchesKey(data, "escape")) done();
            tui.requestRender();
          },
        }));
      },
    });
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.setWidget("subagent-fleet", [
        "Roster · ↓/← to inspect",
        "Tokens ↑123 ↓456 · ↓24k window · unrelated ← navigation",
        "↑↓/jk select · enter inspect · esc back",
      ]);
      ctx.ui.onTerminalInput((data) => {
        if (matchesKey(data, "down")) return { consume: true };
      });
    });
  };
  const f = await fixture([factory]);
  const send = spyOn(f.host, "send");
  try {
    f.host.bridge.setEditorText("ab");
    await f.frame();
    f.setup.mockInput.pressArrow("left");
    await f.setup.mockInput.typeText("Z");
    expect(f.host.bridge.getEditorText()).toBe("aZb");
    f.setup.mockInput.pressArrow("right");
    await f.setup.mockInput.typeText("X");
    expect(f.host.bridge.getEditorText()).toBe("aZbX");
    f.host.bridge.setEditorText("Preserve this draft");
    const initial = await f.frame();
    expect(initial).not.toContain("↓/← to inspect");
    expect(initial).not.toContain("↑↓/jk select · enter inspect · esc back");
    expect(initial).toContain("ctrl+x ↓ inspect");
    expect(initial).toContain("Tokens ↑123 ↓456 · ↓24k window · unrelated ← navigation");
    f.setup.mockInput.pressArrow("left");
    expect(opened).toBe(0);
    f.setup.mockInput.pressKey("x", { ctrl: true });
    f.setup.mockInput.pressArrow("down");
    expect(await f.frame()).toContain("Fleet selected agent 0");
    expect(opened).toBe(1);
    f.setup.mockInput.pressKey("x", { ctrl: true });
    f.setup.mockInput.pressArrow("right");
    expect(await f.frame()).toContain("Fleet selected agent 1");
    f.setup.mockInput.pressKey("x", { ctrl: true });
    f.setup.mockInput.pressArrow("left");
    expect(await f.frame()).toContain("Fleet selected agent 0");
    f.setup.mockInput.pressEscape();
    await f.frame();
    expect(f.host.bridge.getEditorText()).toBe("Preserve this draft");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("/subagents-fleet");
    f.app.overlays.openText({ title: "Other panel", body: "Retain this panel" });
    f.setup.mockInput.pressKey("x", { ctrl: true });
    f.setup.mockInput.pressArrow("right");
    expect(await f.frame()).toContain("Close the current panel");
    expect(opened).toBe(1);
    f.setup.mockInput.pressEscape();
    f.setup.mockInput.pressKey("x", { ctrl: true });
    f.setup.mockInput.pressArrow("right");
    expect(await f.frame()).toContain("Fleet selected agent 1");
    expect(opened).toBe(2);
    f.setup.mockInput.pressEscape();
    await f.frame();
    await f.app.submit("/subagents-fleet");
    expect(await f.frame()).toContain("Fleet selected agent 1");
    f.setup.mockInput.pressKey("x", { ctrl: true });
    f.setup.mockInput.pressArrow("left");
    expect(await f.frame()).toContain("Fleet selected agent 0");
    expect(opened).toBe(3);
  } finally {
    send.mockRestore();
    await f.dispose();
  }
});

test("fleet shortcut cannot become a model prompt when the extension is missing", async () => {
  const f = await fixture();
  const send = spyOn(f.host, "send");
  try {
    f.setup.mockInput.pressKey("x", { ctrl: true });
    f.setup.mockInput.pressArrow("down");
    expect(await f.frame()).toContain("Subagent inspector is unavailable");
    expect(send).not.toHaveBeenCalled();
  } finally {
    send.mockRestore();
    await f.dispose();
  }
});


const installedFleetModule = join(homedir(), ".pi/agent/local-packages/subagents/src/tui/fleet.js");
test.skipIf(!existsSync(installedFleetModule))(
  "Ctrl+X navigation opens the actual installed fleet and switches markdown child transcripts offline",
  async () => {
    const { createRequire } = await import("node:module");
    const { fileURLToPath } = await import("node:url");
    const { createJiti } = await import("jiti");
    const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const loader = createJiti(import.meta.url, {
      fsCache: false,
      moduleCache: false,
      tryNative: false,
      alias: {
        "@earendil-works/pi-coding-agent": fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
        "@earendil-works/pi-tui": fileURLToPath(import.meta.resolve("@earendil-works/pi-tui")),
        "@earendil-works/pi-ai": fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/compat")),
        "@earendil-works/pi-agent-core": fileURLToPath(import.meta.resolve("@earendil-works/pi-agent-core")),
        typebox: require.resolve("typebox"),
      },
      virtualModules: {
        "@earendil-works/pi-coding-agent": await import("@earendil-works/pi-coding-agent"),
        "@earendil-works/pi-tui": await import("@earendil-works/pi-tui"),
        "@earendil-works/pi-ai": await import("@earendil-works/pi-ai/compat"),
      },
    });
    const { SubagentFleetComponent } = await loader.import<any>(installedFleetModule);
    const asyncJobs = new Map();
    const factory: ExtensionFactory = (pi) => {
      pi.registerCommand("subagents-fleet", {
        handler: async (_args, ctx) => {
          await ctx.ui.custom<void>((tui, theme, _keys, done) =>
            new SubagentFleetComponent(tui, theme, {
              baseCwd: ctx.cwd, asyncJobs, foregroundControls: new Map(),
            }, done, { refreshMs: 60_000 }),
          );
        },
      });
    };
    const f = await fixture([factory]);
    const send = spyOn(f.host, "send");
    try {
      for (let index = 0; index < 2; index++) {
        const asyncDir = join(f.dir, `child-${index}`);
        mkdirSync(asyncDir);
        const transcriptPath = join(asyncDir, "transcript.jsonl");
        writeFileSync(transcriptPath, JSON.stringify({
          recordType: "message", role: "assistant", text: `# Offline child ${index} transcript\n\n**Verified** keyboard navigation.`,
        }) + "\n");
        asyncJobs.set(`child-${index}`, {
          asyncId: `child-${index}`, asyncDir, status: "complete", mode: "single",
          startedAt: 1000 - index, updatedAt: 2000 - index,
          steps: [{ agent: `worker-${index}`, index: 0, status: "complete", transcriptPath }],
        });
      }
      f.host.bridge.setEditorText("Retained offline draft");
      f.setup.mockInput.pressKey("x", { ctrl: true });
      f.setup.mockInput.pressArrow("down");
      expect(await f.frame()).toContain("Offline child 0 transcript");
      f.setup.mockInput.pressArrow("down");
      expect(await f.frame()).toContain("Offline child 1 transcript");
      f.setup.mockInput.pressArrow("up");
      expect(await f.frame()).toContain("Offline child 0 transcript");
      f.setup.mockInput.pressKey("x", { ctrl: true });
      f.setup.mockInput.pressArrow("right");
      expect(await f.frame()).toContain("Offline child 1 transcript");
      if (process.env.PI_OPENTUI_TEST_CAPTURE)
        writeFileSync(process.env.PI_OPENTUI_TEST_CAPTURE, JSON.stringify(f.setup.captureSpans()));
      f.setup.mockInput.pressKey("x", { ctrl: true });
      f.setup.mockInput.pressArrow("left");
      expect(await f.frame()).toContain("Offline child 0 transcript");
      f.setup.mockInput.pressEscape();
      await f.frame();
      expect(f.host.bridge.getEditorText()).toBe("Retained offline draft");
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith("/subagents-fleet");
    } finally {
      send.mockRestore();
      await f.dispose();
    }
  },
);


test("rewritten subagent hints remain readable in a narrow editor without dropping usage arrows", async () => {
  const f = await fixture([(pi) => {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.setWidget("subagent-fleet", ["Roster · ↓/← to inspect", "↓24k window"]);
    });
  }]);
  try {
    f.setup.resize(35, 32);
    const frame = await f.frame();
    expect(frame).toContain("ctrl+x ↓ inspect");
    expect(frame).toContain("ctrl+x ←/→");
    expect(frame).toContain("agents");
    expect(frame).toContain("↓24k window");
    expect(frame).not.toContain("↓/← to inspect");
  } finally {
    await f.dispose();
  }
});
