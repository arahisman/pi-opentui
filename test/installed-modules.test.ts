import { test, expect } from "bun:test";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const realAgentDirectory = join(homedir(), ".pi", "agent");
const settingsPath = join(realAgentDirectory, "settings.json");
const settings = existsSync(settingsPath)
  ? JSON.parse(readFileSync(settingsPath, "utf8"))
  : undefined;
const sources: string[] =
  settings?.packages?.map((entry: string | { source: string }) =>
    typeof entry === "string" ? entry : entry.source,
  ) ?? [];
function installedPath(source: string): string {
  if (source.startsWith("npm:")) {
    const specification = source.slice(4),
      suffix = specification.lastIndexOf("@");
    return join(
      realAgentDirectory,
      "npm",
      "node_modules",
      suffix > 0 ? specification.slice(0, suffix) : specification,
    );
  }
  if (source.startsWith("git:"))
    return join(realAgentDirectory, "git", source.slice(4));
  return resolve(source);
}
const packages = sources.map((source) => ({
  source,
  path: installedPath(source),
}));
const installed =
  packages.length > 0 &&
  packages.every((entry) => existsSync(join(entry.path, "package.json")));

test.skipIf(!installed)(
  "actual installed modules start, show native questionnaire, reload and close in an isolated offline subprocess",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-opentui-installed-"));
    const isolatedHome = join(directory, "home"),
      agentDirectory = join(isolatedHome, ".pi", "agent");
    const cwd = join(directory, "project"),
      indexDirectory = join(directory, "session-index");
    for (const path of [
      agentDirectory,
      cwd,
      join(cwd, ".pi"),
      indexDirectory,
      join(directory, "tmp"),
    ])
      mkdirSync(path, { recursive: true });
    mkdirSync(join(agentDirectory, "local-packages"), { recursive: true });
    for (const entry of packages.filter((entry) =>
      entry.path.startsWith(join(realAgentDirectory, "local-packages")),
    ))
      symlinkSync(
        entry.path,
        join(agentDirectory, "local-packages", basename(entry.path)),
        "dir",
      );
    writeFileSync(
      join(agentDirectory, "settings.json"),
      JSON.stringify({ packages: packages.map((entry) => entry.path) }),
    );
    writeFileSync(
      join(agentDirectory, "WATCHDOG.yml"),
      "main: false\nsubagents: false\n",
    );
    writeFileSync(join(cwd, "WATCHDOG.yml"), "main: false\nsubagents: false\n");
    writeFileSync(
      join(agentDirectory, "mcp.json"),
      JSON.stringify({ mcpServers: {} }),
    );
    writeFileSync(
      join(agentDirectory, "lsp.json"),
      JSON.stringify({ installMode: "off", warmup: false }),
    );
    writeFileSync(
      join(agentDirectory, "sol-pi.json"),
      JSON.stringify({ version: 1, onlineContextCompact: true }),
    );
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ "pi-session-search": { localPath: indexDirectory } }),
    );
    writeFileSync(
      join(indexDirectory, "config.json"),
      JSON.stringify({
        sessionDir: join(agentDirectory, "sessions"),
        archiveDir: join(directory, "archives"),
        primer: { enabled: false },
        sync: { interval: -1, initialDelay: -1 },
      }),
    );
    const manifest = packages.map((entry) => ({
      ...entry,
      name: JSON.parse(readFileSync(join(entry.path, "package.json"), "utf8"))
        .name,
      version: JSON.parse(
        readFileSync(join(entry.path, "package.json"), "utf8"),
      ).version,
    }));
    const manifestPath = join(directory, "installed-paths.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const fixture = fileURLToPath(
      new URL("./fixtures/installed-modules-smoke.ts", import.meta.url),
    );
    try {
      const result = await new Promise<{ stdout: string; stderr: string }>(
        (complete, reject) => {
          execFile(
            process.execPath,
            [fixture, manifestPath],
            {
              cwd,
              timeout: 45000,
              maxBuffer: 2 * 1024 * 1024,
              env: {
                PATH: process.env.PATH ?? "",
                HOME: isolatedHome,
                PI_CODING_AGENT_DIR: agentDirectory,
                TMPDIR: join(directory, "tmp"),
                XDG_CONFIG_HOME: join(isolatedHome, ".config"),
                XDG_CACHE_HOME: join(isolatedHome, ".cache"),
                XDG_DATA_HOME: join(isolatedHome, ".local", "share"),
                TERM: "dumb",
                TERM_PROGRAM: "rex",
                NO_COLOR: "1",
                PI_OPENTUI_HOST: "1",
                PI_ADVISOR_SUBAGENTS: "0",
              },
            },
            (error, stdout, stderr) =>
              error
                ? reject(
                    new Error(
                      `Installed module smoke failed: ${error.message}\n${stdout}\n${stderr}`,
                    ),
                  )
                : complete({ stdout, stderr }),
          );
        },
      );
      const marker = result.stdout
        .split("\n")
        .find((line) => line.startsWith("INSTALLED_MODULES_RESULT "));
      expect(marker).toBeDefined();
      const report = JSON.parse(
        marker!.slice("INSTALLED_MODULES_RESULT ".length),
      );
      expect(report.extensionErrors).toEqual([]);
      expect(report.hostErrors).toEqual([]);
      expect(report.networkAttempts).toEqual([]);
      expect(report.startups).toBe(2);
      expect(report.shutdowns).toBe(2);
      expect(report.questionnaireSelected).toBe("safe");
      expect(report.questionnaireCustom).toBe("typed local answer");
      expect(report.advisorEditorWrapper).toBe(true);
      expect(report.questionnaireCancelled).toBe(true);
      expect(report.questionnaireExplicitCancel).toBe(true);
      expect(report.questionnaireNestedCancelError).toBe(
        "UserCancelledInteractionError",
      );
      expect(report.inputCalls).toBe(2);
      expect(report.submissions).toBe(2);
      expect(report.widgetDisposals).toBe(2);
      expect(report.presentationOwners).toEqual([]);
      expect(report.loadedPackages.length).toBeGreaterThanOrEqual(9);
      expect(result.stderr).not.toMatch(
        /stale|is not a function|Unhandled|Error:/,
      );
      console.info(`Installed modules verified: ${JSON.stringify(report)}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60000,
);
