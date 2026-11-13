import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { PiHost } from "../host/controller.ts";

const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const {
  loadMcpConfig,
}: typeof import("../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js") =
  await import(new URL("./extensions/mcp/config.js", sdkEntry).href);
export type ConnectionState =
  | "configured"
  | "connected"
  | "connecting"
  | "disconnected"
  | "disabled"
  | "needs-auth"
  | "error"
  | "unknown";
export interface ConnectionRecord {
  id: string;
  kind: "mcp" | "lsp";
  name: string;
  state: ConnectionState;
  summary: string;
  source: string;
  retryName?: string;
  active?: number;
  total?: number;
}
export interface ConnectionSnapshot {
  mcp: ConnectionRecord[];
  lsp: ConnectionRecord;
  mcpAvailable: boolean;
  lspAvailable: boolean;
  providers: { id: string; name: string; configured: boolean }[];
  diagnostics: string[];
  mcpLogPath: string;
  redact: (text: string) => string;
}
export interface ConnectionsHost {
  runtime: Pick<PiHost["runtime"], "cwd" | "services">;
  session: Pick<
    PiHost["session"],
    "extensionRunner" | "resourceLoader" | "modelRuntime" | "isIdle"
  >;
  bridge: Pick<PiHost["bridge"], "statuses" | "notifications">;
  diagnostics: readonly string[];
  send(text: string): Promise<void>;
}
export function redactConnectionText(
  value: string,
  secrets: readonly string[] = [],
): string {
  let result = stripVTControlCharacters(value).replace(
    /[\x00-\x08\x0b-\x1f\x7f]/g,
    "",
  );
  for (const secret of secrets)
    if (secret.length >= 3) result = result.split(secret).join("[redacted]");
  return result
    .replace(
      /(["']?(?:authorization|proxy-authorization)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|(?:Bearer\s+|Basic\s+)?[^\s,;]+)/gi,
      "$1[redacted]",
    )
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}]+)/gi,
      "$1[redacted]",
    )
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "[redacted]");
}
function observation(description: string): ConnectionState {
  if (/^connected(?:\s|$)/.test(description)) return "connected";
  if (/^connecting/.test(description) || description === "starting")
    return "connecting";
  if (/^failed(?:[:\s]|$)/.test(description)) return "error";
  if (description === "needs sign-in") return "needs-auth";
  if (description === "disabled") return "disabled";
  if (description === "disconnected" || description === "closed")
    return "disconnected";
  return "unknown";
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native connection status timed out")),
          1000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function readConnections(
  host: ConnectionsHost,
): Promise<ConnectionSnapshot> {
  const result = host.session.resourceLoader.getExtensions(),
    commands = host.session.extensionRunner;
  const mcpCommand = commands.getCommand("mcp"),
    lspCommand = commands.getCommand("lsp");
  const diagnostics: string[] = [],
    redactions: string[] = [],
    records = new Map<string, ConnectionRecord>();
  const collect = (config: Record<string, unknown>) => {
    for (const values of [config.env, config.headers])
      if (values && typeof values === "object")
        for (const value of Object.values(values))
          if (typeof value === "string" && value.length >= 3)
            redactions.push(value);
  };
  const config = loadMcpConfig({
    agentDir: host.runtime.services.agentDir,
    cwd: host.runtime.cwd,
    projectTrusted: host.runtime.services.settingsManager.isProjectTrusted(),
  });
  for (const entry of config.servers) {
    collect(entry.config as unknown as Record<string, unknown>);
    records.set(entry.name, {
      id: `mcp:${entry.name}`,
      kind: "mcp",
      name: entry.name,
      state: entry.config.enabled === false ? "disabled" : "configured",
      summary:
        entry.config.enabled === false
          ? "Disabled in configuration"
          : "Configured; live state not reported",
      source: entry.override ?? entry.source,
    });
  }
  for (const entry of result.runtime.mcpServers.list()) {
    collect(entry.config as unknown as Record<string, unknown>);
    if (!records.has(entry.name))
      records.set(entry.name, {
        id: `mcp:${entry.name}`,
        kind: "mcp",
        name: entry.name,
        state: entry.config.enabled === false ? "disabled" : "configured",
        summary:
          entry.config.enabled === false
            ? "Disabled by extension"
            : "Registered by extension; live state not reported",
        source: entry.extensionPath,
      });
  }
  diagnostics.push(
    ...config.errors,
    ...result.errors.map((error) => `${error.path}: ${error.error}`),
    ...host.diagnostics,
  );
  if (mcpCommand?.getArgumentCompletions) {
    for (const prefix of ["reconnect ", "login "]) {
      try {
        const items = await bounded(
          Promise.resolve(mcpCommand.getArgumentCompletions(prefix)),
        );
        for (const item of items ?? []) {
          const name = item.label,
            description = stripVTControlCharacters(item.description ?? ""),
            previous = records.get(name),
            state = observation(description);
          if (previous?.state === "disabled") continue;
          records.set(name, {
            id: `mcp:${name}`,
            kind: "mcp",
            name,
            state,
            summary: description || "Native manager did not report a status",
            source: previous?.source ?? "Native /mcp manager",
            ...(prefix === "reconnect " &&
            item.value === `reconnect ${name}` &&
            !/\s/.test(name)
              ? { retryName: name }
              : {}),
            ...(previous?.retryName ? { retryName: previous.retryName } : {}),
          });
        }
      } catch (error) {
        diagnostics.push(
          `MCP live status unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  const lspText = stripVTControlCharacters(
      host.bridge.statuses.get("lsp") ?? "",
    ),
    match = /^LSP: (\d+)\/(\d+) servers(?:, (\d+) warning\(s\))?$/.exec(
      lspText,
    );
  const lsp: ConnectionRecord = {
    id: "lsp",
    kind: "lsp",
    name: "Language servers",
    state:
      lspText === "LSP: failed"
        ? "error"
        : match
          ? Number(match[1]) > 0
            ? "connected"
            : "configured"
          : "unknown",
    summary:
      lspText ||
      (lspCommand
        ? "Native controls available; live state not reported"
        : "Optional LSP module is not loaded"),
    source: "Native LSP extension status",
    ...(match ? { active: Number(match[1]), total: Number(match[2]) } : {}),
  };
  diagnostics.push(
    ...host.bridge.notifications
      .filter((item) =>
        /\b(?:MCP|LSP)\b/.test(stripVTControlCharacters(item.message)),
      )
      .slice(-20)
      .map((item) => `${item.type}: ${item.message}`),
  );
  const clean = (value: string) => redactConnectionText(value, redactions);
  return {
    mcp: [...records.values()].map((row) => ({
      ...row,
      summary: clean(row.summary),
      source: clean(row.source),
    })),
    lsp: { ...lsp, summary: clean(lsp.summary) },
    mcpAvailable: !!mcpCommand,
    lspAvailable: !!lspCommand,
    providers: host.session.modelRuntime.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name ?? provider.id,
      configured: host.session.modelRuntime.hasConfiguredAuth(provider.id),
    })),
    diagnostics: diagnostics.map(clean),
    mcpLogPath: join(host.runtime.services.agentDir, "mcp.log"),
    redact: clean,
  };
}
export function readConnectionLog(
  path: string,
  redact: (text: string) => string = redactConnectionText,
): string {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const size = fstatSync(descriptor).size,
      limit = 64 * 1024,
      start = Math.max(0, size - limit),
      buffer = Buffer.alloc(Math.min(size, limit));
    const count = readSync(descriptor, buffer, 0, buffer.length, start);
    let content = buffer.subarray(0, count).toString("utf8");
    if (start > 0)
      content = content.includes("\n")
        ? content.slice(content.indexOf("\n") + 1)
        : "Latest log line exceeds 64 KiB; not displayed.";
    return `${start > 0 ? "Last 64 KiB of log\n\n" : ""}${redact(content) || "No log messages recorded."}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return "No MCP log has been created. Servers may not have reported log messages.";
    throw new Error(`Cannot read connection log ${path}`, { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
export type ConnectionAction =
  | { kind: "mcp-manager" }
  | { kind: "mcp-retry"; name: string }
  | { kind: "lsp-manager" }
  | { kind: "lsp-diagnostics" }
  | { kind: "lsp-retry" };
export async function executeConnectionAction(
  host: ConnectionsHost,
  action: ConnectionAction,
): Promise<void> {
  if (!host.session.isIdle)
    throw new Error("Wait for current work before changing connections");
  const name = action.kind.startsWith("mcp") ? "mcp" : "lsp",
    command = host.session.extensionRunner.getCommand(name);
  if (!command) throw new Error(`Native /${name} controls are not loaded`);
  let args = "";
  if (action.kind === "mcp-retry") {
    if (!action.name || /\s/.test(action.name))
      throw new Error("This server requires selection in native MCP controls");
    args = ` reconnect ${action.name}`;
  }
  if (action.kind === "lsp-diagnostics") args = " doctor";
  if (action.kind === "lsp-retry") args = " restart";
  await host.send(`/${command.invocationName}${args}`);
}
