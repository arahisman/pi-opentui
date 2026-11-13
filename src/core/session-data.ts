import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  CustomEntry,
  MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { object, projectUsage, type UsageProjection } from "./telemetry.ts";
import { loadUsageJournal } from "./usage-journal.ts";
import { persistedCompactionInterruptions } from "./compaction-state.ts";

export interface TranscriptItem {
  id: string;
  entryId: string;
  kind:
    | "text"
    | "thinking"
    | "image"
    | "toolCall"
    | "toolResult"
    | "custom"
    | "compaction"
    | "branchSummary"
    | "bash"
    | "error";
  role: string;
  model?: string;
  provider?: string;
  text: string;
  toolCallId?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  resultFor?: string;
  diff?: string;
  isError?: boolean;
  customType?: string;
  details?: unknown;
  customMessage?: Parameters<MessageRenderer>[0];
  customEntry?: CustomEntry;
  tokensBefore?: number;
}
export interface TranscriptProjectionOptions {
  hasEntryRenderer?: (customType: string) => boolean;
  isCompactionInterruption?: (entryId: string) => boolean;
}
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
const contentText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
          .map((block) => {
            const item = object(block);
            return item.type === "text"
              ? text(item.text)
              : item.type === "image"
                ? `[image: ${text(item.mimeType)}]`
                : typeof item.type === "string"
                  ? `[unsupported block: ${item.type}]`
                  : "";
          })
          .filter(Boolean)
          .join("\n")
      : "";

export function projectTranscript(
  entries: readonly unknown[],
  options: TranscriptProjectionOptions = {},
): TranscriptItem[] {
  const interrupted = persistedCompactionInterruptions(entries);
  const result: TranscriptItem[] = [],
    calls = new Map<string, string>();
  entries.forEach((raw, index) => {
    const entry = object(raw),
      entryId = text(entry.id) || `entry:${index}`;
    const push = (
      kind: TranscriptItem["kind"],
      role: string,
      body: string,
      suffix: string,
      extra: Partial<TranscriptItem> = {},
    ) => {
      const item: TranscriptItem = {
        id: `${entryId}:${suffix}`,
        entryId,
        kind,
        role,
        text: body,
        ...(role === "assistant"
          ? {
              model: text(object(entry.message).model),
              provider: text(object(entry.message).provider),
            }
          : {}),
        ...extra,
      };
      result.push(item);
      return item;
    };
    if (entry.type === "compaction") {
      push("compaction", "system", text(entry.summary), "compaction", {
        tokensBefore:
          typeof entry.tokensBefore === "number"
            ? entry.tokensBefore
            : undefined,
        details: structuredClone(entry.details),
      });
      return;
    }
    if (entry.type === "branch_summary") {
      push("branchSummary", "system", text(entry.summary), "branch", {
        details: structuredClone(entry.details),
      });
      return;
    }
    if (entry.type === "custom") {
      const customType = text(entry.customType);
      if (options.hasEntryRenderer?.(customType))
        push("custom", "custom", "", "custom-entry", {
          customType,
          customEntry: structuredClone(entry) as unknown as CustomEntry,
        });
      return;
    }
    if (entry.type !== "message" && entry.type !== "custom_message") return;
    const message =
        entry.type === "custom_message"
          ? { ...entry, role: "custom" }
          : object(entry.message),
      role = text(message.role);
    if (message.display === false || role === "system") return;
    if (role === "custom") {
      push("custom", role, contentText(message.content), "custom", {
        customType: text(message.customType),
        details: structuredClone(message.details),
        customMessage: structuredClone({
          ...message,
          timestamp:
            typeof message.timestamp === "number"
              ? message.timestamp
              : Date.parse(text(message.timestamp)),
        }) as unknown as Parameters<MessageRenderer>[0],
      });
      return;
    }
    if (role === "bashExecution") {
      push(
        "bash",
        role,
        `${text(message.command)}\n${text(message.output)}`,
        "bash",
        {
          isError:
            message.cancelled === true ||
            (typeof message.exitCode === "number" && message.exitCode !== 0),
        },
      );
      return;
    }
    if (role === "toolResult") {
      const toolCallId = text(message.toolCallId);
      push("toolResult", role, contentText(message.content), "result", {
        toolCallId,
        toolName: text(message.toolName),
        resultFor: calls.get(toolCallId),
        diff:
          text(object(message.details).patch) ||
          text(object(message.details).diff) ||
          undefined,
        isError: message.isError === true,
        details: structuredClone(message.details),
      });
      return;
    }
    if (role === "compactionSummary" || role === "branchSummary") {
      push(
        role === "compactionSummary" ? "compaction" : "branchSummary",
        role,
        text(message.summary),
        "summary",
        {
          tokensBefore:
            typeof message.tokensBefore === "number"
              ? message.tokensBefore
              : undefined,
          details: structuredClone(message.details),
        },
      );
      return;
    }
    if (role !== "user" && role !== "assistant") {
      const body = contentText(message.content);
      if (role && body)
        push("custom", role, body, "custom", {
          customType: text(message.customType) || role,
          details: structuredClone(message.details),
        });
      return;
    }
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : [];
    blocks.forEach((rawBlock, blockIndex) => {
      const block = object(rawBlock),
        suffix = String(blockIndex);
      if (block.type === "text") push("text", role, text(block.text), suffix);
      else if (block.type === "thinking")
        push(
          "thinking",
          role,
          block.redacted === true
            ? "[redacted thinking]"
            : text(block.thinking),
          suffix,
        );
      else if (block.type === "image")
        push("image", role, `[image: ${text(block.mimeType)}]`, suffix);
      else if (block.type === "toolCall") {
        const toolCallId = text(block.id),
          item = push("toolCall", role, text(block.name), suffix, {
            toolCallId,
            toolName: text(block.name),
            arguments: structuredClone(object(block.arguments)),
          });
        if (toolCallId) calls.set(toolCallId, item.id);
      } else if (typeof block.type === "string")
        push("custom", role, `[unsupported block: ${block.type}]`, suffix, {
          customType: block.type,
        });
    });
    if (
      message.errorMessage &&
      !(message.stopReason === "aborted" &&
        (interrupted.has(entryId) || options.isCompactionInterruption?.(entryId)))
    )
      push("error", role, text(message.errorMessage), "error", {
        isError: true,
      });
  });
  return result;
}

