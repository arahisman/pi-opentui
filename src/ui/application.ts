import {
  TextRenderable,
  BoxRenderable,
  type CliRenderer,
  KeyEvent,
  parseKeypress,
  type PasteEvent,
} from "@opentui/core";
import { basename } from "node:path";
import { spawn } from "node:child_process";
import { Shell } from "./shell.ts";
import { normalizeArrowInput } from "./keyboard-input.ts";
import { adviceAge, adviceFeedback, newestAdvice } from "./advisor-history.ts";
import { SettingsPanel } from "./settings-panel.ts";
import { ConnectionsPanel } from "./connections-panel.ts";
import { projectTranscript } from "../core/session-data.ts";
import type { SessionNavigation } from "../core/ui-store.ts";
import {
  captureCursorOffset,
  restoreCursorOffset,
} from "../core/editor-state.ts";
import { OverlayManager, type TextOptions } from "./overlays.ts";
import { ansiToStyledText } from "./ansi.ts";
import { PiHost } from "../host/controller.ts";
import {
  formatTokens,
  formatCost,
  object,
  projectUsageRequests,
} from "../core/telemetry.ts";
import { loadUsageJournal } from "../core/usage-journal.ts";
import {
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
  wrapTextWithAnsi,
  matchesKey,
} from "@earendil-works/pi-tui";
import type { ExtensionUIBridge } from "../host/extension-ui.ts";
import { palette as p } from "../theme.ts";

