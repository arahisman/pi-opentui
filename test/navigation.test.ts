import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { CodeRenderable, type BaseRenderable } from "@opentui/core";
import { PiHost } from "../src/host/controller.ts";
import { Application } from "../src/ui/application.ts";
import {
  captureCursorOffset,
  restoreCursorOffset,
} from "../src/core/editor-state.ts";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-navigation-"));
  const host = await PiHost.create({
    cwd: directory,
    agentDir: join(directory, "agent"),
    clean: true,
  });
  const setup = await createTestRenderer({
    width: 125,
    height: 34,
    kittyKeyboard: true,
  });
  const app = new Application(setup.renderer, host, () => {});
  const frame = async () => {
    await Bun.sleep(25);
    await setup.renderOnce();
    const highlights: Promise<void>[] = [];
    const collect = (node: BaseRenderable) => {
      if (node instanceof CodeRenderable) highlights.push(node.highlightingDone);
      for (const child of node.getChildren()) collect(child);
    };
    collect(app.shell.root);
    await Promise.all(highlights);
    await setup.renderOnce();
  };
  const fill = async (prefix: string, count = 450) => {
    const ids: string[] = [];
    for (let index = 0; index < count; index++)
      ids.push(
        host.session.sessionManager.appendMessage({
          role: "user",
          content: `${prefix} historical entry ${index}\nsecond line ${index}`,
          timestamp: Date.now() + index,
        }),
      );
    host.session.refreshContext();
    host.emit("change");
    await frame();
    return ids;
  };
  return {
    host,
    setup,
    app,
    frame,
    fill,
    cleanup: async () => {
      app.dispose();
      await host.close();
      await setup.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("actual session switches restore distinct historical anchors and Unicode draft carets within a bounded card window", async () => {
  const f = await fixture();
  try {
    const firstIds = await f.fill("FIRST");
    const first = f.host.session.sessionFile!;
    f.host.bridge.setEditorText("first draft\nПривет 👋 world");
    expect(restoreCursorOffset(f.host.bridge.editorComponent, 15)).toBe(true);
    expect(f.app.shell.revealEntry(firstIds[70]!)).toBe(true);
    await f.frame();
    const firstState = f.app.shell.captureNavigation();
    expect(firstState.followLatest).toBe(false);
    await f.host.newSession();
    const secondIds = await f.fill("SECOND");
    const second = f.host.session.sessionFile!;
    f.host.bridge.setEditorText("second draft\n漢字");
    expect(restoreCursorOffset(f.host.bridge.editorComponent, 3)).toBe(true);
    expect(f.app.shell.revealEntry(secondIds[220]!)).toBe(true);
    await f.frame();
    const secondState = f.app.shell.captureNavigation();
    await f.host.switchSession(first);
    await f.frame();
    expect(f.host.bridge.getEditorText()).toBe("first draft\nПривет 👋 world");
    expect(captureCursorOffset(f.host.bridge.editorComponent)).toBe(15);
    expect(f.app.shell.captureNavigation().anchorRowId).toBe(
      firstState.anchorRowId,
    );
    expect(f.setup.captureCharFrame()).toContain("FIRST historical entry 70");
    expect(f.app.shell.transcript.getChildren().length).toBeLessThanOrEqual(
      200,
    );
    await f.host.switchSession(second);
    await f.frame();
    expect(f.host.bridge.getEditorText()).toBe("second draft\n漢字");
    expect(captureCursorOffset(f.host.bridge.editorComponent)).toBe(3);
    expect(f.app.shell.captureNavigation().anchorRowId).toBe(
      secondState.anchorRowId,
    );
    expect(f.setup.captureCharFrame()).toContain("SECOND historical entry 220");
    expect(f.app.shell.transcript.getChildren().length).toBeLessThanOrEqual(
      200,
    );
  } finally {
    await f.cleanup();
  }
});

test("same-session tree navigation clears an obsolete historical window before displaying the new branch tail", async () => {
  const f = await fixture();
  try {
    const ids = await f.fill("BRANCH");
    expect(f.app.shell.revealEntry(ids[30]!)).toBe(true);
    await f.frame();
    expect(f.app.shell.captureNavigation().followLatest).toBe(false);
    const result = await f.host.session.navigateTree(ids[400]!, {
      summarize: false,
    });
    expect(result.cancelled).toBe(false);
    f.host.emit("change");
    await f.frame();
    expect(f.app.shell.captureNavigation().followLatest).toBe(true);
    for (
      let attempt = 0;
      attempt < 100 &&
      !f.setup.captureCharFrame().includes("BRANCH historical entry 399");
      attempt++
    ) {
      await Bun.sleep(10);
      await f.setup.renderOnce();
    }
    expect(f.setup.captureCharFrame()).toContain("BRANCH historical entry 399");
    expect(f.app.shell.transcript.getChildren().length).toBeLessThanOrEqual(
      200,
    );
  } finally {
    await f.cleanup();
  }
});

test("reload preserves both saved draft text and its native caret position", async () => {
  const f = await fixture();
  try {
    await f.fill("RELOAD", 5);
    f.host.bridge.setEditorText("persist this\nПривет 👋 world");
    expect(restoreCursorOffset(f.host.bridge.editorComponent, 4)).toBe(true);
    await f.frame();
    await f.host.reload();
    await f.frame();
    expect(f.host.bridge.getEditorText()).toBe("persist this\nПривет 👋 world");
    expect(captureCursorOffset(f.host.bridge.editorComponent)).toBe(4);
  } finally {
    await f.cleanup();
  }
});

test("a pending historical-layout restoration cannot override a newer jump to latest", async () => {
  const f = await fixture();
  try {
    const ids = await f.fill("LAYOUT");
    expect(f.app.shell.revealEntry(ids[55]!)).toBe(true);
    await f.frame();
    const historical = f.app.shell.captureNavigation();
    f.app.shell.jumpLatest();
    await f.frame();
    f.app.shell.restoreNavigation(historical);
    f.app.shell.jumpLatest();
    await f.frame();
    expect(f.app.shell.captureNavigation().followLatest).toBe(true);
    expect(f.setup.captureCharFrame()).toContain("LAYOUT historical entry 449");
  } finally {
    await f.cleanup();
  }
});
