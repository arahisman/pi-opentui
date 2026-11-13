import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  object,
  projectUsage,
  type UsageProjection,
  type UsageRequest,
} from "./telemetry.ts";
export interface JournalDiagnostic {
  code: "malformed" | "read" | "stale";
  path: string;
  message: string;
}
export interface JournalUsage {
  projection?: UsageProjection;
  diagnostics: JournalDiagnostic[];
  latestEventAt?: number;
  requests?: UsageRequest[];
}
interface Event {
  version: 1;
  eventId: string;
  sessionId: string;
  rootSession: string;
  sessionFile: string;
  role: string;
  provider: string;
  model: string;
  timestamp: string;
  reported: boolean;
  tokens: Record<string, number | null>;
  estimatedCost: number | null;
  requestId?: string;
  phase?: "started" | "completed";
  advisor?: string;
}
interface CachedFile {
  key: string;
  events: unknown[];
  incompleteTail: boolean;
}
const cache = new Map<string, CachedFile>();
const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const absent = (error: unknown) => object(error).code === "ENOENT";
function readEvents(path: string): CachedFile {
  const stat = statSync(path),
    key = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`,
    previous = cache.get(path);
  if (previous?.key === key) {
    cache.delete(path);
    cache.set(path, previous);
    return previous;
  }
  const data = readFileSync(path, "utf8"),
    lines = data.split("\n"),
    events: unknown[] = [];
  let incompleteTail = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      if (index === lines.length - 1 && !data.endsWith("\n")) {
        incompleteTail = true;
        break;
      }
      throw new Error(`Invalid usage event JSON at ${path}:${index + 1}`, {
        cause: error,
      });
    }
  }
  const result = { key, events, incompleteTail };
  cache.set(path, result);
  if (cache.size > 128) cache.delete(cache.keys().next().value!);
  return result;
}
function validate(raw: unknown, root: string, path: string): Event {
  const event = object(raw);
  for (const key of [
    "eventId",
    "sessionId",
    "rootSession",
    "sessionFile",
    "role",
    "provider",
    "model",
    "timestamp",
  ])
    if (typeof event[key] !== "string" || !event[key])
      throw new Error(`Invalid usage event ${key} in ${path}`);
  if (
    event.version !== 1 ||
    typeof event.reported !== "boolean" ||
    !Number.isFinite(Date.parse(event.timestamp as string))
  )
    throw new Error(
      `Invalid usage event version, reported flag or timestamp in ${path}`,
    );
  if (resolve(dirname(root), event.rootSession as string) !== root)
    throw new Error(
      `Usage event belongs to a different rootSession in ${path}`,
    );
  for (const key of ["requestId", "advisor"])
    if (event[key] !== undefined && typeof event[key] !== "string")
      throw new Error(`Invalid usage event ${key} in ${path}`);
  if (
    event.phase !== undefined &&
    event.phase !== "started" &&
    event.phase !== "completed"
  )
    throw new Error(`Invalid usage event phase in ${path}`);
  if (event.estimatedCost !== null && !nonnegative(event.estimatedCost))
    throw new Error(`Invalid usage event estimatedCost in ${path}`);
  const tokens = object(event.tokens);
  if (
    event.tokens === null ||
    typeof event.tokens !== "object" ||
    Array.isArray(event.tokens)
  )
    throw new Error(`Invalid usage event tokens in ${path}`);
  for (const key of fields)
    if (
      event.reported
        ? !nonnegative(tokens[key])
        : tokens[key] !== undefined &&
          tokens[key] !== null &&
          !nonnegative(tokens[key])
    )
      throw new Error(`Invalid usage event ${key} tokens in ${path}`);
  if (
    event.reasoning !== undefined &&
    event.reasoning !== null &&
    !nonnegative(event.reasoning)
  )
    throw new Error(`Invalid usage event reasoning in ${path}`);
  return event as unknown as Event;
}
const empty = () => ({
  responses: 0,
  unreportedResponses: 0,
  unpricedResponses: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  estimatedCost: 0,
});
type Total = ReturnType<typeof empty>;
function add(total: Total, event: Event) {
  total.responses++;
  if (!event.reported) total.unreportedResponses++;
  if (event.estimatedCost === null) total.unpricedResponses++;
  else total.estimatedCost += event.estimatedCost;
  for (const key of fields) total.tokens[key] += event.tokens[key] ?? 0;
}
export function loadUsageJournal(rootSession: string): JournalUsage {
  const root = resolve(rootSession),
    directory = `${root}.usage/events`,
    diagnostics: JournalDiagnostic[] = [];
  let files: string[];
  try {
    files = readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
  } catch (error) {
    if (!absent(error))
      diagnostics.push({
        code: "read",
        path: directory,
        message: `Cannot read usage journal: ${error instanceof Error ? error.message : String(error)}`,
      });
    return { diagnostics };
  }
  const responses = new Map<string, Event>();
  let latestEventAt: number | undefined;
  for (const file of files) {
    const path = join(directory, file);
    try {
      const data = readEvents(path);
      if (data.incompleteTail)
        diagnostics.push({
          code: "malformed",
          path,
          message: `Usage journal has an incomplete trailing JSON record in ${path}; totals exclude the unfinished record`,
        });
      for (const raw of data.events) {
        const event = validate(raw, root, path),
          id = `${event.sessionId}:${event.requestId ?? event.eventId}`,
          previous = responses.get(id);
        if (!previous || previous.phase === "started") responses.set(id, event);
        latestEventAt = Math.max(
          latestEventAt ?? 0,
          Date.parse(event.timestamp),
        );
      }
    } catch (error) {
      diagnostics.push({
        code: typeof object(error).code === "string" ? "read" : "malformed",
        path,
        message: error instanceof Error ? error.message : String(error),
      });
      return { diagnostics };
    }
  }
  if (!responses.size) return { diagnostics };
  const totals = empty(),
    byModel: Record<string, Total> = Object.create(null),
    byAgent: Record<string, Total> = Object.create(null);
  for (const event of responses.values()) {
    add(totals, event);
    add((byModel[`${event.provider}/${event.model}`] ??= empty()), event);
    add(
      (byAgent[`${event.sessionId}:${event.role}:${event.advisor ?? ""}`] ??=
        empty()),
      event,
    );
  }
  const projection = projectUsage([], { version: 1, totals, byModel, byAgent });
  if (projection.source !== "ledger")
    return {
      diagnostics: [
        ...diagnostics,
        {
          code: "malformed",
          path: directory,
          message: projection.warning ?? "Invalid usage journal totals",
        },
      ],
    };
  const requests: UsageRequest[] = [...responses.values()].map((event) => ({
    id: `${event.sessionId}:${event.requestId ?? event.eventId}`,
    timestamp: event.timestamp,
    agent: `${event.role}${event.advisor ? ` · ${event.advisor}` : ""} · ${event.sessionId}`,
    provider: event.provider,
    model: event.model,
    state:
      event.phase === "started"
        ? "pending"
        : event.reported
          ? "completed"
          : "unreported",
    usage: {
      input: event.tokens.input ?? 0,
      output: event.tokens.output ?? 0,
      cacheRead: event.tokens.cacheRead ?? 0,
      cacheWrite: event.tokens.cacheWrite ?? 0,
      responses: 1,
      missingUsage: event.reported ? 0 : 1,
      unpriced: event.estimatedCost === null ? 1 : 0,
      cost: event.estimatedCost,
    },
  }));
  return { projection, diagnostics, latestEventAt, requests };
}
