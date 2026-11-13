import { EventEmitter } from "node:events";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import {
  CombinedAutocompleteProvider,
  fuzzyFilter,
  type SlashCommand,
  type AutocompleteItem,
  type AutocompleteProvider,
  type Component,
} from "@earendil-works/pi-tui";
import type { SourceInfo } from "@earendil-works/pi-coding-agent";
import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  createCodemodeExtension,
  createToolSearchExtension,
  createMcpExtension,
  CustomEditor,
  SessionManager,
  getAgentDir,
  keyHint,
  keyText,
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
  type ExtensionCommandContextActions,
} from "@earendil-works/pi-coding-agent";
import { ExtensionUIBridge } from "./extension-ui.ts";
import { createAdvisorFeedbackExtension } from "./advisor-feedback.ts";
import { ProjectionCache } from "../core/projection-cache.ts";
import { CompactionState } from "../core/compaction-state.ts";
import { UiStore } from "../core/ui-store.ts";
import type { TranscriptItem } from "../core/session-data.ts";
import type { ShellState } from "../ui/shell.ts";

const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const {
  BUILTIN_SLASH_COMMANDS,
}: typeof import("../../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js") =
  await import(new URL("./core/slash-commands.js", sdkEntry).href);
const {
  getToolPath,
}: typeof import("../../node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js") =
  await import(new URL("./utils/tools-manager.js", sdkEntry).href);
