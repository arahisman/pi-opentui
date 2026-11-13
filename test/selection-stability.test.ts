import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { PiHost } from "../src/host/controller.ts";
import { Application } from "../src/ui/application.ts";

test("sidebar selection survives live refreshes, copies on release and remains highlighted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-selection-stability-"));
  const host = await PiHost.create({
    cwd: directory,
    agentDir: join(directory, "agent"),
    clean: true,
  });
  const setup = await createTestRenderer({ width: 140, height: 42 });
  const app = new Application(setup.renderer, host, () => {});
  const copy = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(
    true,
  );
  const refresh = async () => {
    host.emit("change");
    await Bun.sleep(25);
    await setup.renderOnce();
  };
  try {
    await refresh();
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Usage & context"));
    expect(y).toBeGreaterThanOrEqual(0);
    const x = lines[y]!.indexOf("Usage & context");
    await setup.mockMouse.pressDown(x, y);
    await setup.mockMouse.emitMouseEvent("drag", x + 3, y);
    expect(setup.renderer.getSelection()?.getSelectedText()).toBe("Usag");
    expect(copy).not.toHaveBeenCalled();
    host.emit("event", {
      type: "message_update",
      message: {
        role: "assistant",
        timestamp: Date.now(),
        content: [{ type: "text", text: "Streaming update" }],
      },
    });
    host.bridge.setEditorText("Native editor changed during selection");
    await refresh();
    expect(setup.renderer.getSelection()?.isDragging).toBe(true);
    expect(setup.renderer.getSelection()?.getSelectedText()).toBe("Usag");
    expect(copy).not.toHaveBeenCalled();
    await setup.mockMouse.emitMouseEvent("drag", x + 14, y);
    await setup.mockMouse.release(x + 14, y);
    await Bun.sleep(5);
    expect(setup.renderer.getSelection()?.isDragging).toBe(false);
    expect(setup.renderer.getSelection()?.getSelectedText()).toBe(
      "Usage & context",
    );
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledWith("Usage & context");
    await refresh();
    await refresh();
    expect(setup.renderer.getSelection()?.getSelectedText()).toBe(
      "Usage & context",
    );
    expect(copy).toHaveBeenCalledTimes(1);
  } finally {
    copy.mockRestore();
    app.dispose();
    await host.close();
    await setup.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("selecting a tool body preserves its expansion state through refresh and mouse release", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-tool-selection-"));
  const host = await PiHost.create({
    cwd: directory,
    agentDir: join(directory, "agent"),
    clean: true,
  });
  host.session.sessionManager.appendMessage({
    role: "bashExecution",
    command: "printf fixture",
    output:
      "Tool body selection remains stable\nLine two\nLine three\nLine four\nEXPANDED_ONLY_END",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: Date.now(),
  });
  const setup = await createTestRenderer({ width: 140, height: 42 });
  const app = new Application(setup.renderer, host, () => {});
  const copy = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(
    true,
  );
  const refresh = async () => {
    host.emit("change");
    await Bun.sleep(25);
    await setup.renderOnce();
  };
  const selectBody = async (expanded: string[]) => {
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Tool body selection"));
    expect(y).toBeGreaterThanOrEqual(0);
    const x = lines[y]!.indexOf("Tool body selection");
    await setup.mockMouse.pressDown(x, y);
    await setup.mockMouse.emitMouseEvent("drag", x + 3, y);
    expect(app.shell.captureNavigation().expandedToolRows).toEqual(expanded);
    expect(copy).not.toHaveBeenCalled();
    await refresh();
    expect(setup.renderer.getSelection()?.isDragging).toBe(true);
    await setup.mockMouse.emitMouseEvent("drag", x + 18, y);
    expect(copy).not.toHaveBeenCalled();
    await setup.mockMouse.release(x + 18, y);
    await Bun.sleep(5);
    expect(app.shell.captureNavigation().expandedToolRows).toEqual(expanded);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledWith("Tool body selection");
    await refresh();
    expect(setup.renderer.getSelection()?.getSelectedText()).toBe(
      "Tool body selection",
    );
    expect(app.shell.captureNavigation().expandedToolRows).toEqual(expanded);
  };
  try {
    await refresh();
    expect(app.shell.captureNavigation().expandedToolRows).toEqual([]);
    expect(setup.captureCharFrame()).not.toContain("EXPANDED_ONLY_END");
    await selectBody([]);
    const header = setup.captureCharFrame().split("\n");
    const y = header.findIndex((line) => line.includes("✓ bash"));
    expect(y).toBeGreaterThanOrEqual(0);
    await setup.mockMouse.click(header[y]!.indexOf("✓ bash"), y);
    await setup.renderOnce();
    const expanded = app.shell.captureNavigation().expandedToolRows;
    expect(expanded).toHaveLength(1);
    expect(setup.captureCharFrame()).toContain("EXPANDED_ONLY_END");
    copy.mockClear();
    await selectBody(expanded);
  } finally {
    copy.mockRestore();
    app.dispose();
    await host.close();
    await setup.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