export class Application {
  readonly shell: Shell;
  readonly overlays: OverlayManager;
  private readonly settingsPanel: SettingsPanel;
  private readonly connectionsPanel: ConnectionsPanel;
  private scheduled = false;
  private transcriptRevision = -1;
  private lastTranscriptRows?: ReturnType<PiHost["transcript"]["slice"]>;
  private nativeEditorIdentity?: ExtensionUIBridge["editorComponent"];
  private readonly beforeUiReset = () => {
    this.saveDraft();
    this.pendingNavigation = this.shell.captureNavigation();
  };
  private reviewedAdvice: string[] = [];
  private refreshAdvisor?: () => void;
  private subagentInspector?: {
    bridge: ExtensionUIBridge;
    dialog?: ExtensionUIBridge["activeDialog"];
    moves: ("left" | "right")[];
  };
  private authAbort?: AbortController;
  private workingTimer?: ReturnType<typeof setTimeout>;
  private terminalTitle = "";
  private disposed = false;
  private dialogId?: number;
  private dialogSurface = false;
  private dialogBridge?: ExtensionUIBridge;
  private notificationsBridge?: ExtensionUIBridge;
  private notificationsSeen = 0;
  private lastNotification?: object;
  private editorBridge?: ExtensionUIBridge;
  private toast: BoxRenderable;
  private toastBody: TextRenderable;
  private toastTitle: TextRenderable;
  private leaderTimer?: ReturnType<typeof setTimeout>;
  private selectionCopyTimer?: ReturnType<typeof setTimeout>;
  private toastTimer?: ReturnType<typeof setTimeout>;
  private readonly beforeSessionChange = () => {
    this.saveDraft();
    this.dialogId = undefined;
    this.dialogBridge = undefined;
    this.dialogSurface = false;
    this.overlays.setNativeSurface(undefined);
    this.overlays.close();
  };
  private leader = false;
  private draftSession = "";
  private pendingNavigation?: SessionNavigation;
  private readonly onViewportChange = () => this.saveDraftSoon();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private widget: TextRenderable;
  private readonly onChange = () => this.schedule();
  private readonly onSubmit = (text: string) => {
    void this.submit(text);
  };
  private readonly onError = (message: string) => this.showError(message);
  private readonly onShutdown = () => {
    void this.exit();
  };
  private readonly onKey = (key: KeyEvent) => this.key(key);
  private readonly onPaste = (event: PasteEvent) => this.paste(event);
  private readonly onSelection = (
    selection: NonNullable<ReturnType<CliRenderer["getSelection"]>>,
  ) => {
    if (selection.isDragging) return;
    const text = selection.getSelectedText();
    if (!text) return;
    clearTimeout(this.selectionCopyTimer);
    this.selectionCopyTimer = setTimeout(() => {
      if (this.disposed) return;
      try {
        if (!this.renderer.copyToClipboardOSC52(text))
          this.host.bridge.notify(
            "Terminal clipboard is unavailable",
            "warning",
          );
      } catch (error) {
        this.host.bridge.notify(
          `Clipboard copy failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    }, 0);
  };
  private transcriptWidth = -1;
  private readonly onFrame = () => {
    const width = this.shell.transcript.viewport.width;
    if (!this.disposed && width > 5 && width !== this.transcriptWidth) {
      this.transcriptWidth = width;
      this.transcriptRevision = -1;
      this.schedule();
    }
  };
  private readonly onResize = () => {
    this.toast.width = Math.max(1, Math.min(60, this.renderer.width - 6));
    this.toast.maxHeight = Math.max(1, Math.min(10, this.renderer.height - 4));
    this.host.bridge.resize(this.renderer.width, this.renderer.height);
    this.schedule();
  };
  constructor(
    readonly renderer: CliRenderer,
    readonly host: PiHost,
    private readonly onExit: () => void | Promise<void>,
  ) {
    host.setFrontendCommands(this.frontendCommands());
    this.shell = new Shell(renderer, host.snapshot(), (text) => {
      void this.submit(text);
    });
    this.overlays = new OverlayManager(renderer, () => this.schedule());
    this.connectionsPanel = new ConnectionsPanel(host, this.overlays, {
      onProviders: () => this.providers(),
      onExtensions: () => this.extensions(),
    });
    this.settingsPanel = new SettingsPanel(host, this.overlays, {
      getDisplay: () => ({
        sidebarVisible: this.shell.sidebarRequested,
        thinkingExpanded: this.shell.thinkingExpanded,
        toolsExpanded: this.shell.toolsExpanded,
        toolDisplay: this.shell.toolDisplay,
      }),
      applyDisplay: (display) => {
        if (display.sidebarVisible !== this.shell.sidebarRequested)
          this.shell.setSidebarVisible(display.sidebarVisible);
        this.shell.thinkingExpanded = display.thinkingExpanded;
        this.shell.setToolDisplay(
          display.toolDisplay ?? (display.toolsExpanded ? "full" : "compact"),
        );
        host.bridge.setToolsExpanded(display.toolsExpanded);
        host.store.savePreferences({ ...display });
        this.transcriptRevision = -1;
        this.schedule();
      },
      onApplied: () => {
        this.transcriptRevision = -1;
        this.schedule();
      },
    });
    this.widget = new TextRenderable(renderer, {
      id: "extension-widgets",
      content: "",
      fg: p.textMuted,
      wrapMode: "word",
      maxHeight: 3,
      visible: false,
    });
    this.shell.addEditorAccessory(this.widget);
    this.toast = new BoxRenderable(renderer, {
      id: "notifications",
      position: "absolute",
      right: 2,
      top: 2,
      width: Math.max(1, Math.min(60, renderer.width - 6)),
      maxHeight: 10,
      zIndex: 500,
      visible: false,
      backgroundColor: p.backgroundPanel,
      border: ["left", "right"],
      borderColor: p.info,
      paddingX: 2,
      paddingY: 1,
      flexDirection: "column",
      overflow: "hidden",
    });
    this.toastTitle = new TextRenderable(renderer, {
      id: "notification-title",
      content: "",
      fg: p.info,
      height: 1,
      truncate: true,
    });
    this.toastBody = new TextRenderable(renderer, {
      id: "notification-message",
      content: "",
      fg: p.text,
      wrapMode: "word",
      maxHeight: 6,
    });
    this.toast.add(this.toastTitle);
    this.toast.add(this.toastBody);
    this.shell.root.add(this.toast);
    this.shell.onToolDisplayChange = (mode) => {
      host.bridge.setToolsExpanded(mode === "full");
      host.store.savePreferences({
        toolDisplay: mode,
        toolsExpanded: mode === "full",
      });
      this.transcriptRevision = -1;
      this.schedule();
    };
    this.shell.renderCustomBlock = (row, expanded, width) =>
      this.host.renderCustomBlock(row, expanded, width);
    const preferences = host.store.loadPreferences();
    this.reviewedAdvice = Array.isArray(preferences.reviewedAdvice)
      ? preferences.reviewedAdvice.filter(
          (id): id is string => typeof id === "string",
        )
      : [];
    this.shell.thinkingExpanded = preferences.thinkingExpanded ?? false;
    this.shell.toolsExpanded = preferences.toolsExpanded ?? false;
    if (
      ["collapsed", "compact", "full"].includes(String(preferences.toolDisplay))
    )
      this.shell.toolDisplay = preferences.toolDisplay as
        | "collapsed"
        | "compact"
        | "full";
    host.bridge.setToolsExpanded(this.shell.toolsExpanded);
    this.shell.sidebarRequested = preferences.sidebarVisible ?? true;
    host.on("before_session_change", this.beforeSessionChange);
    host.on("before_ui_reset", this.beforeUiReset);
    host.on("change", this.onChange);
    host.on("submit", this.onSubmit);
    host.on("host_error", this.onError);
    host.on("shutdown", this.onShutdown);
    renderer.keyInput.on("keypress", this.onKey);
    renderer.keyInput.on("paste", this.onPaste);
    renderer.on("resize", this.onResize);
    renderer.on("frame", this.onFrame);
    renderer.on("selection", this.onSelection);
    this.shell.transcript.verticalScrollBar.on("change", this.onViewportChange);
    this.shell.sidebar.verticalScrollBar.on("change", this.onViewportChange);
    this.poll = setInterval(() => this.schedule(), 500);
    this.poll.unref();
    this.onResize();
    this.sync();
  }
  private schedule() {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      if (!this.disposed) this.sync();
    }, 16);
  }
  private sync() {
    const file =
      this.host.session.sessionFile ??
      `unsaved:${this.host.session.sessionManager.getSessionId()}`;
    const restoreDraftText =
      file !== this.draftSession || this.editorBridge !== this.host.bridge;
    if (
      restoreDraftText ||
      this.nativeEditorIdentity !== this.host.bridge.editorComponent
    ) {
      if (file !== this.draftSession) {
        this.shell.jumpLatest();
        this.pendingNavigation = this.host.store.loadNavigation(file);
        this.host.store.savePreferences({
          lastSessionFile: this.host.session.sessionFile,
        });
      }
      this.draftSession = file;
      this.editorBridge = this.host.bridge;
      this.nativeEditorIdentity = this.host.bridge.editorComponent;
      this.host.bridge.resize(this.renderer.width, this.renderer.height);
      const draft = this.host.store.loadDraft(file);
      if (draft) {
        if (restoreDraftText) this.host.bridge.setEditorText(draft.text);
        if (
          draft.cursorOffset !== undefined &&
          draft.text === this.host.bridge.getEditorText()
        )
          restoreCursorOffset(
            this.host.bridge.editorComponent,
            draft.cursorOffset,
          );
      }
    }
    const bridge = this.host.bridge;
    this.syncSubagentInspector();
    if (this.shell.toolsExpanded !== bridge.getToolsExpanded()) {
      this.shell.toolsExpanded = bridge.getToolsExpanded();
      this.transcriptRevision = -1;
    }
    if (bridge.title !== this.terminalTitle) {
      this.terminalTitle = bridge.title;
      this.renderer.setTerminalTitle(bridge.title);
    }
    const snapshot = this.host.snapshot();
    const working =
      snapshot.compaction !== undefined ||
      (this.host.session.isStreaming && bridge.workingVisible);
    const frames = bridge.workingIndicator?.frames ?? ["●●●"];
    const interval = Math.max(400, bridge.workingIndicator?.intervalMs ?? 500);
    const frame = sliceByColumn(
      stripTerminalSequences(
        frames[
          Math.floor(Date.now() / interval) % Math.max(1, frames.length)
        ] ?? "",
      ),
      0,
      8,
    );
    const frameWidth = Math.min(
      8,
      Math.max(3, ...frames.map((value) => visibleWidth(value))),
    );
    if (working && frames.length && !this.workingTimer)
      this.workingTimer = setTimeout(() => {
        this.workingTimer = undefined;
        this.schedule();
      }, interval);
    if ((!working || !frames.length) && this.workingTimer) {
      clearTimeout(this.workingTimer);
      this.workingTimer = undefined;
    }
    const compactions = this.host.compactions;
    this.shell.update({
      ...snapshot,
      workingMessage: snapshot.compaction
        ? "Compacting context"
        : working
          ? (bridge.workingMessage ?? "Working")
          : undefined,
      workingFrame: Math.floor(Date.now() / interval),
      workingGlyph:
        frame + " ".repeat(Math.max(0, frameWidth - visibleWidth(frame))),
      reviewedAdvice: this.reviewedAdvice,
      compactionCount: compactions.length,
      lastCompactionBefore: compactions.at(-1)?.before,
    });
    this.refreshAdvisor?.();
    const revision = this.host.projectionRevision;
    if (revision !== this.transcriptRevision) {
      const rows = this.host.transcript;
      if (
        this.lastTranscriptRows &&
        rows !== this.lastTranscriptRows &&
        !this.pendingNavigation
      )
        this.shell.jumpLatest();
      this.shell.setTranscript(rows, this.host.toolResults);
      this.lastTranscriptRows = rows;
      this.transcriptRevision = revision;
      if (this.pendingNavigation) {
        this.shell.restoreNavigation(this.pendingNavigation);
        this.pendingNavigation = undefined;
      }
    }
    if (!this.renderer.getSelection()) {
      const text = bridge.getEditorText();
      if (this.shell.editor.plainText !== text) this.shell.editor.setText(text);
      const editor = bridge.editorComponent as typeof bridge.editorComponent & {
        getCursor?: () => { line: number; col: number };
      };
      const cursor = editor.getCursor?.();
      if (cursor) this.shell.editor.setCursor(cursor.line, cursor.col);
    }
    const nativeLines = bridge.renderEditor(
      Math.max(10, this.shell.editorWidth),
    );
    this.shell.setNativeEditor(nativeLines);
    this.shell.setExtensionWidgets(
      this.widgetLines("aboveEditor"),
      this.widgetLines("belowEditor"),
      bridge.renderHeader(Math.max(10, this.renderer.width - 4)),
      bridge.renderFooter(Math.max(10, this.renderer.width - 4)),
    );
    const widgets = [
      ...this.host.session
        .getSteeringMessages()
        .map((text) => `↳ Steering · ${text}`),
      ...this.host.session
        .getFollowUpMessages()
        .map((text) => `↳ Follow-up · ${text}`),
    ];
    this.widget.visible = widgets.length > 0;
    if (this.widget.visible) this.widget.content = ansiToStyledText(widgets);
    if (this.notificationsBridge !== bridge) {
      this.notificationsBridge = bridge;
      this.lastNotification = undefined;
    }
    const lastIndex = this.lastNotification
      ? bridge.notifications.findIndex((note) => note === this.lastNotification)
      : -1;
    const notifications = bridge.notifications.slice(lastIndex + 1);
    this.lastNotification = bridge.notifications.at(-1);
    if (notifications.length) {
      this.toast.width = Math.max(1, Math.min(60, this.renderer.width - 6));
      this.toast.visible = true;
      const latest = notifications.at(-1)!;
      const color =
        latest.type === "error"
          ? p.error
          : latest.type === "warning"
            ? p.warning
            : p.info;
      this.toast.borderColor = color;
      this.toastTitle.fg = color;
      this.toastTitle.content =
        latest.type === "error"
          ? "Error"
          : latest.type === "warning"
            ? "Warning"
            : "Notification";
      this.toastBody.content = notifications
        .slice(-4)
        .map((note) => note.message)
        .join("\n");
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => {
        this.toast.visible = false;
        this.renderer.requestRender();
      }, 6000);
    }
    if (bridge.activeDialog) {
      this.showExtensionDialog();
      this.overlays.refresh();
    } else if (this.dialogId !== undefined) {
      this.dialogId = undefined;
      if (this.dialogSurface) this.overlays.setNativeSurface(undefined);
      else this.overlays.close();
      this.dialogSurface = false;
    }
    this.renderer.requestRender();
  }
  private saveDraft() {
    if (this.draftSession) {
      this.host.store.saveNavigation(
        this.draftSession,
        this.shell.captureNavigation(),
      );
      this.host.store.saveDraft(
        this.draftSession,
        this.host.bridge.getEditorText(),
        captureCursorOffset(this.host.bridge.editorComponent),
      );
    }
  }
  private saveDraftSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveDraft(), 250);
  }
  private setLeader(active: boolean) {
    clearTimeout(this.leaderTimer);
    this.leader = active;
    this.shell.setLeaderMode(active);
    if (active)
      this.leaderTimer = setTimeout(() => this.setLeader(false), 2000);
  }
  private widgetLines(placement: "aboveEditor" | "belowEditor") {
    const width = Math.max(10, this.shell.editorWidth);
    return this.host.bridge.renderWidgets(width, placement).flatMap((line) => {
      const rewritten = line
        .replace("↓/← to inspect", "ctrl+x ↓ inspect · ctrl+x ←/→ agents")
        .replace(
          "↑↓/jk select · enter inspect · esc back",
          "ctrl+x ↓ inspect · ctrl+x ←/→ agents",
        );
      return rewritten === line ? [line] : wrapTextWithAnsi(rewritten, width);
    });
  }
  private syncSubagentInspector() {
    const inspector = this.subagentInspector;
    const bridge = this.host.bridge;
    const dialog = bridge.activeDialog;
    if (!inspector || inspector.bridge !== bridge || dialog?.kind !== "custom")
      return;
    if (!inspector.dialog) inspector.dialog = dialog;
    if (inspector.dialog !== dialog || !bridge.dialogCapturesInput) return;
    for (const move of inspector.moves.splice(0))
      bridge.handleCustomInput(move === "left" ? "\x1b[A" : "\x1b[B");
  }
  private navigateSubagents(direction: "down" | "left" | "right") {
    const bridge = this.host.bridge;
    const inspector = this.subagentInspector;
    if (inspector?.bridge === bridge) {
      if (direction !== "down") inspector.moves.push(direction);
      this.syncSubagentInspector();
      this.schedule();
      return;
    }
    if (this.overlays.isOpen) {
      bridge.notify(
        "Close the current panel before opening the subagent inspector",
        "info",
      );
      return;
    }
    if (
      !this.host.commands().some((command) => command.name === "subagents-fleet")
    ) {
      bridge.notify(
        "Subagent inspector is unavailable: the subagents-fleet command is not registered",
        "warning",
      );
      return;
    }
    const request: NonNullable<Application["subagentInspector"]> = {
      bridge,
      moves: direction === "down" ? [] : [direction],
    };
    this.subagentInspector = request;
    void this.host
      .send("/subagents-fleet")
      .catch((error) => {
        if (!this.disposed) this.showError(error);
      })
      .finally(() => {
        if (this.subagentInspector === request) this.subagentInspector = undefined;
      });
    this.schedule();
  }
  private key(key: KeyEvent) {
    if (this.disposed || key.eventType === "release") return;
    if (key.ctrl && key.name === "x") {
      key.preventDefault();
      this.setLeader(true);
      return;
    }
    if (this.leader && ["down", "left", "right"].includes(key.name)) {
      key.preventDefault();
      this.setLeader(false);
      this.navigateSubagents(key.name as "down" | "left" | "right");
      return;
    }
    if (this.leader && this.overlays.isOpen) this.setLeader(false);
    const raw = normalizeArrowInput(
      key.name === "return"
        ? key.shift || key.ctrl
          ? "\n"
          : "\r"
        : key.raw || key.sequence,
    );
    const input = this.host.bridge.processTerminalInput(raw);
    if (input === undefined) {
      key.preventDefault();
      return;
    }
    if (input !== raw) {
      key.preventDefault();
      if (this.overlays.isOpen) {
        const parsed = parseKeypress(input);
        if (parsed) this.overlays.handleKey(new KeyEvent(parsed));
        else this.overlays.handlePaste(input);
      } else this.host.bridge.handleEditorInput(input);
      this.schedule();
      return;
    }
    if (this.overlays.isOpen) {
      const parsed =
        ["up", "down", "left", "right"].includes(key.name) &&
        raw !== (key.raw || key.sequence)
          ? parseKeypress(raw)
          : undefined;
      if (this.overlays.handleKey(parsed ? new KeyEvent(parsed) : key)) {
        key.preventDefault();
        return;
      }
    }
    if (key.ctrl && key.name === "c" && this.host.bridge.getEditorText()) {
      key.preventDefault();
      this.host.bridge.setEditorText("");
      this.setLeader(false);
      this.saveDraft();
      this.schedule();
      return;
    }
    if (key.ctrl && key.name === "end") {
      key.preventDefault();
      this.shell.jumpLatest();
      return;
    }
    if (key.ctrl && key.name === "p") {
      key.preventDefault();
      this.commandPalette();
      return;
    }
    if (this.leader) {
      key.preventDefault();
      this.setLeader(false);
      if (key.name === "m") this.models();
      else if (key.name === "l") void this.sessions();
      else if (key.name === "n") void this.newSession();
      else if (key.name === "b") this.shell.toggleSidebar();
      else if (key.name === "s") this.connections();
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      if (this.host.snapshot().compaction) {
        void this.host.abort();
        return;
      }
      if (
        (
          this.host.bridge.editorComponent as {
            capturesViewportInput?: boolean;
          }
        ).capturesViewportInput
      ) {
        this.host.bridge.handleEditorInput(raw);
        this.schedule();
        return;
      }
      if (this.host.session.isStreaming) void this.host.abort();
      else if (this.renderer.width < 100) this.shell.toggleSidebar();
      return;
    }
    if (key.ctrl && key.name === "d" && !this.host.bridge.getEditorText()) {
      key.preventDefault();
      void this.exit();
      return;
    }
    if (key.ctrl && key.name === "o") {
      key.preventDefault();
      this.transcriptRevision = -1;
      this.host.bridge.setToolsExpanded(!this.host.bridge.getToolsExpanded());
      this.shell.toolsExpanded = this.host.bridge.getToolsExpanded();
      this.host.store.savePreferences({
        toolsExpanded: this.shell.toolsExpanded,
        toolDisplay: this.shell.toolDisplay,
      });
      this.schedule();
      return;
    }
    if (key.ctrl && key.name === "t") {
      key.preventDefault();
      this.transcriptRevision = -1;
      this.shell.thinkingExpanded = !this.shell.thinkingExpanded;
      this.host.store.savePreferences({
        thinkingExpanded: this.shell.thinkingExpanded,
      });
      this.schedule();
      return;
    }
    if (
      (key.name === "pageup" || key.name === "pagedown") &&
      !(this.host.bridge.editorComponent as { capturesViewportInput?: boolean })
        .capturesViewportInput
    ) {
      key.preventDefault();
      this.shell.transcript.scrollBy(
        (key.name === "pageup" ? -1 : 1) *
          Math.max(1, this.renderer.height - 8),
      );
      return;
    }
    if (key.meta && key.name === "return") {
      key.preventDefault();
      void this.submit(this.host.bridge.getEditorText(), true);
      return;
    }
    key.preventDefault();
    const shortcut = this.host.session.extensionRunner.getShortcuts(
      this.host.bridge.keybindings.getEffectiveConfig(),
    );
    const extension = [...shortcut].find(([binding]) =>
      matchesKey(raw, binding),
    );
    if (extension)
      void Promise.resolve(
        extension[1].handler(this.host.session.extensionRunner.createContext()),
      ).catch((error) => this.showError(error));
    else this.host.bridge.handleEditorInput(raw);
    this.saveDraftSoon();
    this.schedule();
  }
  private paste(event: PasteEvent) {
    this.setLeader(false);
    event.preventDefault();
    const original = new TextDecoder().decode(event.bytes),
      processed = this.host.bridge.processTerminalInput(
        `\x1b[200~${original}\x1b[201~`,
      );
    if (processed === undefined) return;
    const text =
      processed === `\x1b[200~${original}\x1b[201~` ? original : processed;
    if (this.overlays.isOpen) this.overlays.handlePaste(text);
    else {
      this.host.bridge.pasteToEditor(text);
      this.saveDraftSoon();
      this.schedule();
    }
  }
  async submit(text: string, steer = false) {
    if (!text.trim()) return;
    try {
      if (text.trim().startsWith("/") && this.builtin(text.trim())) {
        this.host.bridge.setEditorText("");
        this.saveDraft();
        this.schedule();
        return;
      }
      this.host.bridge.editorComponent.addToHistory?.(text);
      this.host.bridge.setEditorText("");
      this.saveDraft();
      this.schedule();
      if (text.trim() === "/subagents-fleet") {
        this.navigateSubagents("down");
        return;
      }
      await this.host.send(text, steer);
    } catch (error) {
      if (!this.host.bridge.getEditorText())
        this.host.bridge.setEditorText(text);
      this.saveDraft();
      this.showError(error);
    }
  }
  private builtin(text: string) {
    const command = text.split(/\s/)[0];
    const commands: Record<string, () => void> = {
      "/name": () => {
        const name = text.slice("/name".length).trim();
        if (!name)
          this.overlays.openInput({
            title: "Session name",
            value: this.host.session.sessionName ?? "",
            onSubmit: (value) => {
              if (value.trim()) {
                this.host.session.setSessionName(value.trim());
                this.host.invalidateProjection();
                this.schedule();
              }
            },
          });
        else {
          this.host.session.setSessionName(name);
          this.host.invalidateProjection();
          this.schedule();
        }
      },
      "/thinking": () => this.reasoning(),
      "/scoped-models": () => this.models(),
      "/session": () => this.usage(),
      "/hotkeys": () => this.commandPalette(),
      "/copy": () => {
        const last = this.host.transcript
          .filter((row) => row.role === "assistant" && row.kind === "text")
          .at(-1);
        if (last && !this.renderer.copyToClipboardOSC52(last.text))
          throw new Error("Terminal clipboard is unavailable");
      },
      "/model": () => this.models(),
      "/models": () => this.models(),
      "/resume": () => {
        void this.sessions();
      },
      "/sessions": () => {
        void this.sessions();
      },
      "/new": () => {
        void this.newSession();
      },
      "/settings": () => this.settings(),
      "/reload": () => {
        void this.host.reload().catch((error) => this.showError(error));
      },
      "/login": () => this.providers(),
      "/status": () => this.connections(),
      "/usage": () => this.usage(),
      "/context": () => this.context(),
      "/advice": () => this.advisor(),
      "/connections": () => this.connections(),
      "/tree": () => this.tree(),
      "/compact": () => {
        void this.compact();
      },
      "/quit": () => {
        void this.exit();
      },
      "/help": () => this.commandPalette(),
    };
    const action = commands[command ?? ""];
    if (!action) {
      const native = this.host
        .completionCommands()
        .find(
          (item) => item.source === "builtin" && `/${item.name}` === command,
        );
      if (native)
        throw new Error(
          `${command} is a native Pi command without an OpenTUI action. Open the native Pi session to use it.`,
        );
      return false;
    }
    action();
    return true;
  }
  private frontendCommands() {
    return [
      { name: "model", description: "Choose model and reasoning" },
      { name: "resume", description: "Continue a saved session" },
      { name: "new", description: "New session" },
      { name: "name", description: "Rename this session" },
      {
        name: "compact",
        description: "Compact context using configured policy",
      },
      { name: "usage", description: "Usage by model and agent" },
      { name: "context", description: "Context and compaction history" },
      { name: "advice", description: "Advisor history" },
      { name: "settings", description: "Preferences" },
      {
        name: "connections",
        description: "Providers, MCP, LSP and extensions",
      },
      { name: "tree", description: "Conversation history and branches" },
    ];
  }
  private commands() {
    const native = this.frontendCommands();
    return [
      ...native,
      ...this.host
        .completionCommands()
        .filter(
          (command) => !native.some((item) => item.name === command.name),
        ),
    ];
  }
  commandPalette(query = "") {
    this.setLeader(false);
    const commands = this.commands();
    const actions = [
      ...commands.map((command) => ({
        id: command.name,
        label: command.name,
        description: command.description,
      })),
      {
        id: "tool-display",
        label: "Action display mode",
        description: "Collapsed / compact / full",
      },
      {
        id: "sidebar",
        label: "Toggle sidebar",
        description: "Usage, context and advisor · ctrl+x b",
      },
      {
        id: "older",
        label: "Load earlier messages",
        description: "Show 200 more history blocks",
      },
      {
        id: "latest",
        label: "Jump to latest message",
        description: "Return to live conversation",
      },
      {
        id: "retry",
        label: "Retry last request",
        description: "Repeat after provider failure",
      },
      {
        id: "copy",
        label: "Copy last answer",
        description: "Copy using terminal clipboard",
      },
      { id: "exit", label: "Exit", description: "Save draft and close safely" },
    ];
    this.overlays.openMenu({
      title: "Commands",
      items: actions,
      query,
      onSelect: async (id) => {
        if (id === "tool-display") {
          this.overlays.openMenu({
            title: "Action display mode",
            items: ["collapsed", "compact", "full"].map((mode) => ({
              id: mode,
              label: mode,
            })),
            onSelect: (mode) =>
              this.shell.setToolDisplay(
                mode as "collapsed" | "compact" | "full",
              ),
          });
        } else if (id === "sidebar") {
          this.shell.toggleSidebar();
          this.host.store.savePreferences({
            sidebarVisible: this.shell.sidebarRequested,
          });
        } else if (id === "older") this.shell.loadOlder();
        else if (id === "latest") this.shell.jumpLatest();
        else if (id === "exit") await this.exit();
        else if (id === "copy") {
          const last = this.host.transcript
            .filter((row) => row.role === "assistant" && row.kind === "text")
            .at(-1);
          if (last && !this.renderer.copyToClipboardOSC52(last.text))
            throw new Error("Terminal clipboard is unavailable");
        } else if (id === "retry") {
          const last = this.host.transcript
            .filter((row) => row.role === "user" && row.kind === "text")
            .at(-1);
          if (last) await this.submit(last.text);
        } else if (!this.builtin(`/${id}`)) await this.host.send(`/${id}`);
      },
    });
  }
  models() {
    const models = this.host.session.modelRuntime.getModels();
    this.overlays.openMenu({
      title: "Models",
      items: models.map((model) => ({
        id: `${model.provider}/${model.id}`,
        label: `${this.host.session.model?.id === model.id && this.host.session.model.provider === model.provider ? "●" : "○"} ${model.name}`,
        description: `${model.provider} · ${formatTokens(model.contextWindow)} context · ${this.host.session.modelRuntime.hasConfiguredAuth(model.provider) ? "connected" : "not connected"}`,
      })),
      onSelect: async (id) => {
        const model = models.find(
          (model) => `${model.provider}/${model.id}` === id,
        );
        if (!model) return;
        if (!this.host.session.modelRuntime.hasConfiguredAuth(model.provider)) {
          this.providers();
          return;
        }
        await this.host.selectModel(model.provider, model.id);
        this.reasoning();
      },
    });
  }
  private reasoning() {
    const levels = this.host.session.getAvailableThinkingLevels();
    this.overlays.openMenu({
      title: "Reasoning",
      items: levels.map((level) => ({
        id: level,
        label: `${level === this.host.session.thinkingLevel ? "●" : "○"} ${level}`,
      })),
      onSelect: (id) =>
        this.host.setThinking(id as Parameters<PiHost["setThinking"]>[0]),
    });
  }
  async sessions(all = false) {
    try {
      const sessions = await this.host.listSessions(all);
      this.overlays.openMenu({
        title: "Sessions",
        tabs: ["This project", "All projects"],
        tabIndex: all ? 1 : 0,
        onTab: (index) => {
          void this.sessions(index === 1);
        },
        items: sessions.map((session) => ({
          id: session.path,
          label:
            session.name ?? session.firstMessage.slice(0, 75) ?? "Untitled",
          description: `${basename(session.cwd)} · ${session.modified.toLocaleString()} · ${session.messageCount} messages`,
        })),
        onSelect: async (path) => {
          this.saveDraft();
          await this.host.switchSession(path);
          this.sync();
        },
      });
    } catch (error) {
      this.showError(error);
    }
  }
  private async newSession() {
    try {
      this.saveDraft();
      await this.host.newSession();
      this.sync();
    } catch (error) {
      this.showError(error);
    }
  }
  usage(tab = 0) {
    const usage = this.host.snapshot().usage;
    const groups = tab === 0 ? usage.byModel : usage.byAgent;
    this.overlays.openText({
      title: `Usage · ${tab === 0 ? "by model" : "by agent"}`,
      body: [
        "Model / agent               Input    Cache    Output    Cost",
        ...Object.entries(groups).map(
          ([name, total]) =>
            `${name}\n  ${formatTokens(total.input)} input · ${formatTokens(total.cacheRead)} cache · ${formatTokens(total.output)} output · ${formatCost(total.cost)}`,
        ),
        "",
        `Total ${formatCost(usage.totals.cost)}`,
        `${usage.totals.missingUsage} responses without usage; ${usage.totals.unpriced} without price`,
        usage.coverage === "main-only"
          ? "Only main-session usage is available."
          : "Current session + reported children.",
        "API-equivalent estimates, not subscription quota.",
        usage.warning ?? "",
      ].join("\n"),
      actions: [
        { id: "model", label: "By model" },
        { id: "agent", label: "By agent" },
        { id: "requests", label: "Requests" },
      ],
      onAction: (id) =>
        id === "requests"
          ? this.requests()
          : this.usage(id === "model" ? 0 : 1),
    });
  }
  requests() {
    const usage = this.host.snapshot().usage;
    const root = object(usage).rootSession;
    const journal =
      typeof root === "string" ? loadUsageJournal(root) : undefined;
    const records =
      journal?.requests ?? projectUsageRequests(this.host.entries);
    const coverage = journal?.requests
      ? "Reported agents"
      : "Main session only";
    this.overlays.openMenu({
      title: `Requests · ${coverage}`,
      items: [...records].reverse().map((record) => ({
        id: record.id,
        label: `${record.model} · ${formatCost(record.usage.cost)} · ${record.state}`,
        description: `${record.timestamp} · ${record.agent}`,
      })),
      onSelect: (id) => {
        const record = records.find((item) => item.id === id);
        if (!record) return;
        const total = record.usage;
        this.overlays.openText({
          title: "Request usage",
          body: [
            `${record.provider}/${record.model}`,
            record.timestamp,
            record.agent,
            `State: ${record.state}`,
            "",
            ...(total.missingUsage
              ? ["Token usage was not reported."]
              : [
                  `Input: ${formatTokens(total.input)}`,
                  `Cache read: ${formatTokens(total.cacheRead)}`,
                  `Cache write: ${formatTokens(total.cacheWrite)}`,
                  `Output: ${formatTokens(total.output)}`,
                ]),
            `Cost: ${formatCost(total.cost)}`,
            "",
            coverage,
            "API equivalent · not subscription quota",
            ...(journal?.diagnostics.map((item) => item.message) ?? []),
          ].join("\n"),
          actions: [{ id: "back", label: "Back" }],
          onAction: () => this.requests(),
        });
      },
    });
  }
  context() {
    const snapshot = this.host.snapshot();
    this.overlays.openText({
      title: "Context details",
      body: [
        `Context ${snapshot.contextTokens === null ? "unknown" : formatTokens(snapshot.contextTokens)} / ${snapshot.contextWindow ? formatTokens(snapshot.contextWindow) : "—"}`,
        `Compaction: ${this.host.session.autoCompactionEnabled ? "enabled" : "disabled"}`,
        "",
        ...this.host.compactions.flatMap((compaction) => [
          `${formatTokens(compaction.before)} tokens before · ${compaction.provider}/${compaction.model}`,
          `After: ${compaction.after === null ? "not measured" : formatTokens(compaction.after)}`,
          "Monetary savings not measured",
          compaction.summary.slice(0, 4000),
          "",
        ]),
      ].join("\n"),
      actions: [{ id: "compact", label: "Compact now" }],
      onAction: () => this.compact(),
    });
  }
  private async compact() {
    try {
      if (!this.host.session.isIdle)
        throw new Error("Wait for current work before compacting");
      await this.host.compact();
      this.schedule();
    } catch (error) {
      this.showError(error);
    }
  }
  advisor() {
    const notes = newestAdvice(this.host.snapshot().advice);
    const items = notes.map((note) => ({
      id: note.id,
      label: "",
      description: "",
    }));
    const updateDescriptions = () => {
      let changed = false;
      const now = Date.now();
      items.forEach((item, index) => {
        const note = notes[index]!;
        const label = [
          note.advisor,
          adviceAge(note.timestamp, now),
          note.feedback
            ? `${note.feedback.source === "assistant" ? "Executor" : "User"}: ${note.feedback.rating}`
            : undefined,
          note.status,
          note.title || note.text.slice(0, 60),
        ]
          .filter(Boolean)
          .join(" · ");
        const description = [
          note.feedback?.reason,
          this.reviewedAdvice.includes(note.id) ? "✓ Reviewed locally" : undefined,
        ]
          .filter(Boolean)
          .join(" · ");
        if (description !== item.description || label !== item.label) {
          item.label = label;
          item.description = description;
          changed = true;
        }
      });
      return changed;
    };
    updateDescriptions();
    this.overlays.openMenu({
      title: "Advisor history",
      items,
      onCancel: () => {
        this.refreshAdvisor = undefined;
      },
      onSelect: (id) => {
        this.refreshAdvisor = undefined;
        const note = notes.find((note) => note.id === id);
        if (!note) return;
        const body = () =>
          [
            note.title,
            note.text,
            "",
            adviceAge(note.timestamp),
            note.timestamp ? `Recorded: ${note.timestamp}` : "Recorded time unknown",
            adviceFeedback(note),
            this.reviewedAdvice.includes(note.id) ? "✓ Reviewed locally" : undefined,
            note.model,
            note.status === "pending"
              ? "Pending delivery · no conversation message yet"
              : `Related entry: ${note.entryId}`,
            "Advice is a second opinion, not an acceptance verdict.",
          ]
            .filter((line) => line !== undefined)
            .join("\n");
        const options: TextOptions = {
          title: `${note.advisor} · ${note.status}`,
          body: body(),
          onCancel: () => {
            this.refreshAdvisor = undefined;
          },
          actions: [
            ...(note.status === "delivered"
              ? [{ id: "jump", label: "Jump to message" }]
              : []),
            { id: "reviewed", label: "Mark reviewed locally" },
          ],
          onAction: (action) => {
            this.refreshAdvisor = undefined;
            if (action === "jump") this.jump(note.entryId);
            else {
              this.reviewedAdvice = [
                ...new Set([...this.reviewedAdvice, note.id]),
              ];
              this.host.store.savePreferences({
                reviewedAdvice: this.reviewedAdvice,
              });
              this.schedule();
            }
          },
        };
        this.overlays.openText(options);
        this.refreshAdvisor = () => {
          if (this.renderer.getSelection()) return;
          const next = body();
          if (next !== options.body) {
            options.body = next;
            this.overlays.refresh();
          }
        };
      },
    });
    this.refreshAdvisor = () => {
      if (!this.renderer.getSelection() && updateDescriptions())
        this.overlays.refresh();
    };
  }
  private jump(entryId: string) {
    if (!this.shell.revealEntry(entryId))
      this.showError(
        "This entry is not visible on the current branch. Open conversation history to navigate to its branch.",
      );
  }

  tree() {
    const manager = this.host.session.sessionManager;
    const tree = manager.getTree();
    const items: { id: string; label: string; description: string }[] = [];
    const entries = new Map<string, (typeof tree)[number]["entry"]>();
    const pending = tree.map((node) => ({ node, depth: 0 })).reverse();
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      const entry = node.entry;
      entries.set(entry.id, entry);
      const rows = projectTranscript([entry], {
        hasEntryRenderer: (type) =>
          !!this.host.session.extensionRunner.getEntryRenderer(type),
      });
      const summary = rows
        .map((row) => row.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .slice(0, 100);
      items.push({
        id: entry.id,
        label: `${"│ ".repeat(Math.min(depth, 8))}${entry.id === manager.getLeafId() ? "● " : ""}${node.label || rows[0]?.role || entry.type} · ${summary}`,
        description: `${entry.timestamp}${depth > 8 ? ` · depth ${depth}` : ""}`,
      });
      for (const child of [...node.children].reverse())
        pending.push({ node: child, depth: depth + 1 });
    }
    this.overlays.openMenu({
      title: "Conversation history",
      items,
      onSelect: (id) =>
        this.overlays.openText({
          title: "History entry",
          body: JSON.stringify(entries.get(id), null, 2),
          actions: [
            { id: "jump", label: "Jump" },
            { id: "continue", label: "Continue here" },
          ],
          onAction: async (action) => {
            if (action === "jump") this.jump(id);
            else {
              if (!this.host.session.isIdle)
                throw new Error("Stop work before navigating history");
              this.saveDraft();
              const result = await this.host.session.navigateTree(id, {
                summarize: false,
              });
              if (result.cancelled) return;
              if (result.editorText !== undefined)
                this.host.bridge.setEditorText(result.editorText);
              this.shell.jumpLatest();
              this.schedule();
            }
          },
        }),
    });
  }
  settings() {
    return this.settingsPanel.open().catch((error) => this.showError(error));
  }
  connections() {
    return this.connectionsPanel.open();
  }
  private extensions() {
    const bridge = this.host.bridge;
    this.overlays.openText({
      title: "Extensions",
      body: ansiToStyledText([
        ...this.host.session.resourceLoader
          .getExtensions()
          .extensions.map((extension) => extension.path),
        "",
        ...Array.from(bridge.statuses, ([name, value]) => `${name}: ${value}`),
        "",
        ...bridge.renderWidgets(
          Math.max(10, this.renderer.width - 8),
          "aboveEditor",
        ),
        ...bridge.renderWidgets(
          Math.max(10, this.renderer.width - 8),
          "belowEditor",
        ),
        ...bridge.renderHeader(Math.max(10, this.renderer.width - 8)),
        ...bridge.renderFooter(Math.max(10, this.renderer.width - 8)),
      ]),
    });
  }
  private providers() {
    const providers = this.host.session.modelRuntime.getProviders();
    this.overlays.openMenu({
      title: "Connect provider",
      items: providers.map((provider) => ({
        id: provider.id,
        label: provider.name ?? provider.id,
        description: this.host.session.modelRuntime.hasConfiguredAuth(
          provider.id,
        )
          ? "connected"
          : "not connected",
      })),
      onSelect: (id) =>
        this.overlays.openMenu({
          title: "Sign in",
          items: [
            ...(providers.find((provider) => provider.id === id)?.auth.oauth
              ? [{ id: "oauth", label: "Subscription / OAuth" }]
              : []),
            ...(providers.find((provider) => provider.id === id)?.auth.apiKey
              ?.login
              ? [{ id: "api_key", label: "API key" }]
              : []),
          ],
          onSelect: async (type) => {
            this.authAbort?.abort();
            const controller = new AbortController();
            this.authAbort = controller;
            let dismissAuthView = () => {};
            try {
              await this.host.session.modelRuntime.login(
                id,
                type as "oauth" | "api_key",
                {
                  signal: controller.signal,
                  prompt: (prompt) =>
                    new Promise<string>((resolve, reject) => {
                      dismissAuthView();
                      let dismissPrompt = () => {};
                      let settled = false;
                      const cleanup = () => {
                        prompt.signal?.removeEventListener(
                          "abort",
                          abortPrompt,
                        );
                        controller.signal.removeEventListener(
                          "abort",
                          abortPrompt,
                        );
                      };
                      const complete = (value: string) => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        resolve(value);
                      };
                      const abortPrompt = () => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        dismissPrompt();
                        reject(new Error("Sign-in prompt cancelled"));
                      };
                      const cancel = () => controller.abort();
                      if (prompt.signal?.aborted || controller.signal.aborted) {
                        abortPrompt();
                        return;
                      }
                      prompt.signal?.addEventListener("abort", abortPrompt, {
                        once: true,
                      });
                      controller.signal.addEventListener("abort", abortPrompt, {
                        once: true,
                      });
                      if (prompt.type === "select")
                        this.overlays.openMenu({
                          title: prompt.message,
                          items: prompt.options.map((option) => ({
                            id: option.id,
                            label: option.label,
                            description: option.description,
                          })),
                          onSelect: complete,
                          onCancel: cancel,
                        });
                      else
                        this.overlays.openInput({
                          title: prompt.message,
                          secret: prompt.type === "secret",
                          onSubmit: complete,
                          onCancel: cancel,
                        });
                      dismissPrompt = this.overlays.captureDismissal();
                      dismissAuthView = dismissPrompt;
                    }),
                  notify: (event) => {
                    if (controller.signal.aborted) return;
                    if (
                      event.type === "auth_url" ||
                      event.type === "device_code"
                    )
                      dismissAuthView();
                    if (event.type === "auth_url")
                      this.overlays.openText({
                        title: "Continue sign-in",
                        keepOpenOnAction: true,
                        onCancel: () => controller.abort(),
                        body: `${event.instructions ?? "Open this link to sign in:"}\n\n${event.url}`,
                        actions: [
                          { id: "open", label: "Open browser" },
                          { id: "copy", label: "Copy link" },
                        ],
                        onAction: (action) => {
                          if (action === "copy")
                            this.renderer.copyToClipboardOSC52(event.url);
                          else this.openUrl(event.url);
                        },
                      });
                    else if (event.type === "device_code")
                      this.overlays.openText({
                        title: "Device sign-in",
                        keepOpenOnAction: true,
                        actions: [
                          { id: "open", label: "Open browser" },
                          { id: "copy", label: "Copy link" },
                        ],
                        onAction: (action) => {
                          if (action === "copy")
                            this.renderer.copyToClipboardOSC52(
                              event.verificationUri,
                            );
                          else this.openUrl(event.verificationUri);
                        },
                        onCancel: () => controller.abort(),
                        body: `${event.verificationUri}\n\nCode: ${event.userCode}`,
                      });
                    else this.host.bridge.notify(event.message, "info");
                    if (
                      event.type === "auth_url" ||
                      event.type === "device_code"
                    )
                      dismissAuthView = this.overlays.captureDismissal();
                  },
                },
              );
              if (controller.signal.aborted) return;
              this.host.bridge.notify("Provider connected", "info");
              this.schedule();
            } catch (error) {
              if (!controller.signal.aborted) throw error;
            } finally {
              dismissAuthView();
              if (this.authAbort === controller) this.authAbort = undefined;
            }
          },
        }),
    });
  }
  private openUrl(url: string) {
    if (!/^https?:\/\//.test(url)) throw new Error("Unsupported sign-in link");
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "rundll32"
          : "xdg-open";
    const args =
      process.platform === "win32"
        ? ["url.dll,FileProtocolHandler", url]
        : [url];
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", (error) => this.showError(error));
    child.unref();
  }
  private showExtensionDialog() {
    const bridge = this.host.bridge,
      dialog = bridge.activeDialog;
    if (!dialog) return;
    if (dialog.kind === "custom" && dialog.options?.overlay) {
      if (this.dialogId !== undefined && !this.dialogSurface)
        this.overlays.dismiss();
      this.dialogBridge = bridge;
      this.dialogId = dialog.id;
      this.dialogSurface = true;
      const surface = bridge.renderCustomOverlay();
      this.overlays.setNativeSurface(
        surface
          ? {
              ...surface.bounds,
              content: ansiToStyledText(surface.lines),
              focused: surface.focused,
              onInput: (raw) => bridge.handleCustomInput(raw),
              onCancel: () => {
                if (bridge.activeDialog?.id === dialog.id)
                  bridge.cancelDialog();
              },
              onFocus: () => dialog.overlayHandle?.focus(),
            }
          : undefined,
      );
      return;
    }
    if (this.dialogId === dialog.id && this.dialogBridge === bridge) return;
    this.overlays.setNativeSurface(undefined);
    this.dialogSurface = false;
    this.dialogBridge = bridge;
    this.dialogId = dialog.id;
    const cancel = () => {
      if (bridge.activeDialog?.id === dialog.id) bridge.cancelDialog();
    };
    if (dialog.kind === "custom")
      this.overlays.openNative({
        title: "Extension",
        render: (width) => ansiToStyledText(bridge.renderCustom(width)),
        onInput: (raw) => bridge.handleCustomInput(raw),
        onCancel: cancel,
      });
    else if (dialog.kind === "select")
      this.overlays.openMenu({
        title: dialog.title,
        items: dialog.options.map((label, index) => ({
          id: String(index),
          label,
        })),
        onSelect: (id) => {
          if (bridge.activeDialog?.id === dialog.id)
            bridge.resolveDialog(dialog.options[Number(id)]);
        },
        onCancel: cancel,
      });
    else if (dialog.kind === "confirm")
      this.overlays.openMenu({
        title: dialog.title,
        items: [
          { id: "yes", label: "Yes", description: dialog.message },
          { id: "no", label: "No" },
        ],
        onSelect: (id) => {
          if (bridge.activeDialog?.id === dialog.id)
            bridge.resolveDialog(id === "yes");
        },
        onCancel: cancel,
      });
    else
      this.overlays.openInput({
        title: dialog.title,
        value: dialog.kind === "editor" ? dialog.prefill : undefined,
        multiline: dialog.kind === "editor",
        onSubmit: (value) => {
          if (bridge.activeDialog?.id === dialog.id)
            bridge.resolveDialog(value);
        },
        onCancel: cancel,
      });
  }
  showError(error: unknown) {
    this.overlays.openText({
      title: "Action failed",
      body: error instanceof Error ? error.message : String(error),
      actions: [
        { id: "retry", label: "Retry last request" },
        { id: "model", label: "Choose model" },
      ],
      onAction: async (action) => {
        if (action === "model") this.models();
        else {
          const last = this.host.transcript
            .filter((row) => row.role === "user" && row.kind === "text")
            .at(-1);
          if (last) await this.submit(last.text);
        }
      },
    });
  }
  async exit() {
    if (!this.host.session.isIdle) {
      const confirmed = await this.host.bridge.confirm(
        "Stop current work?",
        "Save the session and exit",
      );
      if (!confirmed) return;
      await this.host.abort();
    }
    this.saveDraft();
    this.dispose();
    try {
      await this.host.close();
    } finally {
      await this.onExit();
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.refreshAdvisor = undefined;
    this.settingsPanel.cancel(false);
    this.authAbort?.abort();
    clearTimeout(this.saveTimer);
    clearTimeout(this.toastTimer);
    clearTimeout(this.workingTimer);
    clearTimeout(this.leaderTimer);
    clearTimeout(this.selectionCopyTimer);
    clearInterval(this.poll);
    this.host.off("before_session_change", this.beforeSessionChange);
    this.host.off("before_ui_reset", this.beforeUiReset);
    this.host.off("change", this.onChange);
    this.host.off("submit", this.onSubmit);
    this.host.off("host_error", this.onError);
    this.host.off("shutdown", this.onShutdown);
    this.renderer.keyInput.off("keypress", this.onKey);
    this.renderer.keyInput.off("paste", this.onPaste);
    this.renderer.off("resize", this.onResize);
    this.renderer.off("frame", this.onFrame);
    this.renderer.off("selection", this.onSelection);
    this.shell.transcript.verticalScrollBar.off(
      "change",
      this.onViewportChange,
    );
    this.shell.sidebar.verticalScrollBar.off("change", this.onViewportChange);
    this.overlays.dispose();
    this.shell.dispose();
  }
}
