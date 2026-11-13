import { describe, expect, test } from "bun:test";
import { Editor, Text, visibleWidth } from "@earendil-works/pi-tui";
import {
  ExtensionUIBridge,
  UserCancelledInteractionError,
} from "../src/host/extension-ui.ts";

describe("ExtensionUIBridge", () => {
  test("queues dialogs and settles cancellation, abort and timeout", async () => {
    const bridge = new ExtensionUIBridge();
    const select = bridge.select("Choose", ["one", "two"]);
    const confirm = bridge.confirm("Confirm", "Proceed?");
    expect(bridge.pendingDialogCount).toBe(2);
    expect(() => bridge.resolveDialog("bad")).toThrow("offered option");
    bridge.resolveDialog("two");
    expect(await select).toBe("two");
    expect(bridge.activeDialog?.kind).toBe("confirm");
    bridge.cancelDialog();
    expect(await confirm).toBe(false);
    const abort = new AbortController();
    const input = bridge.input("Value", "", { signal: abort.signal });
    abort.abort();
    expect(await input).toBeUndefined();
    expect(
      await bridge.select("Timeout", ["one"], { timeout: 1 }),
    ).toBeUndefined();
    bridge.dispose();
  });
  test("custom factories execute actual Pi components with raw input, theme and disposal", async () => {
    const bridge = new ExtensionUIBridge();
    let disposed = 0;
    const pending = bridge.custom<string>((tui, theme, keybindings, done) => {
      expect(keybindings.getKeys("tui.input.submit").length).toBeGreaterThan(0);
      const editor = new Editor(tui, {
        borderColor: (text) => theme.fg("accent", text),
        selectList: {
          selectedPrefix: String,
          selectedText: String,
          description: String,
          scrollInfo: String,
          noMatch: String,
        },
      });
      editor.onSubmit = done;
      return Object.assign(editor, {
        dispose: () => {
          disposed++;
        },
      });
    });
    await Promise.resolve();
    bridge.handleCustomInput("hello");
    expect(bridge.renderCustom(24).some((line) => line.includes("hello"))).toBe(
      true,
    );
    bridge.handleCustomInput("\r");
    expect(await pending).toBe("hello");
    expect(disposed).toBe(1);
    bridge.dispose();
  });
  test("editor factory wrapping preserves draft, raw input, paste and autocomplete", async () => {
    const bridge = new ExtensionUIBridge();
    bridge.setEditorText("draft");
    const original = bridge.editorComponent;
    let renders = 0;
    bridge.setEditorComponent(() => ({
      render: (width) => {
        renders++;
        return ["advisor", ...original.render(width)];
      },
      invalidate: () => original.invalidate(),
      handleInput: (raw) => original.handleInput(raw),
      getText: () => original.getText(),
      getExpandedText: () => original.getExpandedText?.() ?? original.getText(),
      setText: (text) => original.setText(text),
      setAutocompleteProvider: (provider) =>
        original.setAutocompleteProvider?.(provider),
    }));
    bridge.handleEditorInput("!");
    expect(bridge.getEditorText()).toBe("draft!");
    bridge.pasteToEditor("\nnew line");
    expect(bridge.getEditorText()).toBe("draft!\nnew line");
    expect(bridge.renderEditor(18)[0]).toBe("advisor");
    expect(renders).toBe(1);
    let previous;
    bridge.addAutocompleteProvider((provider) => {
      previous = provider;
      return provider;
    });
    expect(previous).toBeDefined();
    bridge.setEditorComponent(undefined);
    expect(bridge.getEditorText()).toBe("draft!\nnew line");
    bridge.dispose();
  });
  test("widget/header/footer factories render and dispose, input listeners transform and consume", () => {
    const bridge = new ExtensionUIBridge();
    let disposed = 0;
    bridge.setWidget(
      "live",
      (_tui, theme) =>
        Object.assign(new Text(theme.fg("accent", "widget"), 0, 0), {
          dispose: () => disposed++,
        }),
      { placement: "belowEditor" },
    );
    bridge.setHeader(() => new Text("header", 0, 0));
    bridge.setFooter((_tui, _theme, data) => ({
      render: () => [...data.getExtensionStatuses().values()],
      invalidate() {},
    }));
    bridge.setStatus("health", "ok");
    expect(bridge.renderWidgets(15, "belowEditor")[0]).toContain("widget");
    expect(bridge.renderHeader(15).map((line) => line.trimEnd())).toEqual([
      "header",
    ]);
    expect(bridge.renderFooter(15)).toEqual(["ok"]);
    bridge.onTerminalInput((data) => ({ data: data.toUpperCase() }));
    const remove = bridge.onTerminalInput((data) =>
      data === "STOP" ? { consume: true } : undefined,
    );
    expect(bridge.processTerminalInput("go")).toBe("GO");
    expect(bridge.processTerminalInput("stop")).toBeUndefined();
    remove();
    expect(bridge.processTerminalInput("stop")).toBe("STOP");
    bridge.setWidget("live", undefined);
    expect(disposed).toBe(1);
    bridge.dispose();
  });
  test("dispose settles queued dialogs without instantiating queued factories", async () => {
    const bridge = new ExtensionUIBridge();
    const confirm = bridge.confirm("first", "waiting");
    let called = false;
    const custom = bridge.custom(() => {
      called = true;
      return new Text("never", 0, 0);
    });
    bridge.dispose();
    expect(await confirm).toBe(false);
    expect(await custom).toBeUndefined();
    expect(called).toBe(false);
    expect(bridge.pendingDialogCount).toBe(0);
    expect(() => bridge.input("disposed")).toThrow("disposed");
  });
  test("sync done and rejected async factories cleanly settle", async () => {
    const bridge = new ExtensionUIBridge();
    let disposed = false;
    expect(
      await bridge.custom((_tui, _theme, _keys, done) => {
        done("early");
        return {
          render: () => [],
          invalidate() {},
          dispose: () => {
            disposed = true;
          },
        };
      }),
    ).toBe("early");
    await Promise.resolve();
    expect(disposed).toBe(true);
    await expect(
      bridge.custom(async () => {
        throw new Error("factory failed");
      }),
    ).rejects.toThrow("factory failed");
    expect(bridge.pendingDialogCount).toBe(0);
    bridge.dispose();
  });
  test("native editor stays bounded on resize and themes/tools expose real state", () => {
    const bridge = new ExtensionUIBridge();
    bridge.setEditorText(
      "A long draft with unicode 界 and emoji 🌍 over several rows",
    );
    for (const width of [80, 22, 8]) {
      bridge.resize(width, 12);
      expect(
        bridge.renderEditor(width).every((line) => visibleWidth(line) <= width),
      ).toBe(true);
    }
    expect(bridge.setTheme("theme-that-does-not-exist").success).toBe(false);
    expect(bridge.setTheme("light").success).toBe(true);
    bridge.setToolsExpanded(true);
    expect(bridge.getToolsExpanded()).toBe(true);
    bridge.setTitle("session");
    expect(bridge.title).toBe("session");
    bridge.dispose();
  });
});

