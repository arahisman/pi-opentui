import { test, expect, spyOn } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Shell, type ShellState } from "../src/ui/shell.ts";
import { projectUsage } from "../src/core/telemetry.ts";
const state: ShellState = {
  project: "forge",
  title: "Cancellation & recovery",
  model: "Sol",
  reasoning: "medium",
  status: "idle",
  contextTokens: 61000,
  contextWindow: 500000,
  usage: projectUsage([]),
  advice: [],
  advisorAvailable: false,
};
test("real OpenTUI renders a single sidebar and preserves draft through resizing", async () => {
  const setup = await createTestRenderer({ width: 140, height: 40 });
  const shell = new Shell(setup.renderer, state, () => {});
  try {
    shell.addText(
      "m1",
      "Sol · medium",
      "Проверяю отмену и восстановление сессии.",
    );
    shell.editor.setText("Сохрани мой черновик");
    await setup.renderOnce();
    let frame = setup.captureCharFrame();
    expect(frame).toContain("Usage & context");
    expect(frame).toContain("Advisor history");
    expect(frame).toContain("61k / 500k");
    expect(frame).toContain("Проверяю отмену");
    setup.resize(65, 28);
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    expect(frame).not.toContain("Usage & context");
    expect(shell.editor.plainText).toBe("Сохрани мой черновик");
    setup.resize(160, 44);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Usage & context");
    expect(shell.editor.plainText).toBe("Сохрани мой черновик");
  } finally {
    shell.dispose();
    await setup.dispose();
  }
});

test("conversation prose/code remain readable and non-user cards do not gain accidental borders", async () => {
  const setup = await createTestRenderer({ width: 120, height: 35 });
  const shell = new Shell(setup.renderer, state, () => {});
  try {
    shell.setTranscript([
      {
        id: "user:0",
        entryId: "user",
        kind: "text",
        role: "user",
        text: "Проверь исходную задачу.",
      },
      {
        id: "answer:0",
        entryId: "answer",
        kind: "text",
        role: "assistant",
        text: "Нормальный текст перед кодом.\n\n```ts\nconst value = 42;\n```\n\nИ текст после кода.",
      },
    ]);
    for (let attempt = 0; attempt < 200; attempt++) {
      await setup.renderOnce();
      if (setup.captureCharFrame().includes("И текст после кода.")) break;
      await Bun.sleep(20);
    }
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Проверь исходную задачу.");
    expect(frame).toContain("Нормальный текст перед кодом.");
    expect(frame).toContain("const value = 42;");
    expect(frame).toContain("И текст после кода.");
    const assistant = shell.transcript
      .getChildren()
      .find(
        (row) => row.id === "card:answer:0",
      ) as import("@opentui/core").BoxRenderable;
    expect(assistant.border).toBe(false);
  } finally {
    shell.dispose();
    await setup.dispose();
  }
});

test("jump reveals an old message beyond multiple history windows and keeps unknown branches explicit", async () => {
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const shell = new Shell(setup.renderer, state, () => {});
  try {
    shell.setTranscript(
      Array.from({ length: 50010 }, (_, i) => ({
        id: `entry-${i}:0`,
        entryId: `entry-${i}`,
        kind: "text" as const,
        role: "user",
        text: `Historical message ${i}`,
      })),
    );
    await setup.renderOnce();
    expect(
      shell.transcript
        .getChildren()
        .some((child) => child.id === "card:entry-3:0"),
    ).toBe(false);
    expect(shell.revealEntry("entry-3")).toBe(true);
    for (let attempt = 0; attempt < 100; attempt++) {
      await setup.renderOnce();
      if (setup.captureCharFrame().includes("Historical message 3")) break;
      await Bun.sleep(20);
    }
    expect(setup.captureCharFrame()).toContain("Historical message 3");
    const cards = shell.transcript
      .getChildren()
      .filter((child) => child.id.startsWith("card:"));
    expect(cards.length).toBeLessThanOrEqual(200);
    expect(cards.some((card) => card.id === "card:entry-3:0")).toBe(true);
    shell.jumpLatest();
    await setup.renderOnce();
    expect(shell.transcript.getChildren().at(-1)!.id).toBe(
      "card:entry-50009:0",
    );
    expect(shell.revealEntry("different-branch")).toBe(false);
  } finally {
    shell.dispose();
    await setup.dispose();
  }
});

