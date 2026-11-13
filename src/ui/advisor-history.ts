import type { AdviceNote } from "../core/telemetry.ts";

export function newestAdvice(notes: readonly AdviceNote[]): AdviceNote[] {
  return notes
    .map((note, index) => ({ note, index, time: Date.parse(note.timestamp) }))
    .sort((a, b) => {
      const aKnown = Number.isFinite(a.time);
      const bKnown = Number.isFinite(b.time);
      if (aKnown && bKnown) return b.time - a.time || a.index - b.index;
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ note }) => note);
}

export function adviceAge(timestamp: string, now = Date.now()): string {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return "Age unknown";
  if (time > now) return "In the future";
  const seconds = Math.floor((now - time) / 1000);
  if (seconds < 60) return `${seconds} ${seconds === 1 ? "second" : "seconds"} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
}

export function adviceFeedback(note: AdviceNote): string | undefined {
  if (!note.feedback) return undefined;
  const source = note.feedback.source === "assistant" ? "Executor" : "User";
  return `${source} feedback: ${note.feedback.rating}${note.feedback.reason ? ` · ${note.feedback.reason}` : ""}`;
}