import { ansiToStyledText } from "../src/ui/ansi.ts";
import { TextAttributes } from "@opentui/core";
import { palette } from "../src/theme.ts";

describe("ANSI native rendering", () => {
  test("preserves actual Pi theme colors and SGR attributes without terminal commands", () => {
    const bridge = new ExtensionUIBridge();
    const content = bridge.theme.bold(
      bridge.theme.italic(
        bridge.theme.underline(bridge.theme.fg("accent", "native")),
      ),
    );
    const styled = ansiToStyledText(content);
    expect(styled.chunks.map((chunk) => chunk.text).join("")).toBe("native");
    expect(styled.chunks[0]?.fg?.toInts().slice(0, 3)).toEqual([250, 178, 131]);
    expect(styled.chunks[0]!.attributes! & TextAttributes.BOLD).toBeTruthy();
    expect(styled.chunks[0]!.attributes! & TextAttributes.ITALIC).toBeTruthy();
    expect(
      styled.chunks[0]!.attributes! & TextAttributes.UNDERLINE,
    ).toBeTruthy();
    const background = ansiToStyledText(bridge.theme.bg("userMessageBg", "bg"));
    expect(background.chunks[0]?.bg?.toInts().slice(0, 3)).toEqual([
      20, 20, 20,
    ]);
    expect(bridge.theme.name).toBe("opencode");
    const captured = bridge.theme;
    expect(bridge.setTheme("light").success).toBe(true);
    expect(captured.name).toBe("light");
    bridge.setTheme("opencode");
    expect(palette.primary).toBe("#fab283");
    bridge.dispose();
  });
  test("handles indexed colors, resets, dim and strips OSC/DCS/control/cursor markers", () => {
    const styled = ansiToStyledText(
      "\x1b[2;38;5;42;48;2;10;20;30mcolor\x1b[22;39;49mplain\x1b]52;c;secret\x07\x1bPimage\x1b\\\x1b[2J\x1b_apc\x07\x00\x9b31mred",
    );
    expect(styled.chunks.map((chunk) => chunk.text).join("")).toBe(
      "colorplainred",
    );
    expect(styled.chunks[0]?.attributes! & TextAttributes.DIM).toBeTruthy();
    expect(styled.chunks[0]?.bg?.toInts().slice(0, 3)).toEqual([10, 20, 30]);
    expect(styled.chunks[1]?.fg).toBeUndefined();
    expect(styled.chunks[1]?.bg).toBeUndefined();
    expect(styled.chunks[1]?.attributes).toBe(0);
    expect(
      ansiToStyledText(["one", "two"])
        .chunks.map((chunk) => chunk.text)
        .join(""),
    ).toBe("one\ntwo");
  });
  test("overlay handles hide, show and dispose the component with blocked status", async () => {
    const bridge = new ExtensionUIBridge();
    let handle:
      | Parameters<
          NonNullable<
            NonNullable<Parameters<ExtensionUIBridge["custom"]>[1]>["onHandle"]
          >
        >[0]
      | undefined;
    let overlayWidth = 20;
    const pending = bridge.custom(() => new Text("overlay", 0, 0), {
      overlay: true,
      overlayOptions: () => ({ width: overlayWidth }),
      onHandle: (value) => {
        handle = value;
      },
      blocked: { kind: "question", message: "answer" },
    });
    await Promise.resolve();
    expect(bridge.native.terminal.programStatus?.state).toBe("blocked");
    expect(bridge.renderCustom(80).join("")).toContain("overlay");
    expect(handle!.getBounds()?.width).toBe(20);
    overlayWidth = 30;
    bridge.renderCustom(80);
    expect(handle!.getBounds()?.width).toBe(30);
    handle!.setHidden(true);
    expect(bridge.renderCustom(80)).toEqual([]);
    handle!.setHidden(false);
    expect(bridge.renderCustom(80).join("")).toContain("overlay");
    bridge.cancelDialog();
    await expect(pending).rejects.toBeInstanceOf(UserCancelledInteractionError);
    expect(bridge.native.hasOverlay()).toBe(false);
    expect(bridge.native.terminal.programStatus?.state).toBe("clear");
    bridge.dispose();
  });
});