test("linked tool results share one card, remain reachable and render edit colors", async () => {
  const setup = await createTestRenderer({ width: 120, height: 35 });
  const shell = new Shell(setup.renderer, state, () => {});
  try {
    shell.setTranscript([
      {
        id: "call:0",
        entryId: "call",
        kind: "toolCall",
        role: "assistant",
        text: "edit",
        toolName: "edit",
        arguments: { path: "sample.ts" },
      },
      {
        id: "result:0",
        entryId: "result",
        kind: "toolResult",
        role: "toolResult",
        text: "Updated sample.ts",
        toolName: "edit",
        resultFor: "call:0",
        diff: "-const value = 1;\n+const value = 2;",
      },
    ]);
    expect(
      shell.transcript
        .getChildren()
        .filter((child) => child.id.startsWith("card:")).length,
    ).toBe(1);
    expect(shell.revealEntry("result")).toBe(true);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Updated sample.ts");
    expect(setup.captureCharFrame()).toContain("+const value = 2;");
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    const added = spans.find((span) => span.text.includes("+const value = 2;"));
    expect(added?.fg.toInts().slice(0, 3)).toEqual([184, 219, 135]);
    expect(added?.bg.toInts().slice(0, 3)).toEqual([32, 48, 59]);
  } finally {
    shell.dispose();
    await setup.dispose();
  }
});

test("saved anchored history restores across a tail visit and resize without rendering the whole session", async () => {
  const setup = await createTestRenderer({ width: 120, height: 32 });
  const shell = new Shell(setup.renderer, state, () => {});
  try {
    shell.toolsExpanded = true;
    shell.setTranscript(
      Array.from({ length: 800 }, (_, i) => ({
        id: `event-${i}:0`,
        entryId: `event-${i}`,
        kind: "toolResult" as const,
        role: "toolResult",
        toolName: "read",
        text: `Output for historical entry ${i}`,
      })),
    );
    await setup.renderOnce();
    expect(shell.revealEntry("event-110")).toBe(true);
    await setup.renderOnce();
    const saved = shell.captureNavigation();
    expect(saved.followLatest).toBe(false);
    expect(saved.anchorRowId).toBe("event-110:0");
    shell.jumpLatest();
    await setup.renderOnce();
    expect(shell.captureNavigation().followLatest).toBe(true);
    setup.resize(78, 26);
    shell.restoreNavigation(saved);
    await setup.renderOnce();
    await setup.renderOnce();
    expect(shell.captureNavigation().anchorRowId).toBe(saved.anchorRowId);
    expect(setup.captureCharFrame()).toContain(
      "Output for historical entry 110",
    );
    expect(shell.transcript.getChildren().length).toBeLessThanOrEqual(200);
  } finally {
    shell.dispose();
    await setup.dispose();
  }
});


test("advisor sidebar shows newest first, ages, ratings and a separate local review state", async () => {
  const setup = await createTestRenderer({ width: 160, height: 60 });
  let now = Date.parse("2026-01-02T00:00:00Z");
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const advice: ShellState["advice"] = [
    { id: "old", advisor: "Advisor", model: "test", title: "Older advice", text: "old text", timestamp: new Date(now - 3600_000).toISOString(), status: "delivered", entryId: "old" },
    { id: "new", advisor: "Advisor", model: "test", title: "Newest advice", text: "new text", timestamp: new Date(now - 59_000).toISOString(), status: "delivered", entryId: "new", feedback: { rating: "harmful", source: "assistant", reason: "Wrong premise", timestamp: new Date(now).toISOString() } },
    { id: "pending", advisor: "Advisor", model: "test", title: "Undated advice", text: "pending text", timestamp: "", status: "pending", entryId: "pending" },
  ];
  const current = { ...state, advice, reviewedAdvice: ["new"] };
  const shell = new Shell(setup.renderer, current, () => {});
  try {
    const block = shell.sidebar.getChildren().find((child) => child.id === "advisor-block")!;
    const content = block.getChildren()[0] as import("@opentui/core").TextRenderable;
    expect(content.plainText.indexOf("Newest advice")).toBeLessThan(content.plainText.indexOf("Older advice"));
    expect(content.plainText).toContain("59 seconds ago");
    expect(content.plainText).toContain("1 hour ago");
    expect(content.plainText).toContain("Age unknown");
    expect(content.plainText).toContain("Executor feedback: harmful · Wrong premise");
    expect(content.plainText).toContain("✓ Reviewed locally");
    const unchanged = content.content;
    now += 300;
    shell.update(current);
    expect(content.content).toBe(unchanged);
    now += 700;
    shell.update(current);
    expect(content.plainText).toContain("1 minute ago");
    expect(advice.map((note) => note.id)).toEqual(["old", "new", "pending"]);
    setup.resize(160, 28);
    await setup.renderOnce();
    shell.sidebar.scrollTo(8);
    await setup.renderOnce();
    const scrollTop = shell.sidebar.scrollTop;
    expect(scrollTop).toBeGreaterThan(0);
    now += 60_000;
    shell.update(current);
    await setup.renderOnce();
    expect(shell.sidebar.scrollTop).toBe(scrollTop);
  } finally {
    clock.mockRestore();
    shell.dispose();
    await setup.dispose();
  }
});
