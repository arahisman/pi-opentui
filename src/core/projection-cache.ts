import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  loadUsage,
  projectTranscript,
  type LoadedUsage,
  type TranscriptItem,
  type TranscriptProjectionOptions,
} from "./session-data.ts";
import {
  ADVISOR_FEEDBACK_TYPE,
  object,
  projectAdvice,
  readAdviceFeedback,
  projectCompactions,
  projectUsage,
  type AdviceFeedback,
  type AdviceNote,
  type UsageProjection,
  type UsageTotal,
} from "./telemetry.ts";

type Source = Pick<
  SessionManager,
  "getLeafId" | "getEntryCount" | "getEntry" | "getBranch"
>;
const signature = (path: string): string => {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch (error) {
    return `${object(error).code ?? String(error)}`;
  }
};
const identity = (path: string): string => {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.birthtimeMs}`;
  } catch (error) {
    return `${object(error).code ?? String(error)}`;
  }
};
const advisorEntry = (raw: unknown): boolean => {
  const entry = object(raw),
    message = entry.type === "message" ? object(entry.message) : entry;
  return (
    (entry.type === "custom" &&
      ["pi-omp-advisor-inbox", ADVISOR_FEEDBACK_TYPE].includes(
        String(entry.customType),
      )) ||
    ((entry.type === "custom_message" || message.role === "custom") &&
      ["pi-omp-advisor", "advisor"].includes(String(message.customType)))
  );
};
function addTotal(target: UsageTotal, source: UsageTotal): void {
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
function addUsage(target: UsageProjection, source: UsageProjection): void {
  addTotal(target.totals, source.totals);
  for (const [key, total] of Object.entries(source.byModel)) {
    if (target.byModel[key]) addTotal(target.byModel[key]!, total);
    else target.byModel[key] = { ...total };
  }
}
const assistantTime = (entry: unknown): number => {
  const value = object(entry),
    message = object(value.message);
  return value.type === "message" &&
    message.role === "assistant" &&
    typeof message.timestamp === "number"
    ? message.timestamp
    : -Infinity;
};
export class ProjectionCache {
  constructor(private readonly transcriptOptions: TranscriptProjectionOptions = {}) {}
  private source?: Source;
  private leaf: string | null = null;
  private count = -1;
  private dirty = true;
  private liveVersion = -1;
  private liveEntry?: unknown;
  private baseLength = 0;
  private hasConversation = false;
  private transcriptLength = 0;
  private entryIds = new Set<string>();
  private calls = new Map<string, string>();
  private results = new Map<string, TranscriptItem>();
  private liveResults = new Map<string, TranscriptItem | undefined>();
  get toolResults(): ReadonlyMap<string, TranscriptItem> {
    return this.results;
  }
  private delivered = new Map<string, AdviceNote>();
  private feedback = new Map<string, AdviceFeedback>();
  private inbox: AdviceNote[] = [];
  private baseAdvice: AdviceNote[] = [];
  private baseUsage = projectUsage([]);
  private nativeUsage = this.baseUsage;
  private latestAssistant?: unknown;
  private usageFile?: string;
  private usageRoot?: string;
  private usageFingerprint?: string;
  private usageTimestamp = -Infinity;
  private loadedUsage?: LoadedUsage;
  private usageResult?: LoadedUsage;
  private usageResultNative?: UsageProjection;
  private eventDirectoryKey?: string;
  private eventFiles: string[] = [];
  entries: unknown[] = [];
  transcript: TranscriptItem[] = [];
  advice: AdviceNote[] = [];
  compactions = projectCompactions([]);
  revision = 0;
  baseRevision = 0;
  readonly work = {
    branchReads: 0,
    transcriptEntries: 0,
    adviceEntries: 0,
    compactionEntries: 0,
    nativeUsageEntries: 0,
    liveEntries: 0,
    usageLoads: 0,
  };
  invalidate(): void {
    this.dirty = true;
    this.loadedUsage = undefined;
    this.usageFingerprint = undefined;
    this.usageRoot = undefined;
  }
  clear(): void {
    this.source = undefined;
    this.entryIds.clear();
    this.calls.clear();
    this.results.clear();
    this.liveResults.clear();
    this.delivered.clear();
    this.feedback.clear();
    this.inbox = [];
    this.baseAdvice = [];
    this.entries = [];
    this.transcript = [];
    this.compactions = [];
    this.advice = [];
    this.baseLength = 0;
    this.hasConversation = false;
    this.transcriptLength = 0;
    this.latestAssistant = undefined;
    this.liveEntry = undefined;
    this.nativeUsage = this.baseUsage = projectUsage([]);
    this.usageResult = undefined;
    this.usageResultNative = undefined;
    this.eventFiles = [];
    this.eventDirectoryKey = undefined;
    this.invalidate();
  }
  sync(
    source: Source,
    liveEntry: unknown | undefined,
    liveVersion: number,
  ): void {
    const leaf = source.getLeafId(),
      count = source.getEntryCount();
    const changed =
      this.dirty ||
      source !== this.source ||
      leaf !== this.leaf ||
      count !== this.count;
    if (!changed && liveVersion === this.liveVersion) return;
    for (const [key, previous] of this.liveResults) {
      if (previous) this.results.set(key, previous);
      else this.results.delete(key);
    }
    this.liveResults.clear();
    this.entries.length = this.baseLength;
    this.transcript.length = this.transcriptLength;
    if (changed) {
      let appended: unknown[] | undefined;
      if (!this.dirty && source === this.source && leaf !== this.leaf) {
        const delta: unknown[] = [];
        let cursor = leaf;
        while (cursor && cursor !== this.leaf && !this.entryIds.has(cursor)) {
          const entry = source.getEntry(cursor);
          if (!entry) break;
          delta.push(entry);
          cursor = entry.parentId;
        }
        if (cursor === this.leaf) appended = delta.reverse();
      } else if (!this.dirty && source === this.source && leaf === this.leaf)
        appended = [];
      if (appended) this.append(appended);
      else {
        this.work.branchReads++;
        this.entries = source.getBranch();
        this.rebuild();
      }
      this.source = source;
      this.leaf = leaf;
      this.count = count;
      this.dirty = false;
      this.baseLength = this.entries.length;
      this.transcriptLength = this.transcript.length;
      this.baseRevision++;
    }
    this.liveEntry = liveEntry;
    this.liveVersion = liveVersion;
    this.nativeUsage = this.baseUsage;
    this.advice = this.baseAdvice;
    if (liveEntry) {
      this.entries.push(liveEntry);
      this.work.liveEntries++;
      const tail = projectTranscript([liveEntry], this.transcriptOptions);
      this.link(tail, false);
      for (const row of tail) this.transcript.push(row);
      const usage = projectUsage([liveEntry]);
      this.nativeUsage = {
        ...this.baseUsage,
        totals: { ...this.baseUsage.totals },
        byModel: Object.fromEntries(
          Object.entries(this.baseUsage.byModel).map(([key, total]) => [
            key,
            { ...total },
          ]),
        ),
      };
      addUsage(this.nativeUsage, usage);
      if (advisorEntry(liveEntry)) this.advice = projectAdvice(this.entries);
    }
    this.revision++;
  }
  private link(rows: TranscriptItem[], persist: boolean): void {
    const temporary = persist ? this.calls : new Map<string, string>();
    for (const row of rows) {
      if (row.kind === "toolResult" && row.toolCallId && !row.resultFor)
        row.resultFor =
          temporary.get(row.toolCallId) ?? this.calls.get(row.toolCallId);
      if (row.kind === "toolCall" && row.toolCallId)
        temporary.set(row.toolCallId, row.id);
      if (row.kind === "toolResult" && row.resultFor) {
        if (!persist && !this.liveResults.has(row.resultFor))
          this.liveResults.set(row.resultFor, this.results.get(row.resultFor));
        this.results.set(row.resultFor, row);
      }
    }
  }
  private rebuild(): void {
    this.hasConversation = this.entries.some((raw) => {
      const entry = object(raw),
        role = object(entry.message).role;
      return (
        entry.type === "message" && (role === "user" || role === "assistant")
      );
    });
    this.entryIds = new Set(
      this.entries.map((entry) => String(object(entry).id)),
    );
    this.calls.clear();
    this.results.clear();
    this.transcript = projectTranscript(this.entries, this.transcriptOptions);
    this.link(this.transcript, true);
    this.baseAdvice = projectAdvice(this.entries);
    this.feedback = new Map(
      this.baseAdvice.flatMap((note) =>
        note.feedback ? [[note.id, note.feedback] as const] : [],
      ),
    );
    this.delivered = new Map(
      this.baseAdvice
        .filter((note) => note.status === "delivered")
        .map((note) => [note.id, note]),
    );
    this.inbox = this.baseAdvice.filter((note) => note.status === "pending");
    this.compactions = projectCompactions(this.entries);
    this.baseUsage = projectUsage(this.entries);
    this.latestAssistant = undefined;
    for (const entry of this.entries)
      if (assistantTime(entry) > assistantTime(this.latestAssistant))
        this.latestAssistant = entry;
    this.work.transcriptEntries += this.entries.length;
    this.work.adviceEntries += this.entries.length;
    this.work.compactionEntries += this.entries.length;
    this.work.nativeUsageEntries += this.entries.length;
  }
  private append(delta: unknown[]): void {
    if (!delta.length) return;
    const normalized = delta.map((raw, index) =>
      object(raw).id
        ? raw
        : { ...object(raw), id: `entry:${this.entries.length + index}` },
    );
    const rows = projectTranscript(normalized, this.transcriptOptions);
    this.link(rows, true);
    for (const row of rows) this.transcript.push(row);
    let adviceChanged = false;
    for (const entry of delta) {
      const value = object(entry),
        role = object(value.message).role;
      if (value.type === "message" && (role === "user" || role === "assistant"))
        this.hasConversation = true;
      this.entryIds.add(String(object(entry).id));
      this.entries.push(entry);
      if (assistantTime(entry) > assistantTime(this.latestAssistant))
        this.latestAssistant = entry;
      if (advisorEntry(entry)) {
        this.work.adviceEntries++;
        const rating = readAdviceFeedback(entry);
        if (rating && this.delivered.has(rating.noteId))
          this.feedback.set(rating.noteId, rating.feedback);
        const notes = projectAdvice([entry]);
        if (object(entry).customType === "pi-omp-advisor-inbox")
          this.inbox = notes;
        else
          for (const row of notes)
            if (row.status === "delivered") this.delivered.set(row.id, row);
        adviceChanged = true;
      }
    }
    if (adviceChanged)
      this.baseAdvice = [
        ...[...this.delivered.values()].map((note) =>
          this.feedback.has(note.id)
            ? { ...note, feedback: this.feedback.get(note.id)! }
            : note,
        ),
        ...this.inbox.filter((note) => !this.delivered.has(note.id)),
      ];
    for (const record of projectCompactions(delta))
      this.compactions.push(record);
    addUsage(this.baseUsage, projectUsage(delta));
    this.work.transcriptEntries += delta.length;
    this.work.compactionEntries += delta.length;
    this.work.nativeUsageEntries += delta.length;
  }
  private externalFingerprint(sessionFile: string): string {
    const root = this.usageRoot ?? resolve(sessionFile),
      directory = `${root}.usage/events`;
    const directoryKey = `${directory}:${signature(directory)}`;
    if (directoryKey !== this.eventDirectoryKey) {
      try {
        this.eventFiles = readdirSync(directory)
          .filter((name) => name.endsWith(".jsonl"))
          .sort();
      } catch (error) {
        this.eventFiles = [`!${object(error).code ?? String(error)}`];
      }
      this.eventDirectoryKey = directoryKey;
    }
    return [
      identity(sessionFile),
      identity(root),
      signature(`${root}.usage/summary.json`),
      directoryKey,
      ...this.eventFiles.map(
        (name) => `${name}:${signature(join(directory, name))}`,
      ),
    ].join("|");
  }
  usage(sessionFile: string | undefined): LoadedUsage {
    if (sessionFile !== this.usageFile) {
      this.usageFile = sessionFile;
      this.usageRoot = undefined;
      this.loadedUsage = undefined;
      this.eventDirectoryKey = undefined;
    }
    const latest =
      assistantTime(this.liveEntry) > assistantTime(this.latestAssistant)
        ? this.liveEntry
        : this.latestAssistant;
    const timestamp = assistantTime(latest),
      fingerprint = sessionFile
        ? this.externalFingerprint(sessionFile)
        : "native";
    if (
      !this.loadedUsage ||
      fingerprint !== this.usageFingerprint ||
      timestamp !== this.usageTimestamp
    ) {
      this.work.usageLoads++;
      this.loadedUsage = loadUsage(sessionFile, latest ? [latest] : [], {
        allowMissingSession: !this.hasConversation,
      });
      this.usageRoot = this.loadedUsage.rootSession;
      this.usageFingerprint = sessionFile
        ? this.externalFingerprint(sessionFile)
        : "native";
      this.usageTimestamp = timestamp;
      this.usageResult = undefined;
    }
    if (this.loadedUsage.source === "ledger") return this.loadedUsage;
    if (!this.usageResult || this.usageResultNative !== this.nativeUsage) {
      this.usageResultNative = this.nativeUsage;
      this.usageResult = {
        ...this.loadedUsage,
        totals: this.nativeUsage.totals,
        byModel: this.nativeUsage.byModel,
        byAgent: this.nativeUsage.byAgent,
      };
    }
    return this.usageResult;
  }
}