describe("reload UI reset", () => {
  test("preserves bridge subscriptions and draft while disposing extension UI and listeners", async () => {
    const bridge = new ExtensionUIBridge();
    const native = bridge.native,
      theme = bridge.theme,
      keys = bridge.keybindings;
    let changes = 0,
      disposed = 0,
      inputCalls = 0,
      nativeInputCalls = 0,
      queuedFactoryCalls = 0;
    bridge.onChange(() => changes++);
    bridge.setEditorText("unsent draft");
    bridge.setWidget("old", () => ({
      render: () => ["old widget"],
      invalidate() {},
      dispose: () => {
        disposed++;
      },
    }));
    bridge.setHeader(() => ({
      render: () => [],
      invalidate() {},
      dispose: () => {
        disposed++;
      },
    }));
    bridge.setFooter(() => ({
      render: () => [],
      invalidate() {},
      dispose: () => {
        disposed++;
      },
    }));
    bridge.setStatus("old", "status");
    bridge.setWorkingVisible(false);
    bridge.setToolsExpanded(true);
    bridge.onTerminalInput(() => {
      inputCalls++;
    });
    bridge.native.addInputListener(() => {
      nativeInputCalls++;
    });
    const first = bridge.custom(
      () => ({
        render: () => ["active"],
        invalidate() {},
        dispose: () => {
          disposed++;
        },
      }),
      { overlay: true },
    );
    await Promise.resolve();
    const second = bridge.custom(() => {
      queuedFactoryCalls++;
      return new Text("queued", 0, 0);
    });
    const third = bridge.confirm("queued confirm", "pending");
    bridge.resetSessionUI();
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
    expect(await third).toBe(false);
    expect(disposed).toBe(4);
    expect(queuedFactoryCalls).toBe(0);
    expect(bridge.native).toBe(native);
    expect(bridge.theme).toBe(theme);
    expect(bridge.keybindings).toBe(keys);
    expect(bridge.getEditorText()).toBe("unsent draft");
    expect(bridge.statuses.size).toBe(0);
    expect(bridge.widgets.size).toBe(0);
    expect(bridge.workingVisible).toBe(true);
    expect(bridge.toolsExpanded).toBe(false);
    expect(bridge.native.hasOverlayEntries).toBe(false);
    bridge.processTerminalInput("x");
    bridge.handleEditorInput("!");
    expect(inputCalls).toBe(0);
    expect(nativeInputCalls).toBe(0);
    expect(bridge.getEditorText()).toBe("unsent draft!");
    const before = changes;
    bridge.setStatus("new", "status");
    expect(changes).toBeGreaterThan(before);
    bridge.dispose();
  });
  test("restores base editor before reapplying editor and autocomplete wrappers", () => {
    const bridge = new ExtensionUIBridge();
    const install = () => {
      const base = bridge.getEditorComponent();
      bridge.setEditorComponent((tui, theme, keys) => {
        const editor = base?.(tui, theme, keys) ?? new Editor(tui, theme);
        const render = editor.render.bind(editor);
        editor.render = (width) => ["wrapper", ...render(width)];
        return editor;
      });
    };
    install();
    bridge.setEditorText("draft");
    expect(
      bridge.renderEditor(40).filter((line) => line === "wrapper").length,
    ).toBe(1);
    bridge.resetSessionUI();
    expect(bridge.getEditorComponent()).toBeUndefined();
    install();
    expect(
      bridge.renderEditor(40).filter((line) => line === "wrapper").length,
    ).toBe(1);
    expect(bridge.getEditorText()).toBe("draft");
    bridge.dispose();
  });
});

