import { expect, test } from "bun:test";
import type { AdviceNote } from "../src/core/telemetry.ts";
import { adviceAge, adviceFeedback, newestAdvice } from "../src/ui/advisor-history.ts";

const note = (id: string, timestamp: string): AdviceNote => ({
  id, timestamp, advisor: "Advisor", title: id, text: id, model: "fixture",
  status: "delivered", entryId: id,
});

test("advice history sorts immutably with stable equal and unknown timestamps", () => {
  const notes = [
    note("unknown-a", ""),
    note("old", "2026-01-01T00:00:00Z"),
    note("new-a", "2026-01-02T00:00:00Z"),
    note("unknown-b", "bad date"),
    note("new-b", "2026-01-02T00:00:00Z"),
  ];
  const original = [...notes];
  expect(newestAdvice(notes).map((item) => item.id)).toEqual([
    "new-a", "new-b", "old", "unknown-a", "unknown-b",
  ]);
  expect(notes).toEqual(original);
});

test("advice ages use seconds, minutes and hours with explicit missing or future times", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  const age = (seconds: number) => adviceAge(new Date(now - seconds * 1000).toISOString(), now);
  expect(age(0)).toBe("0 seconds ago");
  expect(age(1)).toBe("1 second ago");
  expect(age(59)).toBe("59 seconds ago");
  expect(age(60)).toBe("1 minute ago");
  expect(age(3599)).toBe("59 minutes ago");
  expect(age(3600)).toBe("1 hour ago");
  expect(age(86400)).toBe("24 hours ago");
  expect(age(-1)).toBe("In the future");
  expect(adviceAge("", now)).toBe("Age unknown");
  expect(adviceAge("bad date", now)).toBe("Age unknown");
});

test("executor and user ratings retain their source and optional reason", () => {
  const advice = note("rated", "");
  expect(adviceFeedback(advice)).toBeUndefined();
  advice.feedback = { rating: "harmful", source: "assistant", reason: "Incorrect premise", timestamp: "" };
  expect(adviceFeedback(advice)).toBe("Executor feedback: harmful · Incorrect premise");
  advice.feedback = { rating: "useful", source: "user", timestamp: "" };
  expect(adviceFeedback(advice)).toBe("User feedback: useful");
});
