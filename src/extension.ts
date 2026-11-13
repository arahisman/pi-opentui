import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("opentui", {
    description: "Open the OpenTUI interface for this Pi session",
    handler: async (_args, ctx) => {
      if (process.env.PI_OPENTUI_HOST === "1") {
        ctx.ui.notify("Already using pi-opentui", "info");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Run pi-opentui from an interactive terminal", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Finish or stop the active run before opening OpenTUI",
          "warning",
        );
        return;
      }
      const source = ctx.sessionManager.getSessionFile();
      if (!source) {
        ctx.ui.notify(
          "The current session must be saved before transferring it",
          "warning",
        );
        return;
      }
      const cwd = ctx.cwd,
        temporary = mkdtempSync(join(tmpdir(), "pi-opentui-handoff-")),
        receipt = join(temporary, "return.json");
      let target = source;
      try {
        await ctx.newSession({
          withSession: async (replacement) => {
            const code = await replacement.ui.custom<number>(
              (tui, _theme, _keys, done) => {
                queueMicrotask(() => {
                  tui.stop();
                  const child = spawn(
                    process.execPath,
                    [
                      fileURLToPath(
                        new URL("../bin/pi-opentui.mjs", import.meta.url),
                      ),
                      "--cwd",
                      cwd,
                      "--session",
                      source,
                      "--return-file",
                      receipt,
                    ],
                    { stdio: "inherit", env: process.env },
                  );
                  let finished = false;
                  const finish = (status: number) => {
                    if (finished) return;
                    finished = true;
                    tui.start();
                    done(status);
                  };
                  child.once("error", () => finish(1));
                  child.once("exit", (status) => finish(status ?? 1));
                });
                return { render: () => [], invalidate() {} };
              },
            );
            try {
              const result = JSON.parse(readFileSync(receipt, "utf8"));
              if (typeof result.sessionFile === "string")
                target = result.sessionFile;
            } catch (error) {
              if (code === 0)
                replacement.ui.notify(
                  `Could not read OpenTUI return receipt: ${error instanceof Error ? error.message : String(error)}`,
                  "warning",
                );
            }
            await replacement.switchSession(target, {
              withSession: async (restored) => {
                if (code !== 0)
                  restored.ui.notify(
                    `OpenTUI exited with status ${code}; saved session restored`,
                    "error",
                  );
              },
            });
          },
        });
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
  });
}