describe("SDK UI context wrapping", () => {
  test("complete extension UI survives real SDK session_start and reload wrapping", async () => {
    const { PiHost, hostEditorFactory } =
      await import("../src/host/controller.ts");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const directory = mkdtempSync(join(tmpdir(), "pi-opentui-ui-sdk-"));
    let starts = 0,
      inputs = 0,
      disposals = 0;
    let host: InstanceType<typeof PiHost> | undefined;
    const answers: (string | undefined)[] = [];
    try {
      host = await PiHost.create({
        cwd: directory,
        agentDir: join(directory, "agent"),
        clean: true,
        deferBind: true,
        extensionFactories: [
          (pi) => {
            pi.on("session_start", async (_event, ctx) => {
              starts++;
              expect(typeof ctx.ui.onTerminalInput).toBe("function");
              expect(ctx.ui.theme.name).toBe("opencode");
              expect(ctx.ui.getEditorComponent()).toBe(hostEditorFactory);
              ctx.ui.onTerminalInput(() => {
                inputs++;
              });
              ctx.ui.setWidget("sdk-widget", () => ({
                render: () => ["sdk widget"],
                invalidate() {},
                dispose: () => {
                  disposals++;
                },
              }));
              ctx.ui.setStatus("sdk-status", "ready");
              ctx.ui.notify("native SDK notification");
              ctx.ui.setEditorText("SDK draft");
              expect(ctx.ui.getEditorText()).toBe("SDK draft");
              answers.push(
                await ctx.ui.select("SDK startup question", ["continue"]),
              );
            });
          },
        ],
      });
      host.on("change", () => {
        if (host?.bridge.activeDialog?.kind === "select")
          host.bridge.resolveDialog("continue");
      });
      await host.attach();
      expect(host.diagnostics).toEqual([]);
      expect(host.bridge.widgets.size).toBe(1);
      expect(host.bridge.statuses.get("sdk-status")).toBe("ready");
      expect(host.bridge.notifications.at(-1)?.message).toBe(
        "native SDK notification",
      );
      host.bridge.processTerminalInput("x");
      expect(inputs).toBe(1);
      const wrapped = host.session.extensionRunner.createContext().ui;
      for (const name of [
        "notify",
        "onTerminalInput",
        "setStatus",
        "setWorkingMessage",
        "setWorkingVisible",
        "setWorkingIndicator",
        "setHiddenThinkingLabel",
        "setWidget",
        "setFooter",
        "setHeader",
        "setTitle",
        "pasteToEditor",
        "setEditorText",
        "getEditorText",
        "addAutocompleteProvider",
        "setEditorComponent",
        "getEditorComponent",
        "getAllThemes",
        "getTheme",
        "setTheme",
        "getToolsExpanded",
        "setToolsExpanded",
      ] as const)
        expect(typeof wrapped[name]).toBe("function");
      expect(wrapped.theme).toBe(host.bridge.theme);
      expect(wrapped.setTheme("light").success).toBe(true);
      expect(wrapped.theme.name).toBe("light");
      wrapped.setTheme("opencode");
      await host.reload();
      host.bridge.processTerminalInput("y");
      expect(starts).toBe(2);
      expect(inputs).toBe(2);
      expect(disposals).toBe(1);
      expect(answers).toEqual(["continue", "continue"]);
      expect(host.bridge.widgets.size).toBe(1);
      expect(host.diagnostics).toEqual([]);
    } finally {
      await host?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("explicit custom interaction cancellation", () => {
  test("offers one Escape and preserves the component-defined cancellation result", async () => {
    const bridge = new ExtensionUIBridge();
    let escapes = 0,
      disposals = 0;
    const result = bridge.custom<{ cancelled: boolean }>(
      (_tui, _theme, _keys, done) => ({
        render: () => ["question"],
        invalidate() {},
        handleInput: (raw) => {
          if (raw === "\x1b") {
            escapes++;
            done({ cancelled: true });
          }
        },
        dispose: () => {
          disposals++;
        },
      }),
    );
    await Promise.resolve();
    bridge.cancelDialog();
    expect(await result).toEqual({ cancelled: true });
    expect(escapes).toBe(1);
    expect(disposals).toBe(1);
    bridge.dispose();
  });
  test("rejects with named cancellation when one Escape only navigates back", async () => {
    const bridge = new ExtensionUIBridge();
    let escapes = 0,
      disposals = 0;
    const result = bridge.custom<string>(() => ({
      render: () => ["nested"],
      invalidate() {},
      handleInput: (raw) => {
        if (raw === "\x1b") {
          escapes++;
          bridge.cancelDialog();
        }
      },
      dispose: () => {
        disposals++;
      },
    }));
    const next = bridge.confirm("next", "queued");
    await Promise.resolve();
    bridge.cancelDialog();
    await expect(result).rejects.toMatchObject({
      name: "UserCancelledInteractionError",
      message: "User cancelled the extension interaction",
    });
    expect(escapes).toBe(1);
    expect(disposals).toBe(1);
    expect(bridge.activeDialog?.kind).toBe("confirm");
    bridge.cancelDialog();
    expect(await next).toBe(false);
    bridge.dispose();
  });
});

describe("native editor caret", () => {
  test("preserves verified Pi fake cursor styling and strips arbitrary APC payloads", async () => {
    const { renderFakeCursor, CURSOR_MARKER } =
      await import("@earendil-works/pi-tui");
    const styled = ansiToStyledText(
      `before${CURSOR_MARKER}${renderFakeCursor("界")}after\x1b_unknown payload\x07\x1b_pi:fc;not-a-cursor\x07`,
    );
    expect(styled.chunks.map((chunk) => chunk.text).join("")).toBe(
      "before界after",
    );
    expect(
      styled.chunks
        .filter((chunk) => (chunk.attributes ?? 0) & TextAttributes.INVERSE)
        .map((chunk) => chunk.text),
    ).toEqual(["界"]);
    const existingInverse = ansiToStyledText(
      `\x1b[7m${renderFakeCursor("x")}after\x1b[27m`,
    );
    expect(
      existingInverse.chunks.every(
        (chunk) => (chunk.attributes ?? 0) & TextAttributes.INVERSE,
      ),
    ).toBe(true);
    const truncated = ansiToStyledText(["\x1b_pi:fc\x07x", "next row"]);
    expect(
      truncated.chunks
        .filter((chunk) => (chunk.attributes ?? 0) & TextAttributes.INVERSE)
        .map((chunk) => chunk.text),
    ).toEqual(["x"]);
  });
  test("real Pi editor caret moves and remains visible in actual OpenTUI cells after resize", async () => {
    const { createTestRenderer } = await import("@opentui/core/testing");
    const { TextRenderable } = await import("@opentui/core");
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const bridge = new ExtensionUIBridge();
    const editor = new TextRenderable(setup.renderer, {
      content: "",
      width: "100%",
      wrapMode: "none",
    });
    setup.renderer.root.add(editor);
    try {
      bridge.setEditorText("abc");
      bridge.handleEditorInput("\x1b[D");
      editor.content = ansiToStyledText(bridge.renderEditor(40));
      await setup.renderOnce();
      expect(
        setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .filter((span) => span.attributes & TextAttributes.INVERSE)
          .map((span) => span.text)
          .join(""),
      ).toBe("c");
      bridge.handleEditorInput("\x1b[D");
      setup.resize(12, 8);
      bridge.resize(12, 8);
      editor.content = ansiToStyledText(bridge.renderEditor(12));
      await setup.renderOnce();
      expect(
        setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .filter((span) => span.attributes & TextAttributes.INVERSE)
          .map((span) => span.text)
          .join(""),
      ).toBe("b");
      expect(bridge.getEditorText()).toBe("abc");
    } finally {
      bridge.dispose();
      await setup.dispose();
    }
  });
});

describe("host editor project and preference binding", () => {
  test("file completions use the selected project before and after reload and cross-project session switches", async () => {
    const { PiHost } = await import("../src/host/controller.ts");
    const { mkdtempSync, mkdirSync, rmSync, writeFileSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { randomUUID } = await import("node:crypto");
    const directory = mkdtempSync(join(tmpdir(), "pi-host-cwd-"));
    const first = join(directory, "first"),
      second = join(directory, "second"),
      agent = join(directory, "agent");
    for (const path of [first, second, join(agent, "pi-opentui")])
      mkdirSync(path, { recursive: true });
    writeFileSync(join(first, "cwd-first.txt"), "first project");
    writeFileSync(join(second, "cwd-second.txt"), "second project");
    writeFileSync(
      join(agent, "pi-opentui", "preferences.json"),
      JSON.stringify({ toolsExpanded: true }),
    );
    const session = join(second, "session.jsonl");
    writeFileSync(
      session,
      JSON.stringify({
        type: "session",
        version: 3,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        cwd: second,
      }) + "\n",
    );
    const startupDefaults: boolean[] = [];
    let host: InstanceType<typeof PiHost> | undefined;
    try {
      host = await PiHost.create({
        cwd: first,
        agentDir: agent,
        clean: true,
        extensionFactories: [
          (pi) => {
            pi.on("session_start", (_event, ctx) => {
              startupDefaults.push(ctx.ui.getToolsExpanded());
              ctx.ui.setToolsExpanded(false);
            });
          },
        ],
      });
      const complete = async () => {
        let base:
          | import("@earendil-works/pi-tui").AutocompleteProvider
          | undefined;
        host!.bridge.addAutocompleteProvider((current) => {
          base = current;
          return current;
        });
        const prefix = "./cwd-";
        return (
          await base!.getSuggestions([prefix], 0, prefix.length, {
            force: true,
            signal: new AbortController().signal,
          })
        )?.items.map((item) => item.label);
      };
      expect(await complete()).toEqual(["cwd-first.txt"]);
      expect(host.bridge.getToolsExpanded()).toBe(false);
      await host.reload();
      expect(await complete()).toEqual(["cwd-first.txt"]);
      expect(host.bridge.getToolsExpanded()).toBe(false);
      await host.switchSession(session);
      expect(host.runtime.cwd).toBe(second);
      expect(await complete()).toEqual(["cwd-second.txt"]);
      expect(startupDefaults).toEqual([true, true, true]);
      expect(host.bridge.getToolsExpanded()).toBe(false);
    } finally {
      await host?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