const createIgnore: typeof import("ignore") = createRequire(sdkEntry)("ignore");
export function createHostAutocompleteProvider(
  commands: SlashCommand[],
  cwd: string,
  fdPath: string | null,
): AutocompleteProvider {
  const base = new CombinedAutocompleteProvider(commands, cwd, fdPath);
  if (fdPath) return base;
  return {
    applyCompletion: base.applyCompletion.bind(base),
    shouldTriggerFileCompletion: base.shouldTriggerFileCompletion.bind(base),
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const suggestions = await base.getSuggestions(
        lines,
        cursorLine,
        cursorCol,
        options,
      );
      if (suggestions || options.signal.aborted) return suggestions;
      const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const match = /(?:^|\s)(@(?:"[^"\n]*|[^\s"]*))$/.exec(before);
      if (!match) return null;
      const prefix = match[1]!,
        quoted = prefix.startsWith('@"');
      const query = prefix.slice(quoted ? 2 : 1);
      const slash = query.lastIndexOf("/");
      const displayBase = slash >= 0 ? query.slice(0, slash + 1) : "";
      const needle = slash >= 0 ? query.slice(slash + 1) : query;
      const directory = displayBase.startsWith("~/")
        ? join(homedir(), displayBase.slice(2))
        : resolve(cwd, displayBase || ".");
      type IgnoreRule = {
        base: string;
        ignore: ReturnType<typeof createIgnore>;
      };
      const readRules = async (path: string): Promise<IgnoreRule> => {
        const matcher = createIgnore();
        for (const name of [".gitignore", ".ignore", ".fdignore"]) {
          try {
            matcher.add(await readFile(join(path, name), "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        return { base: path, ignore: matcher };
      };
      const ignored = (
        rules: IgnoreRule[],
        path: string,
        suffix: string,
      ): boolean => {
        let result = false;
        for (const rule of rules) {
          const match = rule.ignore.test(
            relative(rule.base, path).replaceAll("\\", "/") + suffix,
          );
          if (match.ignored) result = true;
          else if (match.unignored) result = false;
        }
        return result;
      };
      const ancestors: string[] = [],
        relativeBase = relative(cwd, directory);
      if (
        relativeBase &&
        relativeBase !== ".." &&
        !relativeBase.startsWith(`..${sep}`) &&
        !isAbsolute(relativeBase)
      ) {
        let parent = dirname(directory);
        while (parent !== resolve(cwd)) {
          ancestors.unshift(parent);
          const next = dirname(parent);
          if (next === parent) break;
          parent = next;
        }
        ancestors.unshift(resolve(cwd));
      }
      const inherited = await Promise.all(ancestors.map(readRules));
      const queue: { path: string; rules: IgnoreRule[] }[] = [
        { path: directory, rules: inherited },
      ];
      const items: AutocompleteItem[] = [];
      let visited = 0;
      for (
        let index = 0;
        index < queue.length && visited < 10_000 && !options.signal.aborted;
        index++
      ) {
        const current = queue[index]!;
        if (current.rules.length && ignored(current.rules, current.path, "/"))
          continue;
        const rules = [...current.rules, await readRules(current.path)];
        let entries: import("node:fs").Dirent<string>[];
        try {
          entries = await readdir(current.path, { withFileTypes: true });
        } catch (error) {
          if (
            ["ENOENT", "ENOTDIR"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            continue;
          throw error;
        }
        for (const entry of entries) {
          if (++visited > 10_000 || options.signal.aborted) break;
          if (
            entry.name === ".git" ||
            (!entry.isFile() && !entry.isDirectory())
          )
            continue;
          const path = join(current.path, entry.name),
            suffix = entry.isDirectory() ? "/" : "";
          if (ignored(rules, path, suffix)) continue;
          const display =
            displayBase +
            relative(directory, path).replaceAll("\\", "/") +
            suffix;
          const completion =
            quoted || /\s/.test(display) ? `@"${display}"` : `@${display}`;
          items.push({
            value: completion,
            label: entry.name + suffix,
            description: display,
          });
          if (entry.isDirectory()) queue.push({ path, rules });
        }
      }
      if (options.signal.aborted) return null;
      const ranked = fuzzyFilter(
        items,
        needle,
        (item) => item.description ?? item.label,
      ).slice(0, 20);
      return ranked.length ? { items: ranked, prefix } : null;
    },
  };
}
export interface HostCompletionCommand extends SlashCommand {
  source: "builtin" | "extension" | "prompt" | "skill";
  sourceInfo?: SourceInfo;
}
export interface HostOptions {
  cwd: string;
  agentDir?: string;
  sessionFile?: string;
  continueRecent?: boolean;
  clean?: boolean;
  deferBind?: boolean;
  extensionFactories?: ExtensionFactory[];
  uiDirectory?: string;
}
export const hostEditorFactory: NonNullable<
  Parameters<ExtensionUIBridge["setEditorComponent"]>[0]
> = (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings);
export const replacedPresentation = (path: string) =>
  /(?:^|[/\\])(?:ui-extension|sidebar-tui)(?:[/\\]|$)/.test(path) ||
  /[/\\]opencode-background\.[cm]?[jt]s$/.test(path);
export class PiHost extends EventEmitter {
  runtime!: AgentSessionRuntime;
  bridge: ExtensionUIBridge;
  readonly store: UiStore;
  readonly options: HostOptions;
  readonly diagnostics: string[] = [];
  private unsubscribe?: () => void;
  private liveMessage?: unknown;
  private liveId = "";
  private liveRevision = 0;
  private compactionState = new CompactionState();
  private projections = new ProjectionCache({
    isCompactionInterruption: (entryId) => this.compactionState.interrupted.has(entryId),
    hasEntryRenderer: (customType) =>
      !!this.session.extensionRunner.getEntryRenderer(customType),
  });
  private customBlocks = new Map<string, {
    row: TranscriptItem;
    expanded: boolean;
    renderer: unknown;
    themeColors: unknown;
    component?: Component;
    error?: string;
  }>();
  private metadata?: {
    revision: number;
    model: AgentSession["model"];
    context: ReturnType<AgentSession["getContextUsage"]>;
    title: string;
  };
  private closed = false;
  private bridgeUnsubscribe?: () => void;
  private completionCatalog: HostCompletionCommand[] = [];
  private frontendCommands: { name: string; description: string }[] = [];
  private completionBridge?: ExtensionUIBridge;
  private completionFd: string | null = null;
  private completionSession?: AgentSession;
  constructor(options: HostOptions) {
    super();
    this.options = {
      ...options,
      cwd: resolve(options.cwd),
      agentDir: options.agentDir ?? getAgentDir(),
    };
    this.store = new UiStore(
      options.uiDirectory ?? join(this.options.agentDir!, "pi-opentui"),
    );
    this.bridge = new ExtensionUIBridge({
      cwd: this.options.cwd,
      onSubmit: (text: string) => {
        this.emit("submit", text);
      },
    });
    this.bridge.setToolsExpanded(
      this.store.loadPreferences().toolsExpanded ?? false,
    );
  }
  static async create(options: HostOptions) {
    const host = new PiHost(options);
    try {
      await host.start();
      return host;
    } catch (error) {
      host.bridge.dispose();
      throw error;
    }
  }
  get session(): AgentSession {
    return this.runtime.session;
  }
  private async start() {
    const create: CreateAgentSessionRuntimeFactory = async ({
      cwd,
      agentDir,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        resourceLoaderOptions: {
          noExtensions: this.options.clean === true,
          extensionFactories: [
            createCodemodeExtension(),
            createToolSearchExtension(),
            createAdvisorFeedbackExtension(),
            ...(!this.options.clean ? [createMcpExtension()] : []),
            ...(this.options.extensionFactories ?? []),
          ],
          extensionsOverride: (base) => ({
            ...base,
            extensions: base.extensions.filter((extension) => {
              const replace =
                replacedPresentation(extension.resolvedPath) ||
                replacedPresentation(extension.path);
              if (replace)
                this.diagnostics.push(
                  `Presentation replaced: ${basename(extension.path)}`,
                );
              return !replace;
            }),
          }),
        },
      });
      const result = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
      });
      return { ...result, services, diagnostics: services.diagnostics };
    };
    const agentDir = this.options.agentDir!;
    mkdirSync(agentDir, { recursive: true });
    const sessionDir = join(
      agentDir,
      "sessions",
      `--${this.options.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
    );
    const manager = this.options.sessionFile
      ? SessionManager.open(this.options.sessionFile)
      : this.options.continueRecent
        ? SessionManager.continueRecent(this.options.cwd, sessionDir)
        : SessionManager.create(this.options.cwd, sessionDir);
    this.runtime = await createAgentSessionRuntime(create, {
      cwd: manager.getCwd(),
      agentDir,
      sessionManager: manager,
    });
    this.runtime.setRebindSession(() => this.bind());
    this.runtime.setBeforeSessionInvalidate(() => {
      this.emit("before_session_change");
      this.compactionState.clear();
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.bridgeUnsubscribe?.();
      this.bridge.dispose();
    });
    if (!this.options.deferBind) await this.bind();
  }
  async attach() {
    await this.bind();
  }
  private async bind() {
    this.compactionState.clear();
    this.unsubscribe?.();
    this.bridgeUnsubscribe?.();
    this.bridge.dispose();
    this.bridge = new ExtensionUIBridge({
      cwd: this.runtime.cwd,
      onSubmit: (text: string) => {
        this.emit("submit", text);
      },
    });
    this.bridge.setEditorComponent(hostEditorFactory);
    this.bridge.setToolsExpanded(
      this.store.loadPreferences().toolsExpanded ?? false,
    );
    this.configureCompletions(true);
    this.bridgeUnsubscribe = this.bridge.onChange(() => this.emit("change"));
    this.liveMessage = undefined;
    this.liveRevision++;
    this.invalidateProjection();
    const actions: ExtensionCommandContextActions = {
      waitForIdle: () => this.session.waitForIdle(),
      newSession: (options) => this.runtime.newSession(options),
      fork: (id, options) => this.runtime.fork(id, options),
      switchSession: (path, options) =>
        this.runtime.switchSession(path, options),
      navigateTree: async (id, options) => {
        const result = await this.session.navigateTree(id, options);
        if (!result.cancelled) {
          if (result.editorText !== undefined)
            this.bridge.setEditorText(result.editorText);
          this.emit("change");
        }
        return result;
      },
      reload: () => this.reload(),
    };
    this.unsubscribe = this.session.subscribe((event) => {
      const manuallyRequested = this.compactionState.manualRequested;
      this.compactionState.handle(event, this.session.sessionManager);
      if (event.type === "compaction_end") {
        if (event.aborted) this.bridge.notify("Compaction cancelled", "info");
        else if (event.errorMessage && !manuallyRequested)
          this.bridge.notify(event.errorMessage, "error");
      }
      if (event.type === "compaction_start" || event.type === "compaction_end")
        this.invalidateProjection();
      if (event.type === "message_update") {
        this.liveMessage = event.message;
        this.liveId = `live:${event.message.timestamp ?? Date.now()}`;
        this.liveRevision++;
      }
      if (event.type === "message_end" || event.type === "agent_settled") {
        this.liveMessage = undefined;
        this.liveRevision++;
      }
      this.emit("event", event);
      this.emit("change");
    });
    await this.session.bindExtensions({
      mode: "tui",
      uiContext: this.bridge,
      commandContextActions: actions,
      abortHandler: () => {
        void this.session.abort().catch((error) => this.report(error));
      },
      shutdownHandler: () => {
        this.emit("shutdown");
      },
      onError: (error) =>
        this.report(new Error(`${error.extensionPath}: ${error.error}`)),
    });
    this.configureCompletions();
    this.emit("session", this.session.sessionFile);
    this.emit("change");
  }
  private report(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.diagnostics.push(message);
    this.emit("host_error", message);
    this.emit("change");
  }
  invalidateProjection(): void {
    this.projections.invalidate();
    this.customBlocks.clear();
    this.metadata = undefined;
  }
  renderCustomBlock(
    row: TranscriptItem,
    expanded: boolean,
    width: number,
  ): string[] | undefined {
    if (!row.customType || (!row.customEntry && !row.customMessage))
      return undefined;
    const runner = this.session.extensionRunner;
    const renderer = row.customEntry
      ? runner.getEntryRenderer(row.customType)
      : runner.getMessageRenderer(row.customType);
    if (!renderer) return undefined;
    const themeColors = this.bridge.theme.colors;
    let cached = this.customBlocks.get(row.id);
    if (
      !cached || cached.row !== row || cached.expanded !== expanded ||
      cached.renderer !== renderer || cached.themeColors !== themeColors
    ) {
      cached = { row, expanded, renderer, themeColors };
      this.customBlocks.delete(row.id);
      this.customBlocks.set(row.id, cached);
      while (this.customBlocks.size > 128)
        this.customBlocks.delete(this.customBlocks.keys().next().value!);
      try {
        cached.component = row.customEntry
          ? runner.getEntryRenderer(row.customType)!(
              row.customEntry,
              { expanded, keyHint, keyText },
              this.bridge.theme,
            )
          : runner.getMessageRenderer(row.customType)!(
              row.customMessage!,
              { expanded, outputPad: 1, keyHint, keyText },
              this.bridge.theme,
            );
      } catch (error) {
        cached.error = `[${row.customType}] renderer failed: ${error instanceof Error ? error.message : String(error)}`;
        this.report(new Error(cached.error));
      }
    } else {
      this.customBlocks.delete(row.id);
      this.customBlocks.set(row.id, cached);
    }
    if (cached.error) return [cached.error];
    if (!cached.component) return row.customEntry ? [] : undefined;
    try {
      cached.component.invalidate();
      return cached.component.render(Math.max(1, Math.floor(width)));
    } catch (error) {
      cached.error = `[${row.customType}] renderer failed: ${error instanceof Error ? error.message : String(error)}`;
      this.report(new Error(cached.error));
      return [cached.error];
    }
  }
  private syncProjection(): ProjectionCache {
    this.projections.sync(
      this.session.sessionManager,
      this.liveMessage
        ? { type: "message", id: this.liveId, message: this.liveMessage }
        : undefined,
      this.liveRevision,
    );
    return this.projections;
  }
  get projectionRevision(): number {
    return this.syncProjection().revision;
  }
  get entries(): unknown[] {
    return this.syncProjection().entries;
  }
  get transcript() {
    return this.syncProjection().transcript;
  }
  get toolResults() {
    return this.syncProjection().toolResults;
  }
  snapshot(): ShellState {
    const projection = this.syncProjection();
    if (
      !this.metadata ||
      this.metadata.revision !== projection.baseRevision ||
      this.metadata.model !== this.session.model
    ) {
      this.metadata = {
        revision: projection.baseRevision,
        model: this.session.model,
        context: this.session.getContextUsage(),
        title: this.session.sessionName ?? "New session",
      };
    }
    const context = this.metadata.context;
    const extensions = this.session.resourceLoader.getExtensions().extensions;
    return {
      project: basename(this.runtime.cwd),
      title: this.metadata.title,
      model: this.session.model?.name ?? "Choose a model",
      reasoning: this.session.thinkingLevel,
      ...(this.compactionState.active ? { compaction: { ...this.compactionState.active } } : {}),
      status: this.compactionState.active
        ? "compacting"
        : this.bridge.dialogCapturesInput
        ? "waiting for input"
        : this.session.isStreaming
          ? "working"
          : "idle",
      contextTokens: context?.tokens ?? null,
      contextWindow:
        context?.contextWindow ?? this.session.model?.contextWindow ?? null,
      usage: projection.usage(this.session.sessionFile),
      advice: projection.advice,
      advisorAvailable: extensions.some((e) => /advisor/.test(e.path)),
    };
  }
  get compactions() {
    return this.syncProjection().compactions;
  }
  async send(text: string, steer = false) {
    if (!text.trim()) return;
    try {
      await this.session.prompt(text, {
        source: "interactive",
        ...(this.session.isStreaming
          ? { streamingBehavior: steer ? "steer" : "followUp" }
          : {}),
      });
    } catch (error) {
      this.report(error);
      throw error;
    }
  }
  async compact() {
    if (this.compactionState.active || this.session.isCompacting)
      throw new Error("Context compaction is already running");
    const session = this.session;
    this.compactionState.beginManual();
    this.emit("change");
    try {
      return await session.compact();
    } catch (error) {
      if (this.compactionState.cancelled) return undefined;
      throw error;
    } finally {
      if (this.session === session) {
        this.compactionState.clear();
        this.invalidateProjection();
        this.emit("change");
      }
    }
  }
  async abort() {
    this.compactionState.userAbort();
    await this.session.abort();
    this.emit("change");
  }
  async reload() {
    await this.session.waitForIdle();
    await this.session.reload({
      beforeSessionStart: () => {
        this.emit("before_ui_reset");
        this.bridge.resetSessionUI();
        this.bridge.setEditorComponent(hostEditorFactory);
        this.bridge.setToolsExpanded(
          this.store.loadPreferences().toolsExpanded ?? false,
        );
        this.invalidateProjection();
        this.configureCompletions(true);
      },
    });
    this.configureCompletions();
    this.emit("change");
  }
  async newSession() {
    if (!this.session.isIdle)
      throw new Error("Stop current work before starting a new session");
    return this.runtime.newSession();
  }
  async switchSession(path: string) {
    if (!this.session.isIdle)
      throw new Error("Stop current work before switching sessions");
    return this.runtime.switchSession(path);
  }
  async listSessions(all = false) {
    return all
      ? SessionManager.listAll(join(this.options.agentDir!, "sessions"))
      : SessionManager.list(
          this.runtime.cwd,
          this.session.sessionManager.getSessionDir(),
        );
  }
  commands() {
    return this.session.extensionRunner
      .getRegisteredCommands()
      .map((command) => ({
        name: command.invocationName,
        description: command.description ?? "",
        getArgumentCompletions: command.getArgumentCompletions,
      }));
  }
  setFrontendCommands(
    commands: readonly { name: string; description: string }[],
  ): void {
    this.frontendCommands = commands.map((command) => ({ ...command }));
    this.configureCompletions(true);
  }
  completionCommands(): readonly HostCompletionCommand[] {
    this.configureCompletions();
    return this.completionCatalog;
  }
  private configureCompletions(force = false): void {
    if (this.completionSession !== this.session || force) {
      const managed = join(
        this.options.agentDir!,
        "bin",
        process.platform === "win32" ? "fd.exe" : "fd",
      );
      this.completionFd = existsSync(managed) ? managed : getToolPath("fd");
      this.completionSession = this.session;
    }
    const next: HostCompletionCommand[] = BUILTIN_SLASH_COMMANDS.map(
      (command) => ({ ...command, source: "builtin" }),
    );
    const known = new Set(next.map((command) => command.name));
    const append = (command: HostCompletionCommand) => {
      if (!known.has(command.name)) {
        known.add(command.name);
        next.push(command);
      }
    };
    for (const command of this.frontendCommands)
      append({ ...command, source: "builtin" });
    for (const command of this.session.extensionRunner.getRegisteredCommands())
      append({
        name: command.invocationName,
        description: command.description,
        getArgumentCompletions: command.getArgumentCompletions,
        source: "extension",
        sourceInfo: command.sourceInfo,
      });
    for (const prompt of this.session.promptTemplates)
      append({
        name: prompt.name,
        description: prompt.description,
        argumentHint: prompt.argumentHint,
        source: "prompt",
        sourceInfo: prompt.sourceInfo,
      });
    if (this.session.settingsManager.getEnableSkillCommands())
      for (const skill of this.session.resourceLoader.getSkills().skills)
        append({
          name: `skill:${skill.name}`,
          description: skill.description,
          source: "skill",
          sourceInfo: skill.sourceInfo,
        });
    const equal =
      !force &&
      this.completionBridge === this.bridge &&
      next.length === this.completionCatalog.length &&
      next.every((command, index) => {
        const old = this.completionCatalog[index]!;
        return (
          command.name === old.name &&
          command.description === old.description &&
          command.argumentHint === old.argumentHint &&
          command.source === old.source &&
          (command.source === "builtin" ||
            command.getArgumentCompletions === old.getArgumentCompletions) &&
          command.sourceInfo?.path === old.sourceInfo?.path
        );
      });
    if (equal) return;
    const suggestions = (items: AutocompleteItem[], prefix: string) =>
      fuzzyFilter(
        items,
        prefix,
        (item) => `${item.value} ${item.label} ${item.description ?? ""}`,
      );
    const models = next.find((command) => command.name === "model");
    if (models)
      models.getArgumentCompletions = (prefix) =>
        suggestions(
          [
            ...(this.session.scopedModels.length
              ? this.session.scopedModels.map((scope) => scope.model)
              : this.session.modelRuntime.getAvailableSnapshot()),
          ].map((model) => ({
            value: `${model.provider}/${model.id}`,
            label: model.id,
            description: model.provider,
          })),
          prefix,
        );
    const thinking = next.find((command) => command.name === "thinking");
    if (thinking)
      thinking.getArgumentCompletions = (prefix) =>
        suggestions(
          this.session
            .getAvailableThinkingLevels()
            .map((level) => ({ value: level, label: level })),
          prefix,
        );
    const login = next.find((command) => command.name === "login");
    if (login)
      login.getArgumentCompletions = (prefix) =>
        suggestions(
          this.session.modelRuntime
            .getProviders()
            .filter(
              (provider) => provider.auth.oauth || provider.auth.apiKey?.login,
            )
            .map((provider) => ({
              value: provider.id,
              label: provider.id,
              description: provider.name,
            })),
          prefix,
        );
    this.completionCatalog = next;
    this.completionBridge = this.bridge;
    this.bridge.setBaseAutocompleteProvider(
      createHostAutocompleteProvider(next, this.runtime.cwd, this.completionFd),
    );
  }
  async selectModel(provider: string, id: string) {
    await this.session.waitForIdle();
    const model = this.session.modelRuntime.getModel(provider, id);
    if (!model)
      throw new Error("Model is not available in the configured catalog");
    await this.session.setModel(model);
    this.emit("change");
  }
  setThinking(level: Parameters<AgentSession["setThinkingLevel"]>[0]) {
    if (!this.session.isIdle)
      throw new Error("Apply reasoning changes after current work completes");
    this.session.setThinkingLevel(level);
    this.emit("change");
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.compactionState.clear();
    await this.runtime?.dispose();
    this.unsubscribe?.();
    this.bridgeUnsubscribe?.();
    this.bridge.dispose();
    this.customBlocks.clear();
    this.projections.clear();
    this.metadata = undefined;
    this.removeAllListeners();
  }
}
