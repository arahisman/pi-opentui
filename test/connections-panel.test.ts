import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestRenderer } from "@opentui/core/testing";
import type { KeyEvent } from "@opentui/core";
import { PiHost } from "../src/host/controller.ts";
import { OverlayManager } from "../src/ui/overlays.ts";
import { ConnectionsPanel } from "../src/ui/connections-panel.ts";
async function fixture(modules = true) {
  const directory = mkdtempSync(join(tmpdir(), "pi-connections-ui-")),
    calls: string[] = [];
  let state = "failed: fixture server is offline",
    modelTurns = 0;
  const host = await PiHost.create({
    cwd: directory,
    agentDir: join(directory, "agent"),
    clean: true,
    extensionFactories: modules
      ? [
          (pi) => {
            pi.registerCommand("mcp", {
              getArgumentCompletions: (prefix) =>
                prefix === "reconnect "
                  ? [
                      {
                        label: "docs",
                        value: "reconnect docs",
                        description: state,
                      },
                    ]
                  : [],
              handler: async (args) => {
                calls.push(`mcp ${args}`);
                if (args === "reconnect docs") state = "connected · 0 tools";
              },
            });
            pi.registerCommand("lsp", {
              handler: async (args) => {
                calls.push(`lsp ${args}`);
              },
            });
            pi.on("session_start", (_event, ctx) => {
              ctx.ui.setStatus("lsp", "LSP: 1/3 servers");
            });
            pi.on("before_agent_start", () => {
              modelTurns++;
            });
          },
        ]
      : [],
  });
  const renderer = await createTestRenderer({
      width: 100,
      height: 28,
      kittyKeyboard: true,
    }),
    overlays = new OverlayManager(renderer.renderer),
    panel = new ConnectionsPanel(host, overlays);
  const handle = (key: KeyEvent) => overlays.handleKey(key);
  renderer.renderer.keyInput.on("keypress", handle);
  const frame = async () => {
    await Bun.sleep(10);
    await renderer.renderOnce();
    return renderer.captureCharFrame();
  };
  return {
    directory,
    host,
    calls,
    panel,
    overlays,
    renderer,
    frame,
    modelTurns: () => modelTurns,
    cleanup: async () => {
      renderer.renderer.keyInput.off("keypress", handle);
      overlays.dispose();
      await renderer.dispose();
      await host.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("actual connection panel shows live state and retry refresh through native command without model turns", async () => {
  const f = await fixture();
  try {
    await f.panel.open();
    let frame = await f.frame();
    expect(frame).toContain("MCP · docs");
    expect(frame).toContain("failed: fixture server");
    expect(frame).toContain("LSP: 1/3 servers");
    f.overlays.handlePaste("docs");
    f.renderer.mockInput.pressEnter();
    expect(await f.frame()).toContain("State: error");
    f.renderer.mockInput.pressTab();
    f.renderer.mockInput.pressEnter();
    await f.frame();
    expect(f.calls).toEqual(["mcp reconnect docs"]);
    expect(await f.frame()).toContain("connected · 0 tools");
    expect(f.modelTurns()).toBe(0);
  } finally {
    await f.cleanup();
  }
});
test("LSP detail exposes actual aggregate evidence, native diagnostics and safe optional-module state", async () => {
  const f = await fixture();
  try {
    await f.panel.open();
    f.overlays.handlePaste("Language");
    f.renderer.mockInput.pressEnter();
    expect(await f.frame()).toContain("not per-server health");
    f.renderer.mockInput.pressTab();
    f.renderer.mockInput.pressEnter();
    await f.frame();
    expect(f.calls).toEqual(["lsp doctor"]);
    expect(f.modelTurns()).toBe(0);
  } finally {
    await f.cleanup();
  }
  const clean = await fixture(false);
  try {
    await clean.panel.open();
    const frame = await clean.frame();
    expect(frame).toContain("no servers reported");
    expect(frame).toContain("unknown");
    expect(frame).not.toContain("connected ·");
    clean.renderer.resize(20, 8);
    await clean.frame();
    expect(clean.overlays.isOpen).toBe(true);
  } finally {
    await clean.cleanup();
  }
});
test("connection log pane redacts credential fields and retains keyboard back action", async () => {
  const f = await fixture();
  try {
    writeFileSync(
      join(f.directory, "agent/mcp.log"),
      "Authorization: Bearer PRIVATE\nnetwork unavailable\n",
    );
    await f.panel.open();
    f.overlays.handlePaste("docs");
    f.renderer.mockInput.pressEnter();
    f.renderer.mockInput.pressTab();
    f.renderer.mockInput.pressTab();
    f.renderer.mockInput.pressEnter();
    const frame = await f.frame();
    expect(frame).toContain("network unavailable");
    expect(frame).not.toContain("PRIVATE");
    expect(frame).toContain("[redacted]");
    f.renderer.mockInput.pressEnter();
    expect(await f.frame()).toContain("Connections");
  } finally {
    await f.cleanup();
  }
});
