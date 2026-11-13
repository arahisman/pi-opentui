import type {
  AgentSessionEvent,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { object } from "./telemetry.ts";

export const COMPACTION_INTERRUPTION_TYPE = "pi-opentui-compaction-interruption";
export interface CompactionActivity {
  startedAt: number;
  automatic: boolean;
  reason?: string;
  tokensBefore?: number;
}
type Manager = Pick<SessionManager, "getBranch" | "appendCustomEntry">;
export class CompactionState {
  active?: CompactionActivity;
  readonly interrupted = new Set<string>();
  cancelled = false;
  private candidate?: unknown;
  private userAborted = false;
  private requested = false;
  get manualRequested(): boolean {
    return this.requested;
  }
  beginManual(): void {
    this.requested = true;
    this.cancelled = false;
    this.active = { startedAt: Date.now(), automatic: false, reason: "manual" };
  }
  userAbort(): void {
    this.userAborted = true;
    this.candidate = undefined;
  }
  clear(): void {
    this.active = undefined;
    this.interrupted.clear();
    this.candidate = undefined;
    this.userAborted = false;
    this.requested = false;
    this.cancelled = false;
  }
  handle(event: AgentSessionEvent, manager: Manager): void {
    if (event.type === "agent_start") {
      this.userAborted = false;
      this.candidate = undefined;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      this.candidate = !this.userAborted && event.message.stopReason === "aborted"
        ? event.message
        : undefined;
    }
    if (event.type === "message_start" && event.message.role === "user")
      this.candidate = undefined;
    if (event.type === "agent_settled" && !this.active && !this.requested)
      this.candidate = undefined;
    if (event.type === "compaction_start") {
      this.cancelled = false;
      this.active = {
        startedAt: this.active?.startedAt ?? Date.now(),
        automatic: event.reason !== "manual",
        reason: event.reason,
      };
      if (this.candidate && !this.userAborted) {
        const entry = manager.getBranch().reverse().find((entry) =>
          entry.type === "message" && entry.message === this.candidate,
        );
        if (entry) this.interrupted.add(entry.id);
      }
    }
    if (event.type === "compaction_end") {
      this.cancelled = event.aborted;
      if (event.result && !event.aborted && !event.errorMessage) {
        const compaction = manager.getBranch().reverse().find((entry) => entry.type === "compaction");
        if (compaction)
          for (const assistantEntryId of this.interrupted)
            manager.appendCustomEntry(COMPACTION_INTERRUPTION_TYPE, {
              assistantEntryId,
              compactionEntryId: compaction.id,
            });
      }
      this.active = undefined;
      this.interrupted.clear();
      this.candidate = undefined;
      this.requested = false;
    }
  }
}
export function persistedCompactionInterruptions(entries: readonly unknown[]): Set<string> {
  const byId = new Map(entries.map((raw, index) => [object(raw).id, { entry: object(raw), index }]));
  const interrupted = new Set<string>();
  entries.forEach((raw, index) => {
    const entry = object(raw);
    if (entry.type !== "custom" || entry.customType !== COMPACTION_INTERRUPTION_TYPE) return;
    const data = object(entry.data);
    const assistant = byId.get(data.assistantEntryId);
    const compaction = byId.get(data.compactionEntryId);
    if (
      typeof data.assistantEntryId === "string" && assistant && compaction &&
      assistant.entry.type === "message" &&
      object(assistant.entry.message).role === "assistant" &&
      object(assistant.entry.message).stopReason === "aborted" &&
      compaction.entry.type === "compaction" &&
      assistant.index < compaction.index && compaction.index < index
    ) interrupted.add(data.assistantEntryId);
  });
  return interrupted;
}