export interface UsageDiagnostic {
  code: "ancestry" | "malformed" | "stale" | "read";
  path: string;
  message: string;
}
export interface LoadedUsage extends UsageProjection {
  diagnostics: UsageDiagnostic[];
  rootSession?: string;
  ledgerFile?: string;
}
const missing = (error: unknown) => object(error).code === "ENOENT";
export function loadUsage(
  sessionFile: string | undefined,
  entries: readonly unknown[],
  options: { allowMissingSession?: boolean } = {},
): LoadedUsage {
  const diagnostics: UsageDiagnostic[] = [];
  const fallback = (): LoadedUsage => ({
    ...projectUsage(entries),
    diagnostics,
    ...(diagnostics.length
      ? { warning: diagnostics.map((item) => item.message).join("; ") }
      : {}),
  });
  if (!sessionFile) return fallback();
  let root = resolve(sessionFile);
  const visited = new Set<string>();
  for (let depth = 0; ; depth++) {
    if (depth >= 64 || visited.has(root)) {
      diagnostics.push({
        code: "ancestry",
        path: root,
        message: "Cycle or depth limit in Pi parentSession ancestry",
      });
      return fallback();
    }
    visited.add(root);
    let header: Record<string, unknown>;
    try {
      header = object(
        JSON.parse(readFileSync(root, "utf8").split("\n", 1)[0]!),
      );
      if (header.type !== "session")
        throw new Error("Expected Pi session header");
    } catch (error) {
      if (depth === 0 && options.allowMissingSession && missing(error))
        return fallback();
      diagnostics.push({
        code: "ancestry",
        path: root,
        message: `Cannot read Pi session header ${root}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return fallback();
    }
    if (header.parentSession === undefined) break;
    if (typeof header.parentSession !== "string" || !header.parentSession) {
      diagnostics.push({
        code: "ancestry",
        path: root,
        message: "Invalid parentSession path",
      });
      return fallback();
    }
    root = resolve(dirname(root), header.parentSession);
  }
  const ledgerFile = `${root}.usage/summary.json`;
  const recoverJournal = (): LoadedUsage => {
    const journal = loadUsageJournal(root);
    diagnostics.push(...journal.diagnostics);
    if (journal.projection) {
      const newer = entries.some((raw) => {
        const entry = object(raw),
          message = object(entry.message);
        return (
          entry.type === "message" &&
          message.role === "assistant" &&
          typeof message.timestamp === "number" &&
          message.timestamp > (journal.latestEventAt ?? 0)
        );
      });
      if (newer)
        diagnostics.push({
          code: "stale",
          path: `${root}.usage/events`,
          message:
            "Usage journal may predate the latest main assistant response; native totals were not added",
        });
      return {
        ...journal.projection,
        diagnostics,
        rootSession: root,
        ledgerFile,
        ...(diagnostics.length
          ? { warning: diagnostics.map((item) => item.message).join("; ") }
          : {}),
      };
    }
    return { ...fallback(), rootSession: root, ledgerFile };
  };
  let ledger: Record<string, unknown>;
  try {
    ledger = object(JSON.parse(readFileSync(ledgerFile, "utf8")));
  } catch (error) {
    if (!missing(error))
      diagnostics.push({
        code: error instanceof SyntaxError ? "malformed" : "read",
        path: ledgerFile,
        message: `Cannot read usage summary: ${error instanceof Error ? error.message : String(error)}`,
      });
    return recoverJournal();
  }
  const reject = (
    code: UsageDiagnostic["code"],
    message: string,
  ): LoadedUsage => {
    diagnostics.push({ code, path: ledgerFile, message });
    return recoverJournal();
  };
  if (
    typeof ledger.rootSession !== "string" ||
    resolve(dirname(root), ledger.rootSession) !== root
  )
    return reject(
      "malformed",
      "Usage summary belongs to a different or missing rootSession",
    );
  for (const group of ["byModel", "byAgent"] as const) {
    const value = ledger[group];
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return reject("malformed", `Usage summary has invalid ${group} groups`);
  }
  const updatedAt =
    typeof ledger.updatedAt === "string" ? Date.parse(ledger.updatedAt) : NaN;
  if (!Number.isFinite(updatedAt))
    return reject("malformed", "Usage summary has invalid updatedAt");
  const newerAssistant = entries.some((raw) => {
    const entry = object(raw),
      message = object(entry.message);
    return (
      entry.type === "message" &&
      message.role === "assistant" &&
      typeof message.timestamp === "number" &&
      message.timestamp > updatedAt
    );
  });
  if (newerAssistant)
    return reject(
      "stale",
      "Usage summary predates a recorded assistant response",
    );
  try {
    const summaryTime = statSync(ledgerFile).mtimeMs,
      eventDir = join(dirname(ledgerFile), "events");
    let files: string[] = [];
    try {
      files = readdirSync(eventDir);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (
      files.some(
        (name) =>
          name.endsWith(".jsonl") &&
          statSync(join(eventDir, name)).mtimeMs > summaryTime,
      )
    )
      return reject(
        "stale",
        "Usage journal contains events newer than its summary",
      );
  } catch (error) {
    return reject(
      "read",
      `Cannot verify usage journal freshness: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const projection = projectUsage(entries, ledger);
  if (projection.source !== "ledger")
    return reject("malformed", projection.warning ?? "Invalid usage summary");
  if (ledger.incompleteTail === true)
    diagnostics.push({
      code: "malformed",
      path: ledgerFile,
      message:
        "Usage summary reports an incomplete journal tail; totals may omit the unfinished event",
    });
  return {
    ...projection,
    diagnostics,
    rootSession: root,
    ledgerFile,
    ...(diagnostics.length
      ? { warning: diagnostics.map((item) => item.message).join("; ") }
      : {}),
  };
}
