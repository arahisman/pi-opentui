import { parseArgs } from "node:util";
import { resolve, dirname } from "node:path";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { createCliRenderer } from "@opentui/core";
import { PiHost } from "./host/controller.ts";
import { Application } from "./ui/application.ts";
import { palette } from "./theme.ts";

const { values } = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    cwd: { type: "string" },
    "agent-dir": { type: "string" },
    session: { type: "string" },
    continue: { type: "boolean", short: "c" },
    clean: { type: "boolean" },
    "return-file": { type: "string" },
  },
  strict: true,
});
if (values.help) {
  console.log(
    `pi-opentui — OpenTUI frontend for Pi\n\nUsage: pi-opentui [--cwd PATH] [--session FILE | --continue] [--clean]\n\n  --cwd PATH        Project directory (default current directory)\n  --agent-dir PATH  Pi configuration directory (default ~/.pi/agent)\n  --session FILE    Resume a saved Pi session\n  --continue, -c    Continue the latest session for this project\n  --clean           Native Pi without optional installed extensions\n\nUses existing Pi models/auth/config. Ctrl+P commands, Shift+Enter newline,\nCtrl+X M models, Ctrl+X L sessions, Ctrl+X N new, Ctrl+X B sidebar.\n`,
  );
  process.exit(0);
}
if (values.session && values.continue)
  throw new Error("Choose --session or --continue");
if (!process.stdin.isTTY || !process.stdout.isTTY)
  throw new Error(
    "pi-opentui needs an interactive terminal. Use Pi print/JSON/RPC for noninteractive tasks.",
  );
if (values["agent-dir"])
  process.env.PI_CODING_AGENT_DIR = resolve(values["agent-dir"]);
process.env.PI_OPENTUI_HOST = "1";
const cwd = resolve(values.cwd ?? process.cwd());
const host = await PiHost.create({
  cwd,
  agentDir: values["agent-dir"],
  sessionFile: values.session ? resolve(values.session) : undefined,
  continueRecent: values.continue,
  clean: values.clean,
  deferBind: true,
});
const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: true,
  screenMode: "alternate-screen",
  backgroundColor: palette.background,
  targetFps: 30,
  maxFps: 60,
  openConsoleOnError: false,
  consoleMode: "disabled",
});
let app: Application;
let closing = false;
const cleanup = async () => {
  if (closing) return;
  closing = true;
  try {
    if (values["return-file"]) {
      const file = resolve(values["return-file"]);
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(
        temporary,
        JSON.stringify({
          sessionFile: host.session.sessionFile,
          cwd: host.runtime.cwd,
        }),
        { mode: 0o600 },
      );
      renameSync(temporary, file);
    }
  } finally {
    renderer.destroy();
  }
};
app = new Application(renderer, host, cleanup);
void host.attach().catch((error) => app.showError(error));
let signalClosing = false;
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const)
  process.on(signal, () => {
    if (signalClosing) return;
    signalClosing = true;
    void host
      .abort()
      .then(() => app.exit())
      .catch(async (error) => {
        process.stderr.write(`${error.message}\n`);
        app.dispose();
        await host.close();
        await cleanup();
      });
  });
process.once("uncaughtException", (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  app.dispose();
  void host.close().finally(cleanup);
  process.exitCode = 1;
});
