import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { PiHost } from "../src/host/controller.ts";
import { Application } from "../src/ui/application.ts";

test("real native overlays preserve geometry, visibility, focus and pending SDK interactions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-native-overlay-"));
  const host = await PiHost.create({
    cwd: dir,
    agentDir: join(dir, "agent"),
    clean: true,
  });
  const setup = await createTestRenderer({
    width: 100,
    height: 32,
    kittyKeyboard: true,
  });
  const app = new Application(setup.renderer, host, () => {});
  const frame = async () => {
    await Bun.sleep(30);
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  let handle!: OverlayHandle;
  let done!: (value: string) => void;
  let settled = false,
    disposed = 0;
  const received: string[] = [];
  let inputHooks = 0;
  const unsubscribe = host.bridge.onTerminalInput(() => {
    inputHooks++;
  });
  const pending = host.bridge.custom<string>(
    (_tui, theme, _keys, finish) => {
      done = finish;
      return {
        render: () => [theme.fg("accent", "Native surface")],
        invalidate() {},
        handleInput: (raw) => received.push(raw),
        dispose: () => disposed++,
      };
    },
    {
      overlay: true,
      overlayOptions: {
        width: 24,
        row: 3,
        col: 7,
        nonCapturing: true,
        visible: (width) => width >= 80,
      },
      onHandle: (value) => (handle = value),
    },
  );
  void pending.then(() => (settled = true));
  try {
    let view = await frame();
    expect(view.split("\n")[3]!.indexOf("Native surface")).toBe(7);
    expect(view).not.toContain("ctrl+c close");
    expect(app.overlays.isOpen).toBe(false);
    expect(host.bridge.dialogCapturesInput).toBe(false);
    await setup.mockInput.typeText("a");
    expect(host.bridge.getEditorText()).toBe("a");
    expect(received).toEqual([]);
    expect(inputHooks).toBe(1);
    setup.resize(60, 24);
    expect(await frame()).not.toContain("Native surface");
    expect(app.overlays.isOpen).toBe(false);
    setup.resize(100, 32);
    expect(await frame()).toContain("Native surface");
    handle.focus();
    await frame();
    expect(app.overlays.isOpen).toBe(true);
    expect(host.bridge.dialogCapturesInput).toBe(true);
    await setup.mockInput.typeText("b");
    expect(received).toEqual(["b"]);
    expect(inputHooks).toBe(2);
    setup.resize(60, 24);
    await frame();
    await setup.mockInput.typeText("v");
    expect(host.bridge.getEditorText()).toBe("av");
    expect(received).toEqual(["b"]);
    setup.resize(100, 32);
    await frame();
    handle.focus();
    await frame();
    handle.setHidden(true);
    view = await frame();
    expect(view).not.toContain("Native surface");
    expect(view).not.toContain("Extension");
    expect(app.overlays.isOpen).toBe(false);
    expect(host.bridge.dialogCapturesInput).toBe(false);
    expect(settled).toBe(false);
    await setup.mockInput.typeText("c");
    expect(host.bridge.getEditorText()).toBe("avc");
    handle.setHidden(false);
    expect(await frame()).toContain("Native surface");
    expect(app.overlays.isOpen).toBe(false);
    expect(host.bridge.dialogCapturesInput).toBe(false);
    handle.focus();
    await frame();
    handle.unfocus();
    await frame();
    expect(app.overlays.isOpen).toBe(false);
    expect(host.bridge.dialogCapturesInput).toBe(false);
    await setup.mockInput.typeText("d");
    expect(host.bridge.getEditorText()).toBe("avcd");
    app.overlays.openText({ title: "Independent menu", body: "Keep open" });
    done("complete");
    expect(await pending).toBe("complete");
    expect(await frame()).toContain("Independent menu");
    expect(disposed).toBe(1);
    app.overlays.close();
    const capturing = host.bridge.custom<string>(
      (_t, _th, _k, finish) => {
        done = finish;
        return {
          render: () => ["Capturing surface"],
          invalidate() {},
          handleInput: (raw) => received.push(raw),
        };
      },
      { overlay: true, onHandle: (value) => (handle = value) },
    );
    await frame();
    expect(app.overlays.isOpen).toBe(true);
    expect(host.bridge.dialogCapturesInput).toBe(true);
    handle.setHidden(true);
    await frame();
    await setup.mockInput.typeText("e");
    expect(host.bridge.getEditorText()).toBe("avcde");
    handle.setHidden(false);
    await frame();
    expect(app.overlays.isOpen).toBe(true);
    expect(host.bridge.dialogCapturesInput).toBe(true);
    handle.hide();
    await frame();
    expect(app.overlays.isOpen).toBe(false);
    expect(host.bridge.dialogCapturesInput).toBe(false);
    done("removed");
    expect(await capturing).toBe("removed");
    await frame();
    const question = host.bridge.confirm("Queued first", "Continue?");
    const next = host.bridge.custom<string>(
      (_t, _th, _k, finish) => {
        done = finish;
        return { render: () => ["Queued surface"], invalidate() {} };
      },
      { overlay: true },
    );
    expect(await frame()).toContain("Queued first");
    setup.mockInput.pressEnter();
    expect(await question).toBe(true);
    view = await frame();
    expect(view).toContain("Queued surface");
    expect(view).not.toContain("Queued first");
    expect(view).not.toContain("ctrl+c close");
    done("queue complete");
    expect(await next).toBe("queue complete");
  } finally {
    unsubscribe();
    app.dispose();
    await host.close();
    await setup.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
