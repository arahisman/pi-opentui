import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.env.PI_OPENTUI_TEST_NODE ?? Bun.which("node");
if (!node)
  throw new Error(
    "PTY tests require Node.js; set PI_OPENTUI_TEST_NODE to its executable",
  );
const selectedVersion = Bun.spawnSync([node, "--version"], {
  stdout: "pipe",
  stderr: "pipe",
});
const version = new TextDecoder().decode(selectedVersion.stdout).trim(),
  parts = version.replace(/^v/, "").split(".").map(Number);
if (
  selectedVersion.exitCode !== 0 ||
  !Number.isFinite(parts[0]) ||
  parts[0]! < 26 ||
  (parts[0] === 26 && (parts[1] ?? 0) < 4)
)
  throw new Error(
    `Native Pi PTY tests require Node.js >=26.4.0; selected ${node} is ${version}. Set PI_OPENTUI_TEST_NODE or put a supported Node.js first in PATH.`,
  );
interface RecordEvent {
  type: string;
  pid: number;
  host: boolean;
  session: string | null;
  reason?: string;
}
interface Result {
  mode: string;
  error?: string;
  exitCode: number;
  terminalRestored: boolean;
  alternateEntered: boolean;
  alternateExited: boolean;
  events: RecordEvent[];
  outputTail: string;
  originalSession: string;
  returnedSession: string | null;
  childAliveOnReturn: boolean | null;
}
async function run(mode: string): Promise<Result> {
  const child = Bun.spawn(
    [
      "python3",
      join(project, "test/fixtures/terminal-harness.py"),
      JSON.stringify({ project, node, mode }),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const result = JSON.parse(stdout.trim()) as Result;
  const directory = join(project, ".artifacts/verification");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `terminal-${mode}.json`),
    JSON.stringify({ ...result, harnessStatus: status, stderr }, null, 2),
  );
  if (status !== 0) throw new Error(result.error ?? stderr);
  if (result.events.some((row) => row.type === "model-request"))
    throw new Error("PTY fixture attempted a model turn");
  return result;
}
test("actual PTY OpenTUI launches, resizes tiny/wide, exits and restores terminal", async () => {
  const result = await run("standalone");
  expect(result.exitCode).toBe(0);
  expect(result.terminalRestored).toBe(true);
  expect(result.alternateEntered).toBe(true);
  expect(result.alternateExited).toBe(true);
}, 60000);
test("actual PTY startup failure leaves terminal usable", async () => {
  const result = await run("startup-failure");
  expect(result.exitCode).not.toBe(0);
  expect(result.terminalRestored).toBe(true);
}, 30000);
for (const mode of ["native", "native-failure", "native-new"])
  test(`actual native Pi /opentui handoff and return (${mode})`, async () => {
    const result = await run(mode);
    expect(result.exitCode).toBe(0);
    expect(result.terminalRestored).toBe(true);
    const child = result.events.findIndex(
        (row) => row.type === "start" && row.host,
      ),
      placeholder = result.events
        .slice(0, child)
        .reverse()
        .find((row) => row.type === "start" && !row.host);
    expect(child).toBeGreaterThan(0);
    expect(placeholder?.session).not.toBe(result.originalSession);
    expect(result.events[child]!.session).toBe(result.originalSession);
    expect(
      result.events
        .slice(child + 1)
        .some(
          (row) =>
            row.type === "start" &&
            !row.host &&
            row.session === result.returnedSession,
        ),
    ).toBe(true);
    expect(result.childAliveOnReturn).toBe(false);
    expect(
      result.events
        .slice(0, child)
        .some(
          (row) =>
            row.type === "stop" &&
            !row.host &&
            row.session === result.originalSession,
        ),
    ).toBe(true);
    if (mode === "native-new")
      expect(result.returnedSession).not.toBe(result.originalSession);
  }, 80000);

test("launcher SIGTERM gracefully closes its Bun child and restores terminal", async () => {
  const result = await run("standalone-signal");
  expect(result.exitCode).toBe(0);
  expect(result.terminalRestored).toBe(true);
  expect(result.alternateExited).toBe(true);
}, 60000);
