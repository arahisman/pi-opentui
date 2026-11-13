import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable } from "@opentui/core";
import { Shell, type ShellState } from "../src/ui/shell.ts";
import { projectUsage } from "../src/core/telemetry.ts";
import type { TranscriptItem } from "../src/core/session-data.ts";
const state: ShellState = {
  project: "forge",
  title: "Presentation",
  model: "Sol",
  reasoning: "medium",
  status: "working",
  contextTokens: 12000,
  contextWindow: 500000,
  usage: projectUsage([]),
  advice: [],
  advisorAvailable: false,
};

test("action modes show a bounded preview, full output or header only with distinct action colors", async () => {
  const setup = await createTestRenderer({ width: 140, height: 45 });
  const shell = new Shell(setup.renderer, state, () => {});
  const rows: TranscriptItem[] = [
    {
      id: "read:0",
      entryId: "read",
      kind: "toolCall",
      role: "assistant",
      toolName: "read",
      text: "read",
      arguments: { path: "example.ts" },
    },
    {
      id: "read:result",
      entryId: "result",
      kind: "toolResult",
      role: "toolResult",
      toolName: "read",
      resultFor: "read:0",
      text: Array.from({ length: 12 }, (_, i) => `output-line-${i}`).join("\n"),
    },
    {
      id: "code:0",
      entryId: "code",
      kind: "toolCall",
      role: "assistant",
      toolName: "codemode",
      text: "codemode",
      arguments: { code: "const value = 42;" },
    },
  ];
  try {
    shell.setTranscript(rows);
    await setup.renderOnce();
    let frame = setup.captureCharFrame();
    expect(frame).toContain("output-line-0");
    expect(frame).not.toContain("output-line-11");
    expect(frame).toContain("const value = 42;");
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    expect(
      spans.some(
        (span) =>
          span.text.includes("read") &&
          span.fg.toInts().slice(0, 3).join() === "127,216,143",
      ),
    ).toBe(true);
    expect(
      spans.some(
        (span) =>
          span.text.includes("codemode") &&
          span.fg.toInts().slice(0, 3).join() === "245,167,66",
      ),
    ).toBe(true);
    shell.setToolDisplay("full");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("output-line-11");
    shell.setToolDisplay("collapsed");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    expect(frame).not.toContain("output-line-0");
    expect(frame).toContain("read");
    const toggle = setup.renderer.root.findDescendantById("tool-display-mode")!;
    await setup.mockMouse.click(toggle.x + 1, toggle.y);
    await setup.renderOnce();
    expect(shell.toolDisplay).toBe("compact");
    setup.resize(68, 28);
    await setup.renderOnce();
    expect(toggle.x + toggle.width).toBeLessThanOrEqual(68);
    setup.resize(30, 18);
    await setup.renderOnce();
    expect(toggle.x + toggle.width).toBeLessThanOrEqual(30);
  } finally {
    shell.dispose();
    await setup.dispose();
  }
});

test("working animation keeps the project column fixed and uses several palette colors", async () => {
  const setup = await createTestRenderer({ width: 140, height: 30 });
  const shell = new Shell(setup.renderer, state, () => {});
  try {
    const positions: number[] = [];
    const colors = new Set<string>();
    for (let frame = 0; frame < 5; frame++) {
      shell.update({
        ...state,
        workingMessage: "Working",
        workingGlyph: "●●●",
        workingFrame: frame,
      });
      await setup.renderOnce();
      const line = setup
        .captureCharFrame()
        .split("\n")
        .find((line) => line.includes("ctrl+p commands"))!;
      positions.push(line.indexOf("forge"));
      for (const span of setup.captureSpans().lines.at(-1)!.spans)
        if (span.text.includes("●")) colors.add(span.fg.toInts().join());
    }
    expect(new Set(positions).size).toBe(1);
    expect(colors.size).toBeGreaterThan(2);
  } finally {
    shell.dispose();
    await setup.dispose();
  }
});

test("system and extension blocks are framed, registered hidden entries stay absent, sidebar has separate sections", async () => {
  const setup = await createTestRenderer({ width: 140, height: 65 });
  const shell = new Shell(setup.renderer, state, () => {});
  try {
    shell.thinkingExpanded = true;
    shell.renderCustomBlock = (row) => (row.customEntry ? [] : undefined);
    shell.setTranscript([
      ...(
        [
          "compaction",
          "branchSummary",
          "custom",
          "thinking",
          "error",
          "image",
        ] as const
      ).map((kind) => ({
        id: kind,
        entryId: kind,
        kind,
        role: kind === "thinking" ? "assistant" : "system",
        text:
          kind === "compaction"
            ? "Summary\n<read-files>\nexample.ts\n</read-files>"
            : `Body ${kind}`,
      })),
      {
        id: "hidden",
        entryId: "hidden",
        kind: "custom",
        role: "custom",
        text: "",
        customType: "private",
        customEntry: { type: "custom", customType: "private", data: {} },
      } as TranscriptItem,
    ]);
    await setup.renderOnce();
    for (const kind of [
      "compaction",
      "branchSummary",
      "custom",
      "thinking",
      "error",
      "image",
    ])
      expect(
        (shell.transcript.getRenderable(`card:${kind}`) as BoxRenderable)
          .border,
      ).toEqual(["left"]);
    expect(!!shell.transcript.getRenderable("card:hidden")).toBe(false);
    for (const id of [
      "context-block",
      "model-usage-block",
      "coverage-block",
      "advisor-block",
    ])
      expect(setup.renderer.root.findDescendantById(id)).toBeDefined();
  } finally {
    shell.dispose();
    await setup.dispose();
  }
});
