import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createTestRenderer } from "@opentui/core/testing";
import { ProjectionCache } from "../src/core/projection-cache.ts";
import { PiHost } from "../src/host/controller.ts";
import { Application } from "../src/ui/application.ts";

test("entry renderer visibility flows through initial, appended and invalidated projections", () => {
  const manager = SessionManager.inMemory();
  const registered = new Set(["visible"]);
  const cache = new ProjectionCache({
    hasEntryRenderer: (type) => registered.has(type),
  });
  const first = manager.appendCustomEntry("visible", { count: 1 });
  manager.appendCustomEntry("private", { secret: true });
  cache.sync(manager, undefined, 0);
  expect(cache.transcript.map((row) => row.entryId)).toEqual([first]);
  const second = manager.appendCustomEntry("visible", { count: 2 });
  cache.sync(manager, undefined, 0);
  expect(cache.transcript.map((row) => row.entryId)).toEqual([first, second]);
  registered.clear();
  cache.invalidate();
  cache.sync(manager, undefined, 0);
  expect(cache.transcript).toEqual([]);
});

test("registered native blocks render lazily with details, expansion, fallback and bounded caching", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-custom-rendering-"));
  let constructions = 0;
  let failedCalls = 0;
  let host: PiHost | undefined;
  try {
    host = await PiHost.create({
      cwd: directory,
      agentDir: join(directory, "agent"),
      clean: true,
      extensionFactories: [(pi) => {
        pi.registerMessageRenderer("notice", (message, options, theme) => {
          constructions++;
          expect(typeof options.keyText).toBe("function");
          expect(typeof options.keyHint).toBe("function");
          expect(options.outputPad).toBe(1);
          expect(typeof theme.fg).toBe("function");
          return {
            invalidate() {},
            render: (width) => [
              `${String(message.details)} ${options.expanded ? "expanded" : "collapsed"} ${width}`,
            ],
          };
        });
        pi.registerMessageRenderer("fallback", () => undefined);
        pi.registerEntryRenderer("widget", (entry, options) => ({
          invalidate() {},
          render: () => [`widget ${String(entry.data)} ${options.expanded}`],
        }));
        pi.registerEntryRenderer("hidden", () => undefined);
        pi.registerEntryRenderer("broken", () => {
          failedCalls++;
          throw new Error("broken fixture");
        });
        pi.registerEntryRenderer("broken-render", () => ({
          invalidate() {},
          render() { throw new Error("render fixture"); },
        }));
      }],
    });
    const manager = host.session.sessionManager;
    for (let index = 0; index < 130; index++)
      manager.appendCustomMessageEntry("notice", "plain", true, index);
    manager.appendCustomMessageEntry("fallback", "plain fallback", true);
    manager.appendCustomMessageEntry("notice", "secret", false);
    manager.appendCustomEntry("widget", "progress");
    manager.appendCustomEntry("hidden", "secret state");
    manager.appendCustomEntry("broken");
    manager.appendCustomEntry("broken-render");
    manager.appendCustomEntry("private", "private state");
    const rows = host.transcript;
    expect(constructions).toBe(0);
    expect(rows.some((row) => row.text === "secret")).toBe(false);
    expect(rows.some((row) => row.customType === "private")).toBe(false);
    const first = rows[0]!;
    expect(host.renderCustomBlock(first, false, 40)).toEqual(["0 collapsed 40"]);
    expect(host.renderCustomBlock(first, false, 20)).toEqual(["0 collapsed 20"]);
    expect(constructions).toBe(1);
    expect(host.renderCustomBlock(first, true, 20)).toEqual(["0 expanded 20"]);
    expect(constructions).toBe(2);
    for (const row of rows.slice(1, 130)) host.renderCustomBlock(row, false, 20);
    expect(host.renderCustomBlock(first, false, 20)).toEqual(["0 collapsed 20"]);
    expect(constructions).toBe(132);
    const find = (type: string) => rows.find((row) => row.customType === type)!;
    expect(host.renderCustomBlock(find("fallback"), false, 40)).toBeUndefined();
    expect(host.renderCustomBlock(find("widget"), true, 40)).toEqual(["widget progress true"]);
    expect(host.renderCustomBlock(find("hidden"), false, 40)).toEqual([]);
    const beforeErrors = host.diagnostics.length;
    expect(host.renderCustomBlock(find("broken"), false, 40)?.[0]).toContain("broken fixture");
    expect(host.renderCustomBlock(find("broken"), false, 40)?.[0]).toContain("renderer failed");
    expect(failedCalls).toBe(1);
    expect(host.diagnostics.length).toBe(beforeErrors + 1);
    expect(host.renderCustomBlock(find("broken-render"), false, 40)?.[0]).toContain("render fixture");
    expect(host.renderCustomBlock(find("broken-render"), false, 40)?.[0]).toContain("render fixture");
    expect(host.diagnostics.length).toBe(beforeErrors + 2);
    host.invalidateProjection();
    host.renderCustomBlock(first, false, 40);
    expect(constructions).toBe(133);
    expect(host.bridge.setTheme("light").success).toBe(true);
    host.renderCustomBlock(first, false, 40);
    host.renderCustomBlock(first, false, 20);
    expect(constructions).toBe(134);
  } finally {
    await host?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);

test("application renders native custom blocks at measured widths and refreshes them after resize", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-native-block-resize-"));
  const widths: number[] = [];
  const host = await PiHost.create({
    cwd: directory,
    agentDir: join(directory, "agent"),
    clean: true,
    extensionFactories: [(pi) => {
      pi.registerMessageRenderer("responsive", () => ({
        invalidate() {},
        render(width) {
          widths.push(width);
          return [`Native block width ${width}`];
        },
      }));
    }],
  });
  host.session.sessionManager.appendCustomMessageEntry("responsive", "fallback", true);
  const setup = await createTestRenderer({ width: 140, height: 42 });
  const app = new Application(setup.renderer, host, () => {});
  const refreshLayout = async () => {
    await setup.renderOnce();
    host.emit("change");
    await Bun.sleep(25);
    await setup.renderOnce();
  };
  try {
    await refreshLayout();
    expect(widths.length).toBeGreaterThan(0);
    expect(widths.every((width) => width > 1)).toBe(true);
    const initial = app.shell.transcript.viewport.width - 5;
    expect(widths.at(-1)).toBe(initial);
    setup.resize(80, 32);
    await refreshLayout();
    const resized = app.shell.transcript.viewport.width - 5;
    expect(resized).not.toBe(initial);
    expect(widths.at(-1)).toBe(resized);
    expect(setup.captureCharFrame()).toContain(`Native block width ${resized}`);
    const calls = widths.length;
    await refreshLayout();
    expect(widths).toHaveLength(calls);
  } finally {
    app.dispose();
    await host.close();
    await setup.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
