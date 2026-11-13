import {
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  TextareaRenderable,
  MarkdownRenderable,
  CodeRenderable,
  SyntaxStyle,
  RGBA,
  StyledText,
  type CliRenderer,
} from "@opentui/core";
import { ansiToStyledText } from "./ansi.ts";
import { adviceAge, adviceFeedback, newestAdvice } from "./advisor-history.ts";
import type { TranscriptItem } from "../core/session-data.ts";
import type { SessionNavigation } from "../core/ui-store.ts";
import { palette as p } from "../theme.ts";
import {
  formatTokens,
  formatCost,
  type UsageProjection,
  type AdviceNote,
} from "../core/telemetry.ts";
export interface ShellState {
  project: string;
  title: string;
  model: string;
  reasoning: string;
  status: string;
  contextTokens: number | null;
  contextWindow: number | null;
  usage: UsageProjection;
  advice: AdviceNote[];
  advisorAvailable: boolean;
  reviewedAdvice?: string[];
  compactionCount?: number;
  lastCompactionBefore?: number;
  workingMessage?: string;
  workingFrame?: number;
  workingGlyph?: string;
}
export type ToolDisplay = "collapsed" | "compact" | "full";

export class Shell {
  readonly root: BoxRenderable;
  readonly transcript: ScrollBoxRenderable;
  readonly sidebar: ScrollBoxRenderable;
  readonly editor: TextareaRenderable;
  private nativeEditor: TextRenderable;
  private readonly extensionAbove: ScrollBoxRenderable;
  private readonly extensionBelow: ScrollBoxRenderable;
  private readonly extensionHeader: TextRenderable;
  private readonly extensionFooter: TextRenderable;
  private composer: BoxRenderable;
  private readonly heading: TextRenderable;
  private readonly toolModeButton: TextRenderable;
  onToolDisplayChange?: (mode: ToolDisplay) => void;
  renderCustomBlock?: (
    row: TranscriptItem,
    expanded: boolean,
    width: number,
  ) => string[] | undefined;
  private readonly footer: TextRenderable;
  private readonly model: TextRenderable;
  private readonly usage: TextRenderable;
  private readonly advice: TextRenderable;
  private readonly usageModels: TextRenderable;
  private readonly usageCoverage: TextRenderable;
  private readonly cards = new Map<
    string,
    {
      box: BoxRenderable;
      label: TextRenderable;
      body: TextRenderable | MarkdownRenderable;
      signature: string;
    }
  >();
  private readonly syntax: SyntaxStyle;
  private transcriptRows: TranscriptItem[] = [];
  private linkedResults: ReadonlyMap<string, TranscriptItem> = new Map();
  private expanded = new Set<string>();
  thinkingExpanded = false;
  toolDisplay: ToolDisplay = "compact";
  private leaderMode = false;
  get toolsExpanded() {
    return this.toolDisplay === "full";
  }
  set toolsExpanded(value: boolean) {
    this.toolDisplay = value ? "full" : "compact";
  }
  setToolDisplay(mode: ToolDisplay) {
    this.toolDisplay = mode;
    this.updateToolMode();
    this.setTranscript(this.transcriptRows);
    this.onToolDisplayChange?.(mode);
  }
  private updateToolMode() {
    this.toolModeButton.content = ` Actions: ${this.toolDisplay} ▾ `;
  }
  setLeaderMode(active: boolean) {
    this.leaderMode = active;
    this.composer.borderColor = active ? p.borderActive : p.primary;
    this.model.fg = active ? p.textMuted : p.primary;
    this.composer.backgroundColor = active
      ? p.backgroundPanel
      : p.backgroundElement;
    this.editor.backgroundColor = active
      ? p.backgroundPanel
      : p.backgroundElement;
    this.renderer.requestRender();
  }
  historyLimit = 200;
  private historyEnd?: number;
  private historyStart = 0;
  private releaseAnchor?: () => void;
  private navigationGeneration = 0;
  private adviceState?: {
    notes: AdviceNote[];
    reviewed?: string[];
    available: boolean;
    ages: string;
  };
  sidebarRequested = true;
  private sidebarFloating = false;
  private readonly body: BoxRenderable;
  private readonly resizeHandler: () => void;
  constructor(
    readonly renderer: CliRenderer,
    state: ShellState,
    onSubmit: (text: string) => void,
  ) {
    this.syntax = SyntaxStyle.fromStyles(
      {
        default: { fg: p.text },
        keyword: { fg: p.syntaxKeyword },
        string: { fg: p.syntaxString },
        number: { fg: p.syntaxNumber },
        comment: { fg: p.syntaxComment },
        function: { fg: p.syntaxFunction },
        type: { fg: p.syntaxType },
        "markup.heading": { fg: p.accent, bold: true },
        "markup.strong": { fg: p.warning, bold: true },
        "markup.raw": { fg: p.success },
        "markup.link": { fg: p.info },
      },
      renderer.nativeScene,
    );
    this.root = new BoxRenderable(renderer, {
      id: "pi-opentui",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: p.background,
    });
    const topbar = new BoxRenderable(renderer, {
      id: "topbar",
      height: 2,
      flexShrink: 0,
      flexDirection: "row",
    });
    this.heading = new TextRenderable(renderer, {
      id: "heading",
      height: 1,
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      fg: p.text,
      content: "",
      truncate: true,
    });
    this.toolModeButton = new TextRenderable(renderer, {
      id: "tool-display-mode",
      height: 1,
      width: 24,
      flexShrink: 0,
      fg: p.info,
      bg: p.backgroundElement,
      content: "",
      truncate: true,
      onMouseDown: () => {
        const modes: ToolDisplay[] = ["collapsed", "compact", "full"];
        this.setToolDisplay(
          modes[(modes.indexOf(this.toolDisplay) + 1) % modes.length]!,
        );
      },
    });
    topbar.add(this.heading);
    topbar.add(this.toolModeButton);
    this.root.add(topbar);
    this.extensionHeader = new TextRenderable(renderer, {
      content: "",
      visible: false,
      fg: p.text,
      wrapMode: "word",
      maxHeight: 4,
    });
    this.root.add(this.extensionHeader);
    this.body = new BoxRenderable(renderer, {
      id: "body",
      flexGrow: 1,
      flexDirection: "row",
      minHeight: 0,
    });
    this.root.add(this.body);
    const main = new BoxRenderable(renderer, {
      id: "main",
      flexGrow: 1,
      minWidth: 0,
      flexDirection: "column",
      paddingX: 2,
    });
    this.body.add(main);
    this.transcript = new ScrollBoxRenderable(renderer, {
      id: "transcript",
      flexGrow: 1,
      minHeight: 0,
      scrollY: true,
      scrollX: false,
      stickyScroll: true,
      stickyStart: "bottom",
      viewportCulling: true,
      contentOptions: { flexDirection: "column", gap: 1 },
    });
    main.add(this.transcript);
    this.extensionAbove = new ScrollBoxRenderable(renderer, {
      visible: false,
      height: 0,
      scrollY: true,
      scrollX: false,
      contentOptions: { flexDirection: "column" },
    });
    main.add(this.extensionAbove);
    const composer = (this.composer = new BoxRenderable(renderer, {
      id: "composer",
      height: 6,
      border: ["left"],
      borderColor: p.primary,
      backgroundColor: p.backgroundElement,
      paddingX: 1,
      marginTop: 1,
      marginBottom: 1,
      flexDirection: "column",
    }));
    main.add(composer);
    this.editor = new TextareaRenderable(renderer, {
      id: "editor",
      height: 3,
      width: "100%",
      backgroundColor: p.backgroundElement,
      textColor: p.text,
      placeholder: "Напиши сообщение…",
      placeholderColor: p.textMuted,
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "return", shift: true, action: "newline" },
        { name: "return", ctrl: true, action: "newline" },
      ],
      onSubmit: () => {
        const text = this.editor.plainText;
        if (text.trim()) onSubmit(text);
      },
    });
    composer.add(this.editor);
    this.nativeEditor = new TextRenderable(renderer, {
      id: "native-editor",
      content: "",
      visible: false,
      fg: p.text,
      wrapMode: "none",
    });
    composer.add(this.nativeEditor);
    this.model = new TextRenderable(renderer, {
      height: 1,
      fg: p.primary,
      truncate: true,
      content: "",
    });
    composer.add(this.model);
    this.extensionBelow = new ScrollBoxRenderable(renderer, {
      visible: false,
      height: 0,
      scrollY: true,
      scrollX: false,
      contentOptions: { flexDirection: "column" },
    });
    main.add(this.extensionBelow);
    this.sidebar = new ScrollBoxRenderable(renderer, {
      id: "sidebar",
      width: 38,
      flexShrink: 0,
      border: ["left"],
      borderColor: p.borderSubtle,
      paddingX: 2,
      scrollY: true,
      scrollX: false,
      contentOptions: { flexDirection: "column", gap: 1 },
    });
    this.body.add(this.sidebar);
    this.usage = new TextRenderable(renderer, {
      id: "usage",
      fg: p.text,
      wrapMode: "word",
      content: "",
    });
    const section = (id: string, text: TextRenderable) => {
      const box = new BoxRenderable(renderer, {
        id,
        border: ["bottom"],
        borderColor: p.borderSubtle,
        paddingBottom: 1,
        flexDirection: "column",
        flexShrink: 0,
      });
      box.add(text);
      this.sidebar.add(box);
      return box;
    };
    section("context-block", this.usage);
    this.usageModels = new TextRenderable(renderer, {
      id: "model-usage",
      content: "",
      wrapMode: "word",
      fg: p.text,
    });
    section("model-usage-block", this.usageModels);
    this.usageCoverage = new TextRenderable(renderer, {
      id: "usage-coverage",
      content: "",
      wrapMode: "word",
      fg: p.textMuted,
    });
    section("coverage-block", this.usageCoverage);
    this.advice = new TextRenderable(renderer, {
      id: "advice",
      fg: p.text,
      wrapMode: "word",
      content: "",
    });
    const adviceBlock = new BoxRenderable(renderer, {
      id: "advisor-block",
      backgroundColor: p.backgroundPanel,
      padding: 1,
      flexDirection: "column",
      flexShrink: 0,
    });
    adviceBlock.add(this.advice);
    this.sidebar.add(adviceBlock);
    this.footer = new TextRenderable(renderer, {
      id: "footer",
      height: 1,
      fg: p.textMuted,
      truncate: true,
      content: "",
    });
    this.root.add(this.footer);
    this.extensionFooter = new TextRenderable(renderer, {
      content: "",
      visible: false,
      fg: p.textMuted,
      wrapMode: "word",
      maxHeight: 3,
    });
    this.root.add(this.extensionFooter);
    renderer.root.add(this.root);
    this.resizeHandler = () => this.resize();
    renderer.on("resize", this.resizeHandler);
    this.update(state);
    this.editor.focus();
    this.resize();
  }
  update(state: ShellState) {
    this.heading.content = ` pi / ${state.project}    │    ${state.title}`;
    this.model.content = `${state.model} · ${state.reasoning}     enter send · shift+enter newline`;
    this.updateToolMode();
    const colors = [p.primary, p.warning, p.info, p.secondary, p.accent];
    const active = state.workingMessage !== undefined;
    const frame = state.workingFrame ?? 0;
    const chunks = [
      {
        __isChunk: true as const,
        text: active ? " " : " ● ",
        fg: RGBA.fromHex(
          state.status === "waiting for input" ? p.warning : p.success,
        ),
      },
      ...(active
        ? Array.from(state.workingGlyph ?? "●●●", (glyph, i) => ({
            __isChunk: true as const,
            text: glyph,
            fg: RGBA.fromHex(colors[(frame + i) % colors.length]!),
          }))
        : []),
      {
        __isChunk: true as const,
        text: `${active ? " " : ""}${(state.workingMessage ?? state.status).slice(0, 32).padEnd(32)} │ ${state.project}    ctrl+p commands`,
        fg: RGBA.fromHex(p.textMuted),
      },
    ];
    this.footer.content = new StyledText(chunks);
    const tokens = state.contextTokens,
      window = state.contextWindow;
    const context =
      tokens === null
        ? "Context —"
        : `Context ${formatTokens(tokens)}${window ? ` / ${formatTokens(window)} · ${Math.round((tokens / window) * 100)}%` : ""}`;
    const filled =
      tokens !== null && window
        ? Math.max(0, Math.min(18, Math.round((tokens / window) * 18)))
        : null;
    const gauge =
      filled === null ? "" : `${"━".repeat(filled)}${"─".repeat(18 - filled)}`;
    const rows = Object.entries(state.usage.byModel).map(
      ([name, u]) => `${name.split("/").at(-1)}   ${formatCost(u.cost)}`,
    );
    const usageLines = [
      "Usage & context",
      context,
      ...(gauge ? [gauge] : []),
      `Cache read ${formatTokens(state.usage.totals.cacheRead)} · write ${formatTokens(state.usage.totals.cacheWrite)}`,
      ...(state.compactionCount
        ? [
            `Compactions ${state.compactionCount}${state.lastCompactionBefore ? ` · last ${formatTokens(state.lastCompactionBefore)} before` : ""}`,
          ]
        : []),
      "",
      "Usage by model",
      ...rows,
      `Total   ${formatCost(state.usage.totals.cost)}`,
      ...(state.usage.totals.missingUsage
        ? [`${state.usage.totals.missingUsage} responses without usage`]
        : []),
      ...(state.usage.totals.unpriced
        ? [`${state.usage.totals.unpriced} responses without price`]
        : []),
      "",
      "Coverage",
      state.usage.coverage === "main-only"
        ? "Main session only"
        : "Session + reported children",
      "API equivalent · not quota",
    ];
    const styleLines = (lines: string[]) =>
      new StyledText(
        lines.flatMap((line, index) => {
          const newline = index < lines.length - 1 ? "\n" : "";
          if (line === gauge && filled !== null)
            return [
              {
                __isChunk: true as const,
                text: "█".repeat(filled),
                fg: RGBA.fromHex(p.info),
              },
              {
                __isChunk: true as const,
                text: "░".repeat(18 - filled) + newline,
                fg: RGBA.fromHex(p.border),
              },
            ];
          return [
            {
              __isChunk: true as const,
              text: line + newline,
              fg: RGBA.fromHex(
                line.startsWith("Total")
                  ? p.primary
                  : ["Usage & context", "Usage by model", "Coverage"].includes(
                        line,
                      )
                    ? p.info
                    : /without (usage|price)/.test(line)
                      ? p.warning
                      : line.startsWith("Cache") ||
                          line.startsWith("Compactions") ||
                          line.includes("quota") ||
                          line.includes("session") ||
                          line.includes("Session")
                        ? p.textMuted
                        : p.text,
              ),
            },
          ];
        }),
      );
    const modelIndex = usageLines.indexOf("Usage by model");
    const coverageIndex = usageLines.indexOf("Coverage");
    this.usage.content = styleLines(usageLines.slice(0, modelIndex - 1));
    this.usageModels.content = styleLines(
      usageLines.slice(modelIndex, coverageIndex - 1),
    );
    this.usageCoverage.content = styleLines(usageLines.slice(coverageIndex));
    const now = Date.now();
    const ages = state.advice
      .map((note) => adviceAge(note.timestamp, now))
      .join("\n");
    if (
      this.adviceState?.notes !== state.advice ||
      this.adviceState?.reviewed !== state.reviewedAdvice ||
      this.adviceState?.available !== state.advisorAvailable ||
      (this.adviceState?.ages !== ages && !this.renderer.getSelection())
    ) {
      this.adviceState = {
        notes: state.advice,
        reviewed: state.reviewedAdvice,
        available: state.advisorAvailable,
        ages,
      };
      const lines: { text: string; color: string }[] = [
        { text: "Advisor history", color: p.accent },
      ];
      if (state.advisorAvailable || state.advice.length) {
        for (const note of newestAdvice(state.advice)) {
          lines.push(
            { text: "", color: p.text },
            {
              text: `${note.advisor} · ${note.status}`,
              color: note.status === "pending" ? p.warning : p.info,
            },
            { text: adviceAge(note.timestamp, now), color: p.textMuted },
            { text: note.title, color: p.primary },
            { text: note.text, color: p.text },
          );
          const feedback = adviceFeedback(note);
          if (feedback)
            lines.push({
              text: feedback,
              color: note.feedback?.rating === "harmful" ? p.warning : p.success,
            });
          if (state.reviewedAdvice?.includes(note.id))
            lines.push({ text: "✓ Reviewed locally", color: p.textMuted });
        }
        if (!state.advice.length)
          lines.push({ text: "No suggestions recorded.", color: p.textMuted });
      } else
        lines.push(
          { text: "Advisor is not enabled.", color: p.textMuted },
          { text: "No suggestions recorded.", color: p.textMuted },
        );
      this.advice.content = new StyledText(
        lines.map((line, i) => ({
          __isChunk: true as const,
          text: line.text + (i < lines.length - 1 ? "\n" : ""),
          fg: RGBA.fromHex(line.color),
        })),
      );
    }
    this.renderer.requestRender();
  }
  addText(id: string, label: string, text: string, color: string = p.text) {
    const card = new BoxRenderable(this.renderer, {
      id,
      flexDirection: "column",
      gap: 0,
      paddingBottom: 1,
    });
    card.add(
      new TextRenderable(this.renderer, {
        content: label,
        fg: color,
        height: 1,
        truncate: true,
      }),
    );
    const content = new TextRenderable(this.renderer, {
      content: text,
      fg: p.text,
      wrapMode: "word",
    });
    card.add(content);
    this.transcript.add(card);
    return content;
  }
  setExtensionWidgets(
    above: string[],
    below: string[],
    header: string[],
    footer: string[],
  ) {
    const update = (box: ScrollBoxRenderable, lines: string[]) => {
      let text = box.getChildren()[0] as TextRenderable | undefined;
      if (!text) {
        text = new TextRenderable(this.renderer, {
          content: "",
          fg: p.text,
          wrapMode: "word",
        });
        box.add(text);
      }
      text.content = ansiToStyledText(lines);
      box.visible = lines.length > 0;
      box.height = lines.length
        ? Math.min(
            lines.length,
            Math.max(2, Math.floor(this.renderer.height / 5)),
          )
        : 0;
    };
    update(this.extensionAbove, above);
    update(this.extensionBelow, below);
    this.extensionHeader.visible = header.length > 0;
    this.extensionHeader.content = ansiToStyledText(header);
    this.extensionFooter.visible = footer.length > 0;
    this.extensionFooter.content = ansiToStyledText(footer);
  }
  addEditorAccessory(node: TextRenderable) {
    this.composer.parent!.insertBefore(node, this.composer);
  }
  get editorWidth() {
    return Math.max(1, this.composer.width - 3);
  }
  setNativeEditor(lines: string[]) {
    this.editor.visible = false;
    this.nativeEditor.visible = true;
    this.nativeEditor.content = ansiToStyledText(lines);
    this.nativeEditor.height = Math.max(1, lines.length);
    this.composer.height = Math.min(
      Math.max(4, this.renderer.height - 8),
      lines.length + 2,
    );
  }
  setTranscript(
    rows: TranscriptItem[],
    linkedResults?: ReadonlyMap<string, TranscriptItem>,
  ) {
    if (linkedResults) this.linkedResults = linkedResults;
    else if (rows !== this.transcriptRows)
      this.linkedResults = new Map(
        rows.filter((row) => row.resultFor).map((row) => [row.resultFor!, row]),
      );
    this.transcriptRows = rows;
    const window: TranscriptItem[] = [];
    let start = Math.min(this.historyEnd ?? rows.length, rows.length);
    while (start > 0 && window.length < this.historyLimit) {
      const row = rows[--start]!;
      if (row.kind !== "thinking" || this.thinkingExpanded) window.push(row);
    }
    this.historyStart = start;
    window.reverse();
    const results = this.linkedResults;
    const calls = new Set(
      window.filter((row) => row.kind === "toolCall").map((row) => row.id),
    );
    const visible = window.filter(
      (row) => !row.resultFor || !calls.has(row.resultFor),
    );
    const wanted = new Set(visible.map((row) => row.id));
    for (const [id, card] of this.cards)
      if (!wanted.has(id)) {
        this.transcript.remove(card.box);
        card.box.destroyRecursively();
        this.cards.delete(id);
      }
    if (!visible.length && !this.cards.has("welcome")) {
      const box = new BoxRenderable(this.renderer, {
        id: "welcome",
        height: 12,
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        marginTop: 3,
        gap: 1,
      });
      const label = new TextRenderable(this.renderer, {
        content: "▐▀▀▌ ▀  \n▐▀▀  █  ",
        fg: p.primary,
        height: 3,
      });
      const body = new TextRenderable(this.renderer, {
        content: "Что будем делать?",
        fg: p.textMuted,
        height: 1,
      });
      box.add(label);
      box.add(body);
      this.transcript.add(box);
      this.cards.set("welcome", { box, label, body, signature: "" });
    }
    for (const [rowIndex, row] of visible.entries()) {
      const tool =
        row.kind === "toolCall" ||
        row.kind === "toolResult" ||
        row.kind === "bash";
      const open = this.toolsExpanded || this.expanded.has(row.id);
      const framed =
        tool ||
        [
          "custom",
          "compaction",
          "branchSummary",
          "thinking",
          "image",
          "error",
        ].includes(row.kind);
      const summary = row.kind === "compaction" || row.kind === "branchSummary";
      const result = row.kind === "toolCall" ? results.get(row.id) : undefined;
      const title = tool
        ? `${open ? "▾" : "▸"} ${row.isError || result?.isError ? "✗" : row.kind === "toolCall" && !result ? "…" : "✓"} ${row.toolName ?? row.kind}${row.kind === "toolCall" ? ` · ${this.toolSummary(row.arguments)}` : ""}`
        : row.kind === "compaction"
          ? `Context compacted · ${row.tokensBefore ? formatTokens(row.tokensBefore) : "—"} before`
          : row.kind === "thinking"
            ? "Thinking"
            : row.role === "user"
              ? "You"
              : row.kind === "custom"
                ? (row.customType ?? "Extension")
                : row.model || "Assistant";
      let text =
        row.kind === "toolCall"
          ? [this.toolArguments(row.arguments), result?.text]
              .filter(Boolean)
              .join("\n\n")
          : row.text;
      if (summary)
        text = text.replace(
          /<(read-files|modified-files)>\s*([\s\S]*?)<\/\1>/g,
          (_, kind, body) =>
            `### ${kind === "read-files" ? "Read files" : "Modified files"}\n\n\`\`\`text\n${body.trim()}\n\`\`\``,
        );
      const contentWidth = this.transcript.viewport.width - 5;
      const native =
        contentWidth > 0
          ? this.renderCustomBlock?.(row, open, contentWidth)
          : undefined;
      if (row.customEntry && (contentWidth <= 0 || native?.length === 0)) {
        this.cards.get(row.id)?.box.destroyRecursively();
        this.cards.delete(row.id);
        continue;
      }
      if (native) text = native.join("\n");
      if (tool && !open && this.toolDisplay === "collapsed") text = "";
      else if ((tool || summary) && !open)
        text = this.preview(
          tool ? (result?.diff ?? row.diff ?? result?.text ?? text) : text,
          summary ? 8 : 4,
        );
      const diff = row.diff ?? result?.diff;
      const signature = JSON.stringify([
        title,
        text,
        diff,
        native !== undefined,
        this.toolDisplay,
        row.isError || result?.isError,
      ]);
      let card = this.cards.get(row.id);
      if (!card) {
        const box = new BoxRenderable(this.renderer, {
          id: `card:${row.id}`,
          flexDirection: "column",
          paddingX: framed || row.role === "user" ? 1 : 0,
          paddingY: tool || row.role === "user" ? 0 : 1,
          backgroundColor:
            framed || row.role === "user" ? p.backgroundElement : p.background,
          ...(row.role === "user"
            ? { border: ["left"] as ["left"], borderColor: p.primary }
            : framed
              ? {
                  border: ["left"] as ["left"],
                  borderColor: row.isError
                    ? p.error
                    : tool
                      ? this.toolColor(row.toolName)
                      : p.accent,
                }
              : { border: false }),
        });
        let headerDown: { x: number; y: number } | undefined;
        const label = new TextRenderable(this.renderer, {
          height: 1,
          content: title,
          fg:
            row.isError || result?.isError
              ? p.error
              : row.role === "user"
                ? p.primary
                : tool
                  ? p.text
                  : row.kind === "custom"
                    ? p.info
                    : p.primary,
          truncate: true,
        });
        label.onMouseDown = (event) => {
          headerDown = { x: event.x, y: event.y };
        };
        label.onMouseUp = (event) => {
          const click =
            headerDown && headerDown.x === event.x && headerDown.y === event.y;
          headerDown = undefined;
          if (click && (tool || summary || row.kind === "custom")) {
            this.expanded.has(row.id)
              ? this.expanded.delete(row.id)
              : this.expanded.add(row.id);
            this.setTranscript(this.transcriptRows);
          }
        };
        label.visible = row.role !== "user";
        box.add(label);
        const body = this.makeBody(row, tool, native, text);
        box.add(body);
        this.transcript.add(box, rowIndex);
        card = { box, label, body, signature: "" };
        this.cards.set(row.id, card);
      }
      const plainBody = tool || native !== undefined || row.kind === "thinking";
      if (plainBody === card.body instanceof MarkdownRenderable) {
        card.body.destroyRecursively();
        card.body = this.makeBody(row, tool, native, text);
        card.box.add(card.body);
        card.signature = "";
      }
      if (card.signature !== signature) {
        card.label.content = tool
          ? new StyledText([
              {
                __isChunk: true,
                text: `${open ? "▾" : "▸"} ${row.isError || result?.isError ? "✗" : result || row.kind !== "toolCall" ? "✓" : "…"} `,
                fg: RGBA.fromHex(
                  row.isError || result?.isError ? p.error : p.textMuted,
                ),
              },
              {
                __isChunk: true,
                text: row.toolName ?? row.kind,
                fg: RGBA.fromHex(this.toolColor(row.toolName)),
              },
              {
                __isChunk: true,
                text:
                  row.kind === "toolCall"
                    ? ` · ${this.toolSummary(row.arguments)}`
                    : "",
                fg: RGBA.fromHex(p.textMuted),
              },
            ])
          : title;
        card.body.maxHeight =
          (tool || summary) && !open ? (summary ? 12 : 6) : undefined;
        if (
          card.body instanceof TextRenderable &&
          tool &&
          diff &&
          (open || this.toolDisplay === "compact")
        )
          card.body.content = this.diffText(open ? `${text}\n\n${diff}` : text);
        else card.body.content = native ? ansiToStyledText(text) : text;
        card.body.visible = !!text;
        card.signature = signature;
      }
    }
    this.renderer.requestRender();
  }
  private makeBody(
    row: TranscriptItem,
    tool: boolean,
    native: string[] | undefined,
    text: string,
  ) {
    return tool || native !== undefined || row.kind === "thinking"
      ? new TextRenderable(this.renderer, {
          content: text,
          fg: row.isError ? p.error : p.textMuted,
          wrapMode: "word",
        })
      : new MarkdownRenderable(this.renderer, {
          content: text,
          syntaxStyle: this.syntax,
          fg: p.text,
          conceal: true,
          streaming: row.id.startsWith("live:"),
          tableOptions: { style: "columns", widthMode: "full" },
          renderNode: (token) => {
            if (token.type !== "code") return undefined;
            const code = new BoxRenderable(this.renderer, {
              flexDirection: "column",
              border: ["left"],
              borderColor: p.borderActive,
              backgroundColor: p.backgroundPanel,
              paddingX: 1,
              marginY: 1,
            });
            code.add(
              new TextRenderable(this.renderer, {
                content: token.lang || "code",
                height: 1,
                fg: p.info,
              }),
            );
            code.add(
              /^(diff|patch)(?:\s|$)/.test(token.lang ?? "")
                ? new TextRenderable(this.renderer, {
                    content: this.diffText(token.text),
                    wrapMode: "word",
                  })
                : new CodeRenderable(this.renderer, {
                    content: token.text,
                    filetype: token.lang || "text",
                    syntaxStyle: this.syntax,
                    wrapMode: "word",
                    drawUnstyledText: true,
                  }),
            );
            return code;
          },
        });
  }
  private preview(text: string, limit: number) {
    const lines = text.split("\n");
    const excerpt = lines
      .slice(0, limit)
      .map((line) => (line.length > 220 ? `${line.slice(0, 220)}…` : line));
    if (lines.length > limit) excerpt.push("… click to expand");
    return excerpt.join("\n");
  }
  private toolArguments(args: Record<string, unknown> | undefined) {
    if (!args) return "";
    for (const key of ["code", "script", "command", "content", "query"])
      if (typeof args[key] === "string") return args[key];
    return JSON.stringify(args, null, 2);
  }
  private toolColor(name?: string) {
    return /^(read|glob|grep|search|ls|find)/i.test(name ?? "")
      ? p.success
      : /^(codemode|bash|shell|exec)/i.test(name ?? "")
        ? p.warning
        : /^(write|edit|patch)/i.test(name ?? "")
          ? p.secondary
          : /^(subagent|agent|advisor)/i.test(name ?? "")
            ? p.accent
            : p.info;
  }
  private diffText(text: string): StyledText {
    return new StyledText(
      text.split("\n").flatMap((line, index, lines) => {
        const added = line.startsWith("+") && !line.startsWith("+++"),
          removed = line.startsWith("-") && !line.startsWith("---");
        return [
          {
            __isChunk: true as const,
            text: line + (index < lines.length - 1 ? "\n" : ""),
            fg: RGBA.fromHex(
              added
                ? p.diffHighlightAdded
                : removed
                  ? p.diffHighlightRemoved
                  : p.text,
            ),
            ...(added || removed
              ? { bg: RGBA.fromHex(added ? p.diffAddedBg : p.diffRemovedBg) }
              : {}),
          },
        ];
      }),
    );
  }
  private toolSummary(args: Record<string, unknown> | undefined) {
    if (!args) return "";
    for (const key of ["path", "file_path", "command", "query", "agent"])
      if (typeof args[key] === "string")
        return args[key].split("\n")[0]!.slice(0, 120);
    return "";
  }
  captureNavigation(): SessionNavigation {
    const cards = [...this.cards.entries()].filter(([id]) => id !== "welcome");
    const top = this.transcript.viewport.y;
    const first = cards
      .filter(([, card]) => card.box.y + card.box.height > top)
      .sort((a, b) => a[1].box.y - b[1].box.y)[0];
    const followLatest =
      this.historyEnd === undefined &&
      this.transcript.scrollTop >=
        Math.max(
          0,
          this.transcript.scrollHeight - this.transcript.viewport.height,
        ) -
          1;
    return {
      followLatest,
      ...(first
        ? {
            anchorRowId: first[0],
            anchorOffset: Math.max(0, top - first[1].box.y),
          }
        : {}),
      ...(this.historyEnd !== undefined &&
      this.transcriptRows[this.historyEnd - 1]
        ? { windowEndRowId: this.transcriptRows[this.historyEnd - 1]!.id }
        : {}),
      sidebarScrollTop: this.sidebar.scrollTop,
      expandedToolRows: [...this.expanded].filter((id) => this.cards.has(id)),
    };
  }
  restoreNavigation(state: SessionNavigation) {
    const generation = ++this.navigationGeneration;
    this.releaseAnchor?.();
    this.releaseAnchor = undefined;
    this.expanded = new Set(state.expandedToolRows);
    const end = state.windowEndRowId
      ? this.transcriptRows.findIndex((row) => row.id === state.windowEndRowId)
      : -1;
    this.historyEnd = end >= 0 ? end + 1 : undefined;
    if (
      !state.followLatest &&
      state.anchorRowId &&
      !this.transcriptRows
        .slice(
          Math.max(
            0,
            (this.historyEnd ?? this.transcriptRows.length) - this.historyLimit,
          ),
          this.historyEnd,
        )
        .some((row) => row.id === state.anchorRowId)
    ) {
      const anchor = this.transcriptRows.findIndex(
        (row) => row.id === state.anchorRowId,
      );
      if (anchor >= 0)
        this.historyEnd = Math.min(
          this.transcriptRows.length,
          anchor + this.historyLimit,
        );
    }
    this.setTranscript(this.transcriptRows);
    this.sidebar.scrollTo(state.sidebarScrollTop);
    if (state.followLatest) this.transcript.scrollTo(Infinity);
    else
      this.transcript.afterLayout(() => {
        if (generation !== this.navigationGeneration) return;
        const card = state.anchorRowId
          ? this.cards.get(state.anchorRowId)
          : undefined;
        if (!card) {
          this.transcript.scrollTo(0);
          return;
        }
        this.transcript.scrollTo(
          card.box.y -
            this.transcript.viewport.y +
            this.transcript.scrollTop +
            (state.anchorOffset ?? 0),
        );
        this.releaseAnchor = this.transcript.anchor(card.box);
      });
  }
  revealEntry(entryId: string): boolean {
    this.navigationGeneration++;
    const index = this.transcriptRows.findIndex(
      (row) => row.entryId === entryId,
    );
    if (index < 0) return false;
    const target = this.transcriptRows[index]!;
    if (target.kind === "thinking") this.thinkingExpanded = true;
    this.historyEnd = Math.min(
      this.transcriptRows.length,
      index + this.historyLimit - 20,
    );
    this.setTranscript(this.transcriptRows);
    const card =
      this.cards.get(target.id) ??
      (target.resultFor ? this.cards.get(target.resultFor) : undefined);
    if (!card) return false;
    if (target.resultFor || target.kind === "toolCall") {
      this.expanded.add(
        this.cards.has(target.id) ? target.id : target.resultFor!,
      );
      this.setTranscript(this.transcriptRows);
    }
    this.transcript.scrollChildIntoView(card.box, { align: "start" });
    return true;
  }
  jumpLatest() {
    this.navigationGeneration++;
    this.releaseAnchor?.();
    this.releaseAnchor = undefined;
    this.historyEnd = undefined;
    this.setTranscript(this.transcriptRows);
    this.transcript.scrollTo(Infinity);
  }
  loadOlder() {
    this.navigationGeneration++;
    if (this.historyStart === 0) return;
    this.historyEnd = this.historyStart;
    this.setTranscript(this.transcriptRows);
    this.transcript.scrollTo(0);
  }
  setSidebarVisible(visible: boolean) {
    this.sidebarRequested = visible;
    if (this.renderer.width < 100) this.sidebarFloating = visible;
    this.resize();
  }
  toggleSidebar() {
    if (this.renderer.width < 100) this.sidebarFloating = !this.sidebarFloating;
    else this.sidebarRequested = !this.sidebarRequested;
    this.resize();
  }
  private resize() {
    const navigation = this.captureNavigation();
    const card = navigation.anchorRowId
      ? this.cards.get(navigation.anchorRowId)
      : undefined;
    if (!navigation.followLatest && card) {
      this.releaseAnchor?.();
      this.releaseAnchor = this.transcript.anchor(card.box);
    }
    const narrow = this.renderer.width < 100;
    this.sidebar.visible = narrow
      ? this.sidebarFloating
      : this.sidebarRequested;
    this.sidebar.position =
      narrow && this.sidebarFloating ? "absolute" : "relative";
    this.sidebar.width = narrow
      ? Math.min(38, Math.max(18, this.renderer.width - 2))
      : 38;
    if (narrow && this.sidebarFloating) {
      this.sidebar.top = 2;
      this.sidebar.right = 0;
      this.sidebar.height = Math.max(3, this.renderer.height - 3);
      this.sidebar.zIndex = 20;
      this.sidebar.backgroundColor = p.backgroundPanel;
    } else {
      this.sidebar.top = undefined;
      this.sidebar.right = undefined;
      this.sidebar.height = undefined;
      this.sidebar.zIndex = undefined;
    }
    this.renderer.requestRender();
  }
  dispose() {
    this.navigationGeneration++;
    this.releaseAnchor?.();
    this.renderer.off("resize", this.resizeHandler);
    this.root.destroyRecursively();
    this.syntax.destroy();
  }
}
