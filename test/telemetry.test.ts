import { describe, expect, test } from "bun:test";
import {
  projectUsage,
  projectAdvice,
  projectCompactions,
  projectUsageRequests,
} from "../src/core/telemetry.ts";

const assistant = (id: string, input = 10) => ({
  type: "message",
  id,
  message: {
    role: "assistant",
    provider: "openai-codex",
    model: "sol",
    usage: {
      input,
      output: 3,
      cacheRead: 20,
      cacheWrite: 0,
      cost: { total: 0.01 },
    },
  },
});

describe("usage evidence", () => {
  test("native fallback labels main-only coverage and missing usage", () => {
    const result = projectUsage([
      assistant("a"),
      {
        type: "message",
        id: "b",
        message: { role: "assistant", model: "sol", provider: "openai-codex" },
      },
    ]);
    expect(result.source).toBe("native");
    expect(result.coverage).toBe("main-only");
    expect(result.totals.input).toBe(10);
    expect(result.totals.cacheRead).toBe(20);
    expect(result.totals.missingUsage).toBe(1);
    expect(result.totals.cost).toBeCloseTo(0.01);
  });
  test("shared ledger replaces native totals rather than double counting", () => {
    const total = {
      tokens: { input: 100, output: 30, cacheRead: 200, cacheWrite: 0 },
      responses: 3,
      unreportedResponses: 1,
      unpricedResponses: 1,
      estimatedCost: 0.12,
    };
    const result = projectUsage([assistant("a")], {
      version: 1,
      totals: total,
      byModel: { "openai-codex/sol": total },
      byAgent: {},
      limitations: [],
    });
    expect(result.source).toBe("ledger");
    expect(result.totals.input).toBe(100);
    expect(result.totals.cost).toBe(0.12);
    expect(result.totals.unpriced).toBe(1);
  });
  test("zero or missing prices are not invented", () => {
    const row = assistant("a");
    row.message.usage.cost.total = 0;
    const result = projectUsage([row]);
    expect(result.totals.cost).toBeNull();
    expect(result.totals.unpriced).toBe(1);
  });
  test("invalid ledger is visible and falls back to actual native evidence", () => {
    const result = projectUsage([assistant("a")], {
      version: 1,
      totals: { input: 999 },
    });
    expect(result.source).toBe("native");
    expect(result.warning).toContain("ledger");
    expect(result.totals.input).toBe(10);
  });
});

test("notebooks are not advice and delivery never implies acceptance", () => {
  const entries = [
    {
      type: "custom",
      customType: "pi-omp-advisor-notebook",
      data: { advisor: "DeepSeek", text: "internal note" },
    },
    {
      type: "custom_message",
      id: "advice-1",
      customType: "pi-omp-advisor",
      timestamp: "2026-11-13T10:00:00Z",
      details: {
        notes: [{ id: "n1", advisor: "DeepSeek", text: "Check persistence" }],
      },
    },
  ];
  const notes = projectAdvice(entries);
  expect(notes).toHaveLength(1);
  expect(notes[0].text).toBe("Check persistence");
  expect(notes[0].status).toBe("delivered");
});

test("compaction preserves source and does not invent monetary savings", () => {
  const data = projectCompactions([
    {
      type: "compaction",
      id: "c1",
      tokensBefore: 94000,
      summary: "Saved intent",
      details: { summaryProvider: "openai-codex", summaryModel: "sol" },
    },
  ]);
  expect(data[0].before).toBe(94000);
  expect(data[0].model).toBe("sol");
  expect(data[0].after).toBeNull();
  expect(data[0].savedCost).toBeNull();
});

test("native per-request detail deduplicates response records and marks missing usage honestly", () => {
  const row = assistant("a");
  const missing = {
    type: "message",
    id: "b",
    message: { role: "assistant", provider: "p", model: "m", timestamp: 1 },
  };
  const records = projectUsageRequests([row, row, missing]);
  expect(records).toHaveLength(2);
  expect(records[0]!.usage).toEqual(projectUsage([row]).totals);
  expect(records[1]!.state).toBe("unreported");
  expect(records[1]!.usage.cost).toBeNull();
});

test("advisor feedback uses the latest valid judgment without changing delivery status", () => {
  const delivery = {
    type: "custom_message",
    id: "delivery",
    customType: "advisor",
    details: { notes: [{ id: "n1", text: "Check persistence" }] },
  };
  const feedback = (data: Record<string, unknown>) => ({
    type: "custom",
    customType: "pi-opentui-advisor-feedback",
    data: {
      noteId: "n1",
      rating: "useful",
      timestamp: "2026-11-13T10:00:00.000Z",
      source: "assistant",
      ...data,
    },
  });
  const entries = [
    delivery,
    feedback({}),
    feedback({
      rating: "harmful",
      source: "user",
      reason: "Did not fit the implementation",
    }),
    feedback({ rating: "accepted" }),
    feedback({ timestamp: "invalid" }),
    feedback({ source: "advisor" }),
    feedback({ reason: 1 }),
    feedback({ reason: "x".repeat(501) }),
  ];
  const note = projectAdvice(entries)[0]!;
  expect(note.status).toBe("delivered");
  expect(note.feedback).toEqual({
    rating: "harmful",
    reason: "Did not fit the implementation",
    timestamp: "2026-11-13T10:00:00.000Z",
    source: "user",
  });
  expect(projectAdvice([delivery])[0]?.feedback).toBeUndefined();
  expect(projectAdvice([
    {
      type: "custom",
      customType: "pi-omp-advisor-inbox",
      data: { items: [{ adviceId: "n1", note: "Pending" }] },
    },
    feedback({}),
    delivery,
  ])[0]?.feedback).toBeUndefined();
});
