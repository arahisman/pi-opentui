import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.env.PI_OPENTUI_TEST_NODE ?? Bun.which("node");
if (!node)
  throw new Error("Set PI_OPENTUI_TEST_NODE to a supported Node.js executable");
const npm =
  process.env.PI_OPENTUI_TEST_NPM ??
  resolve(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js");
const output = join(project, ".artifacts/verification");
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), "pi-opentui-package-"));
const environment = {
  HOME: temporary,
  PATH: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  npm_config_cache: join(temporary, "npm-cache"),
  PI_CODING_AGENT_DIR: join(temporary, "agent"),
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
  TERM: "xterm-256color",
  LANG: "en_US.UTF-8",
};
const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  node,
  temporary,
  installCount: 0,
  checks: [],
  freeBytesBefore: statfsSync(temporary).bavail * statfsSync(temporary).bsize,
};
async function run(command: string[], cwd = project) {
  const child = Bun.spawn(command, {
    cwd,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  (evidence.checks as unknown[]).push({ command, exitCode, stdout, stderr });
  writeFileSync(
    join(output, "package-install.json"),
    JSON.stringify(evidence, null, 2),
  );
  if (exitCode !== 0)
    throw new Error(`${command[0]} failed (${exitCode}): ${stderr}\n${stdout}`);
  return stdout;
}
try {
  const nodeVersion = (await run([node, "--version"])).trim(),
    parts = nodeVersion.replace(/^v/, "").split(".").map(Number);
  if (
    !Number.isFinite(parts[0]) ||
    parts[0]! < 26 ||
    (parts[0] === 26 && (parts[1] ?? 0) < 4)
  )
    throw new Error(
      `Package verification requires Node.js >=26.4.0; selected ${nodeVersion}`,
    );
  const metadata = JSON.parse(
    await run([node, npm, "pack", "--json", "--pack-destination", output]),
  );
  evidence.pack = metadata[0];
  const archive = join(output, metadata[0].filename);
  evidence.archiveSha256 = createHash("sha256")
    .update(readFileSync(archive))
    .digest("hex");
  const prefix = join(temporary, "install");
  mkdirSync(prefix);
  writeFileSync(
    join(prefix, "package.json"),
    JSON.stringify({
      name: "pi-opentui-install-fixture",
      version: "1.0.0",
      private: true,
      allowScripts: { bun: true, protobufjs: false, "@google/genai": false },
    }),
  );
  evidence.installCount = 1;
  await run(
    [node, npm, "install", "--omit=dev", "--no-audit", "--no-fund", archive],
    prefix,
  );
  const packagePath = join(prefix, "node_modules", metadata[0].name),
    require = createRequire(join(packagePath, "package.json"));
  const help = await run(
    [join(prefix, "node_modules/.bin/pi-opentui"), "--help"],
    temporary,
  );
  if (!help.includes("OpenTUI frontend for Pi"))
    throw new Error("Installed bin did not produce expected help");
  const agent = join(temporary, "agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify({ packages: [packagePath] }),
  );
  const sdk = Bun.resolveSync("@earendil-works/pi-coding-agent", packagePath),
    bun = require.resolve("bun/bin/bun.exe");
  evidence.runtimeVersions = {
    pi: JSON.parse(readFileSync(join(dirname(sdk), "../package.json"), "utf8"))
      .version,
    bun: (await run([bun, "--version"], temporary)).trim(),
  };
  const discovery = join(temporary, "discovery.mjs");
  writeFileSync(
    discovery,
    `import {DefaultResourceLoader,SettingsManager} from ${JSON.stringify(sdk)};\nconst settings=SettingsManager.create(${JSON.stringify(temporary)},${JSON.stringify(agent)},{projectTrusted:true});\nconst loader=new DefaultResourceLoader({cwd:${JSON.stringify(temporary)},agentDir:${JSON.stringify(agent)},settingsManager:settings,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true});\nawait loader.reload();const result=loader.getExtensions();const commands=result.extensions.flatMap(extension=>[...extension.commands.keys()]);console.log(JSON.stringify({commands,errors:result.errors,extensions:result.extensions.map(extension=>extension.resolvedPath)}));if(result.errors.length || !commands.includes("opentui"))process.exitCode=1;\n`,
  );
  evidence.discovery = JSON.parse(
    (await run([bun, discovery], temporary)).trim(),
  );
  const terminal = await run(
    [
      "python3",
      join(project, "test/fixtures/terminal-harness.py"),
      JSON.stringify({ project: packagePath, node, mode: "standalone" }),
    ],
    temporary,
  );
  const terminalResult = JSON.parse(terminal.trim());
  evidence.installedTerminal = terminalResult;
  if (
    terminalResult.events.some(
      (event: { type: string }) => event.type === "model-request",
    )
  )
    throw new Error("Installed standalone fixture attempted a model turn");
  if (
    terminalResult.exitCode !== 0 ||
    !terminalResult.terminalRestored ||
    !terminalResult.alternateExited
  )
    throw new Error("Installed package failed actual PTY launch/resize/exit");
  const nativeResult = JSON.parse(
    (
      await run(
        [
          "python3",
          join(project, "test/fixtures/terminal-harness.py"),
          JSON.stringify({
            project: packagePath,
            node,
            mode: "native",
            sdkCli: join(dirname(sdk), "bundle/cli.js"),
          }),
        ],
        temporary,
      )
    ).trim(),
  );
  evidence.installedNativeTerminal = nativeResult;
  if (
    nativeResult.events.some(
      (event: { type: string }) => event.type === "model-request",
    )
  )
    throw new Error("Installed native fixture attempted a model turn");
  if (
    nativeResult.exitCode !== 0 ||
    !nativeResult.terminalRestored ||
    nativeResult.childAliveOnReturn !== false
  )
    throw new Error("Installed package failed native Pi handoff/return");
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  evidence.cleaned = true;
  evidence.finishedAt = new Date().toISOString();
  evidence.freeBytesAfter =
    statfsSync(tmpdir()).bavail * statfsSync(tmpdir()).bsize;
  writeFileSync(
    join(output, "package-install.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: evidence.passed,
      cleaned: true,
      evidence: join(output, "package-install.json"),
    }),
  );
}
