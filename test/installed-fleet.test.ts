import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import { ExtensionUIBridge } from "../src/host/extension-ui.ts";

const fleetModule = join(homedir(), ".pi/agent/local-packages/subagents/src/tui/fleet.js");

test.skipIf(!existsSync(fleetModule))(
  "actual fleet navigates twice into transcript markdown without an initialized native Pi host",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-fleet-navigation-"));
    const themeKey = Symbol.for("@earendil-works/pi-coding-agent:theme");
    const globals = globalThis as Record<symbol, unknown>;
    const previousTheme = globals[themeKey];
    delete globals[themeKey];
    let bridge: ExtensionUIBridge | undefined;
    let pending: Promise<unknown> | undefined;
    try {
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
      const { SubagentFleetComponent } = await loader.import<any>(fleetModule);
      const asyncJobs = new Map();
      for (let index = 0; index < 3; index++) {
        const asyncDir = join(directory, `run-${index}`);
        mkdirSync(asyncDir);
        const transcriptPath = join(asyncDir, "transcript.jsonl");
        if (index === 2)
          writeFileSync(transcriptPath, JSON.stringify({
            recordType: "message", role: "assistant", text: "# Child result\n\n**Verified** the failure path.",
          }) + "\n");
        asyncJobs.set(`run-${index}`, {
          asyncId: `run-${index}`,
          asyncDir,
          status: "complete",
          mode: "single",
          startedAt: 1000 - index,
          updatedAt: 2000 - index,
          steps: [{
            agent: `worker-${index}`, index: 0, status: "complete",
            ...(index === 2 ? { transcriptPath } : {}),
          }],
        });
      }
      const state = {
        baseCwd: directory,
        asyncJobs,
        foregroundControls: new Map(),
      };
      bridge = new ExtensionUIBridge({ cwd: directory });
      bridge.resize(100, 32);
      pending = bridge.custom((tui, theme, _keys, done) =>
        new SubagentFleetComponent(tui, theme, state, done, { refreshMs: 60_000 }),
      );
      await Bun.sleep(0);
      expect(bridge.renderCustom(100).join("\n")).toContain("worker-0");
      bridge.handleCustomInput("\x1b[B");
      expect(bridge.renderCustom(100).join("\n")).toContain("worker-1");
      bridge.handleCustomInput("\x1b[B");
      const rendered = bridge.renderCustom(100).join("\n");
      expect(rendered).toContain("Child result");
      expect(rendered).toContain("Verified");
      bridge.handleCustomInput("\x1b");
      await pending;
      expect(bridge.pendingDialogCount).toBe(0);
    } finally {
      bridge?.dispose();
      if (pending) await Promise.allSettled([pending]);
      if (previousTheme === undefined) delete globals[themeKey];
      else globals[themeKey] = previousTheme;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
