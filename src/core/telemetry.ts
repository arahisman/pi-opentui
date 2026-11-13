export type JsonRecord = Record<string, unknown>;
export const object = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
const validNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const number = (value: unknown) => (validNumber(value) ? value : 0);
const string = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : fallback;
export interface UsageTotal {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  responses: number;
  missingUsage: number;
  unpriced: number;
  cost: number | null;
}
export interface UsageRequest {
  id: string;
  timestamp: string;
  agent: string;
  provider: string;
  model: string;
  state: "pending" | "completed" | "unreported";
  usage: UsageTotal;
}
export interface UsageProjection {
  source: "ledger" | "native";
  coverage: "all-reported-agents" | "main-only";
  totals: UsageTotal;
  byModel: Record<string, UsageTotal>;
  byAgent: Record<string, UsageTotal>;
  warning?: string;
}
const empty = (): UsageTotal => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  responses: 0,
  missingUsage: 0,
  unpriced: 0,
  cost: null,
});
function add(target: UsageTotal, source: UsageTotal) {
  for (const key of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "responses",
    "missingUsage",
    "unpriced",
  ] as const)
    target[key] += source[key];
  if (source.cost !== null) target.cost = (target.cost ?? 0) + source.cost;
}
function ledgerTotal(value: unknown): UsageTotal {
  const row = object(value),
    tokens = object(row.tokens);
  for (const key of ["input", "output", "cacheRead", "cacheWrite"])
    if (!validNumber(tokens[key]))
      throw new Error("Invalid ledger token counters");
  for (const key of ["responses", "unreportedResponses", "unpricedResponses"])
    if (!validNumber(row[key]))
      throw new Error("Invalid ledger response counters");
  if (!validNumber(row.estimatedCost)) throw new Error("Invalid ledger cost");
  return {
    input: number(tokens.input),
    output: number(tokens.output),
    cacheRead: number(tokens.cacheRead),
    cacheWrite: number(tokens.cacheWrite),
    responses: number(row.responses),
    missingUsage: number(row.unreportedResponses),
    unpriced: number(row.unpricedResponses),
    cost:
      row.responses === row.unpricedResponses
        ? null
        : number(row.estimatedCost),
  };
}
export function projectUsage(
  entries: readonly unknown[],
  ledger?: unknown,
): UsageProjection {
  let warning: string | undefined;
  if (ledger !== undefined) {
    try {
      const data = object(ledger);
      if (data.version !== 1) throw new Error("Unsupported ledger version");
      const totals = ledgerTotal(data.totals);
      const groups = (value: unknown) =>
        Object.fromEntries(
          Object.entries(object(value)).map(([key, row]) => [
            key,
            ledgerTotal(row),
          ]),
        );
      return {
        source: "ledger",
        coverage: "all-reported-agents",
        totals,
        byModel: groups(data.byModel),
        byAgent: groups(data.byAgent),
      };
    } catch (error) {
      warning = error instanceof Error ? error.message : "Invalid ledger";
    }
  }
  const totals = empty(),
    byModel: Record<string, UsageTotal> = {},
    seen = new Set<string>();
  for (const raw of entries) {
    const entry = object(raw),
      message = object(entry.message);
    if (entry.type !== "message" || message.role !== "assistant") continue;
    const id = string(entry.id);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const usage = object(message.usage),
      cost = object(usage.cost),
      row = empty();
    row.responses = 1;
    const measured =
      ["input", "output", "cacheRead", "cacheWrite"].every((k) =>
        validNumber(usage[k]),
      ) &&
      ["input", "output", "cacheRead", "cacheWrite"].some(
        (k) => number(usage[k]) > 0,
      );
    if (measured)
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
        row[key] = number(usage[key]);
    else row.missingUsage = 1;
    if (
      measured &&
      validNumber(cost.total) &&
      (cost.total > 0 || cost.totalFromProvider === true)
    )
      row.cost = cost.total;
    else row.unpriced = 1;
    const key = `${string(message.provider, "unknown")}/${string(message.model, "unknown")}`;
    add(totals, row);
    add((byModel[key] ??= empty()), row);
  }
  return {
    source: "native",
    coverage: "main-only",
    totals,
    byModel,
    byAgent: {},
    ...(warning ? { warning } : {}),
  };
}
export function projectUsageRequests(
  entries: readonly unknown[],
): UsageRequest[] {
  const requests = new Map<string, UsageRequest>();
  entries.forEach((raw, index) => {
    const entry = object(raw),
      message = object(entry.message);
    if (entry.type !== "message" || message.role !== "assistant") return;
    const id = string(entry.id, `entry:${index}`),
      usage = projectUsage([entry]).totals;
    const time =
      typeof message.timestamp === "number"
        ? message.timestamp
        : Date.parse(string(entry.timestamp));
    requests.set(id, {
      id,
      timestamp: Number.isFinite(time)
        ? new Date(time).toISOString()
        : "Unknown time",
      agent: "Main session",
      provider: string(message.provider, "unknown"),
      model: string(message.model, "unknown"),
      state: id.startsWith("live:")
        ? "pending"
        : usage.missingUsage
          ? "unreported"
          : "completed",
      usage,
    });
  });
  return [...requests.values()];
}
export const ADVISOR_FEEDBACK_TYPE = "pi-opentui-advisor-feedback";
export interface AdviceFeedback {
  rating: "useful" | "harmful";
  reason?: string;
  timestamp: string;
  source: "assistant" | "user";
}
export function readAdviceFeedback(
  raw: unknown,
): { noteId: string; feedback: AdviceFeedback } | undefined {
  const entry = object(raw);
  if (entry.type !== "custom" || entry.customType !== ADVISOR_FEEDBACK_TYPE)
    return undefined;
  const data = object(entry.data);
  if (
    typeof data.noteId !== "string" ||
    !data.noteId.trim() ||
    (data.rating !== "useful" && data.rating !== "harmful") ||
    typeof data.timestamp !== "string" ||
    !Number.isFinite(Date.parse(data.timestamp)) ||
    (data.source !== "assistant" && data.source !== "user") ||
    (data.reason !== undefined &&
      (typeof data.reason !== "string" || data.reason.length > 500))
  )
    return undefined;
  return {
    noteId: data.noteId,
    feedback: {
      rating: data.rating,
      ...(data.reason !== undefined ? { reason: data.reason } : {}),
      timestamp: data.timestamp,
      source: data.source,
    },
  };
}
export interface AdviceNote {
  id: string;
  advisor: string;
  model: string;
  text: string;
  title: string;
  timestamp: string;
  status: "delivered" | "pending";
  entryId: string;
  feedback?: AdviceFeedback;
}
export function projectAdvice(entries: readonly unknown[]): AdviceNote[] {
  const delivered = new Map<string, AdviceNote>();
  const feedback = new Map<string, AdviceFeedback>();
  let inbox: JsonRecord[] = [];
  const normalize = (
    value: unknown,
    entry: JsonRecord,
    index: number,
    status: AdviceNote["status"],
  ): AdviceNote => {
    const note = object(value);
    return {
      id: string(
        note.adviceId,
        string(note.id, `${string(entry.id)}:${index}`),
      ),
      advisor: string(note.advisor, "Advisor"),
      model: string(note.model),
      text: string(note.note, string(note.text)),
      title: string(note.shortTitle),
      timestamp:
        typeof note.createdAt === "number"
          ? new Date(note.createdAt).toISOString()
          : string(entry.timestamp),
      status,
      entryId: string(entry.id),
    };
  };
  for (const raw of entries) {
    const entry = object(raw);
    const rating = readAdviceFeedback(entry);
    if (rating && delivered.has(rating.noteId))
      feedback.set(rating.noteId, rating.feedback);
    if (
      entry.type === "custom" &&
      entry.customType === "pi-omp-advisor-inbox"
    ) {
      const items = object(entry.data).items;
      inbox = Array.isArray(items) ? items.map(object) : [];
    }
    const message = entry.type === "message" ? object(entry.message) : entry;
    if (
      (entry.type === "custom_message" || message.role === "custom") &&
      ["pi-omp-advisor", "advisor"].includes(string(message.customType))
    ) {
      const notes = object(message.details).notes;
      if (Array.isArray(notes))
        notes.forEach((note, i) => {
          const row = normalize(note, entry, i, "delivered");
          delivered.set(row.id, row);
        });
    }
  }
  const result = [...delivered.values()].map((note) =>
    feedback.has(note.id) ? { ...note, feedback: feedback.get(note.id)! } : note,
  );
  inbox.forEach((note, i) => {
    const row = normalize(note, { id: "inbox" }, i, "pending");
    if (!delivered.has(row.id)) result.push(row);
  });
  return result;
}
export interface CompactionRecord {
  id: string;
  before: number;
  after: number | null;
  model: string;
  provider: string;
  summary: string;
  savedCost: null;
}
export function projectCompactions(
  entries: readonly unknown[],
): CompactionRecord[] {
  return entries
    .map(object)
    .filter((e) => e.type === "compaction")
    .map((e) => {
      const details = object(e.details);
      return {
        id: string(e.id),
        before: number(e.tokensBefore),
        after: null,
        model: string(details.summaryModel, "unknown"),
        provider: string(details.summaryProvider, "unknown"),
        summary: string(e.summary),
        savedCost: null,
      };
    });
}
export function formatTokens(value: number): string {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(2)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`
      : String(value);
}
export function formatCost(value: number | null): string {
  return value === null ? "—" : `~$${value.toFixed(value < 1 ? 3 : 2)}`;
}
