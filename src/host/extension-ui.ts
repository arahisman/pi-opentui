import {
  CustomEditor,
  type ExtensionUIContext,
  type ExtensionUIDialogOptions,
  type ExtensionWidgetOptions,
  type TerminalInputHandler,
  Theme,
  type ThemeColor,
  type ThemeBg,
  type KeybindingsManager,
  type ReadonlyFooterDataProvider,
  type WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  sliceByColumn,
  type OverlayHandle,
  type OverlayBounds,
  type AutocompleteProvider,
  type Component,
  type EditorComponent,
  type EditorTheme,
  type OverlayOptions,
} from "@earendil-works/pi-tui";
import { NativeComponentHost } from "./native-components.ts";
import { palette } from "../theme.ts";

const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const themes: typeof import("../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js") =
  await import(new URL("./modes/interactive/theme/theme.js", sdkEntry).href);
const keys: typeof import("../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js") =
  await import(new URL("./core/keybindings.js", sdkEntry).href);
const {
  THEME_TOKENS,
}: typeof import("../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-tokens.js") =
  await import(
    new URL("./modes/interactive/theme/theme-tokens.js", sdkEntry).href
  );
class NativeTheme extends Theme {
  override bold(text: string): string {
    return this.style(text, { bold: true });
  }
  override italic(text: string): string {
    return this.style(text, { italic: true });
  }
  override underline(text: string): string {
    return this.style(text, { underline: true });
  }
  override inverse(text: string): string {
    return this.style(text, { inverse: true });
  }
  override strikethrough(text: string): string {
    return this.style(text, { strikethrough: true });
  }
}
export function createNativeTheme(): Theme {
  const foreground = {} as Record<ThemeColor, string>;
  const background = {} as Record<ThemeBg, string>;
  const overrides: Record<string, string> = {
    accent: palette.primary,
    border: palette.border,
    borderAccent: palette.borderActive,
    borderMuted: palette.borderSubtle,
    success: palette.success,
    error: palette.error,
    warning: palette.warning,
    muted: palette.textMuted,
    dim: palette.textMuted,
    thinkingText: palette.textMuted,
    scrollbarTrack: palette.borderSubtle,
    scrollbarThumb: palette.textMuted,
    customMessageLabel: palette.accent,
    toolTitle: palette.primary,
    mdCodeBlockBorder: palette.border,
    mdQuoteBorder: palette.markdownBlockQuote,
    thinkingOff: palette.border,
    thinkingMinimal: palette.textMuted,
    thinkingLow: palette.info,
    thinkingMedium: palette.secondary,
    thinkingHigh: palette.accent,
    thinkingXhigh: palette.primary,
    thinkingMax: palette.warning,
    bashMode: palette.success,
    mdHeading: palette.markdownHeading,
    mdLink: palette.markdownLink,
    mdLinkUrl: palette.markdownLinkText,
    mdCode: palette.markdownCode,
    mdCodeBlock: palette.markdownCodeBlock,
    mdQuote: palette.markdownBlockQuote,
    mdHr: palette.markdownHorizontalRule,
    mdListBullet: palette.markdownListItem,
    toolDiffAdded: palette.diffAdded,
    toolDiffRemoved: palette.diffRemoved,
    toolDiffContext: palette.diffContext,
    selectedBg: palette.backgroundElement,
    searchMatchBg: palette.primary,
    searchMatchText: palette.background,
    userMessageBg: palette.backgroundPanel,
    customMessageBg: palette.backgroundPanel,
    toolPendingBg: palette.backgroundPanel,
    toolSuccessBg: palette.diffAddedBg,
    toolErrorBg: palette.diffRemovedBg,
    syntaxComment: palette.syntaxComment,
    syntaxKeyword: palette.syntaxKeyword,
    syntaxFunction: palette.syntaxFunction,
    syntaxVariable: palette.syntaxVariable,
    syntaxString: palette.syntaxString,
    syntaxNumber: palette.syntaxNumber,
    syntaxType: palette.syntaxType,
    syntaxOperator: palette.syntaxOperator,
    syntaxPunctuation: palette.syntaxPunctuation,
  };
  for (const [token, descriptor] of Object.entries(THEME_TOKENS)) {
    if (descriptor.slot === "foreground")
      foreground[token as ThemeColor] = overrides[token] ?? palette.text;
    else
      background[token as ThemeBg] =
        overrides[token] ?? palette.backgroundPanel;
  }
  return new NativeTheme(foreground, background, "truecolor", {
    name: "opencode",
    appearance: "dark",
  });
}
type OwnedComponent = Component & { dispose?(): void };
type EditorFactory = NonNullable<
  Parameters<ExtensionUIContext["setEditorComponent"]>[0]
>;
type WidgetFactory = (tui: NativeComponentHost, theme: Theme) => OwnedComponent;
export type ExtensionDialog = {
  id: number;
  title: string;
  deadline?: number;
} & (
  | { kind: "select"; options: string[] }
  | { kind: "confirm"; message: string }
  | { kind: "input"; placeholder?: string }
  | { kind: "editor"; prefill?: string }
  | {
      kind: "custom";
      component?: OwnedComponent;
      hidden: boolean;
      overlayHandle?: OverlayHandle;
      options?: Parameters<ExtensionUIContext["custom"]>[1];
    }
);
type PendingDialog = {
  view: ExtensionDialog;
  finish(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
  activate?(): void;
};
export interface ExtensionUIBridgeOptions {
  cwd?: string;
  theme?: Theme;
  keybindings?: KeybindingsManager;
  footerData?: ReadonlyFooterDataProvider;
  autocompleteProvider?: AutocompleteProvider;
  columns?: number;
  rows?: number;
  onSubmit?: (text: string) => void;
}
export class UserCancelledInteractionError extends Error {
  constructor() {
    super("User cancelled the extension interaction");
    this.name = "UserCancelledInteractionError";
  }
}
export class ExtensionUIBridge implements ExtensionUIContext {
  readonly native: NativeComponentHost;
  readonly keybindings: KeybindingsManager;
  readonly statuses = new Map<string, string>();
  readonly widgets = new Map<
    string,
    {
      content: string[] | OwnedComponent;
      placement: "aboveEditor" | "belowEditor";
    }
  >();
  readonly notifications: {
    message: string;
    type: "info" | "warning" | "error";
  }[] = [];
  header?: OwnedComponent;
  footer?: OwnedComponent;
  editorComponent: EditorComponent;
  workingMessage?: string;
  workingVisible = true;
  workingIndicator?: WorkingIndicatorOptions;
  hiddenThinkingLabel?: string;
  toolsExpanded = false;
  private currentTheme: Theme;
  private themeProxy = new Proxy({} as Theme, {
    get: (_target, key) => {
      const value = Reflect.get(this.currentTheme, key, this.currentTheme);
      return typeof value === "function"
        ? value.bind(this.currentTheme)
        : value;
    },
  });
  private overlayLayouts = new WeakMap<ExtensionDialog, OverlayOptions>();
  private editorFactory?: EditorFactory;
  private autocomplete: AutocompleteProvider;
  private baseAutocomplete: AutocompleteProvider;
  private autocompleteWrappers: Parameters<
    ExtensionUIContext["addAutocompleteProvider"]
  >[0][] = [];
  private listeners = new Set<() => void>();
  private inputListeners = new Set<TerminalInputHandler>();
  private queue: PendingDialog[] = [];
  private cancellingDialogs = new WeakSet<PendingDialog>();
  private nextId = 0;
  private disposed = false;
  private footerData: ReadonlyFooterDataProvider;
  constructor(private options: ExtensionUIBridgeOptions = {}) {
    this.currentTheme = options.theme ?? createNativeTheme();
    if (!this.currentTheme) throw new Error("Pi dark theme unavailable");
    this.keybindings = options.keybindings ?? new keys.KeybindingsManager();
    this.native = new NativeComponentHost(() => this.changed());
    this.native.resize(options.columns ?? 80, options.rows ?? 24);
    this.baseAutocomplete = this.autocomplete =
      options.autocompleteProvider ??
      new CombinedAutocompleteProvider([], this.options.cwd ?? process.cwd());
    this.footerData = options.footerData ?? {
      getGitBranch: () => null,
      getExtensionStatuses: () => this.statuses,
      getAvailableProviderCount: () => 0,
      onBranchChange: (callback) => this.onChange(callback),
    };
    this.editorComponent = this.makeEditor();
    const methods = {
      select: true,
      confirm: true,
      input: true,
      notify: true,
      onTerminalInput: true,
      setStatus: true,
      setWorkingMessage: true,
      setWorkingVisible: true,
      setWorkingIndicator: true,
      setHiddenThinkingLabel: true,
      setWidget: true,
      setFooter: true,
      setHeader: true,
      setTitle: true,
      custom: true,
      pasteToEditor: true,
      setEditorText: true,
      getEditorText: true,
      editor: true,
      addAutocompleteProvider: true,
      setEditorComponent: true,
      getEditorComponent: true,
      getAllThemes: true,
      getTheme: true,
      setTheme: true,
      getToolsExpanded: true,
      setToolsExpanded: true,
    } satisfies Record<Exclude<keyof ExtensionUIContext, "theme">, true>;
    for (const name of Object.keys(methods) as (keyof typeof methods)[]) {
      Object.defineProperty(this, name, {
        value: this[name].bind(this),
        enumerable: true,
      });
    }
    Object.defineProperty(this, "theme", {
      get: () => this.themeProxy,
      enumerable: true,
    });
  }
  get theme(): Theme {
    return this.themeProxy;
  }
  get title(): string {
    return this.native.terminal.title;
  }
  get activeDialog(): ExtensionDialog | undefined {
    return this.queue[0]?.view;
  }
  get pendingDialogCount(): number {
    return this.queue.length;
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    if (!this.disposed) for (const listener of this.listeners) listener();
  }
  private assertLive(): void {
    if (this.disposed) throw new Error("Extension UI bridge is disposed");
  }
  private enqueue(
    view: ExtensionDialog,
    fallback: unknown,
    opts?: ExtensionUIDialogOptions,
    activate?: () => void,
  ): Promise<unknown> {
    this.assertLive();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => pending.finish(fallback);
      const settle = (value: unknown, error = false) => {
        const index = this.queue.indexOf(pending);
        if (index < 0) return;
        this.queue.splice(index, 1);
        let failure: unknown;
        try {
          pending.cleanup();
        } catch (cleanupError) {
          failure = cleanupError;
        }
        try {
          if (view.kind === "custom") view.component?.dispose?.();
        } catch (disposeError) {
          failure = disposeError;
        }
        if (failure !== undefined) reject(failure);
        else if (error) reject(value);
        else resolve(value);
        if (view.kind === "custom" && view.options?.blocked)
          this.native.terminal.setProgramStatus({ state: "clear" });
        if (index === 0 && !this.disposed) {
          this.native.setFocus(this.queue.length ? null : this.editorComponent);
          this.queue[0]?.activate?.();
        }
        this.changed();
      };
      const pending: PendingDialog = {
        view,
        finish: (value) => settle(value),
        reject: (error) => settle(error, true),
        cleanup: () => {
          if (timer) clearTimeout(timer);
          opts?.signal?.removeEventListener("abort", abort);
        },
        activate,
      };
      this.queue.push(pending);
      if (opts?.signal?.aborted) {
        pending.finish(fallback);
        return;
      }
      opts?.signal?.addEventListener("abort", abort, { once: true });
      if (opts?.timeout !== undefined) {
        view.deadline = Date.now() + Math.max(0, opts.timeout);
        timer = setTimeout(abort, Math.max(0, opts.timeout));
      }
      if (this.queue[0] === pending) activate?.();
      this.changed();
    });
  }
  select(
    title: string,
    options: string[],
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
    return this.enqueue(
      { id: ++this.nextId, kind: "select", title, options: [...options] },
      undefined,
      opts,
    ) as Promise<string | undefined>;
  }
  confirm(
    title: string,
    message: string,
    opts?: ExtensionUIDialogOptions,
  ): Promise<boolean> {
    return this.enqueue(
      { id: ++this.nextId, kind: "confirm", title, message },
      false,
      opts,
    ) as Promise<boolean>;
  }
  input(
    title: string,
    placeholder?: string,
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
    return this.enqueue(
      { id: ++this.nextId, kind: "input", title, placeholder },
      undefined,
      opts,
    ) as Promise<string | undefined>;
  }
  editor(title: string, prefill?: string): Promise<string | undefined> {
    return this.enqueue(
      { id: ++this.nextId, kind: "editor", title, prefill },
      undefined,
    ) as Promise<string | undefined>;
  }
  resolveDialog(value: unknown): void {
    const dialog = this.activeDialog;
    if (!dialog) return;
    if (
      dialog.kind === "select" &&
      value !== undefined &&
      !dialog.options.includes(value as string)
    )
      throw new Error("Choice is not an offered option");
    if (dialog.kind === "confirm" && typeof value !== "boolean")
      throw new Error("Confirmation requires boolean");
    if (
      (dialog.kind === "input" || dialog.kind === "editor") &&
      value !== undefined &&
      typeof value !== "string"
    )
      throw new Error("Editor/input requires text");
    this.queue[0]!.finish(value);
  }
  cancelDialog(): void {
    const pending = this.queue[0];
    if (!pending) return;
    if (pending.view.kind !== "custom") {
      pending.finish(pending.view.kind === "confirm" ? false : undefined);
      return;
    }
    if (this.cancellingDialogs.has(pending)) return;
    this.cancellingDialogs.add(pending);
    try {
      pending.view.component?.handleInput?.("\x1b");
    } catch (error) {
      pending.reject(error);
      return;
    } finally {
      this.cancellingDialogs.delete(pending);
    }
    if (this.queue.includes(pending))
      pending.reject(new UserCancelledInteractionError());
  }
  custom<T>(
    factory: Parameters<ExtensionUIContext["custom"]>[0],
    options?: Parameters<ExtensionUIContext["custom"]>[1],
  ): Promise<T> {
    const view: ExtensionDialog = {
      id: ++this.nextId,
      kind: "custom",
      title: "",
      hidden: false,
      options,
    };
    let pending: PendingDialog | undefined;
    const promise = this.enqueue(view, undefined, undefined, () => {
      pending = this.queue.find((item) => item.view === view);
      if (options?.blocked)
        this.native.terminal.setProgramStatus({
          state: "blocked",
          ...options.blocked,
        });
      try {
        const result = factory(
          this.native,
          this.theme,
          this.keybindings,
          (value) => pending?.finish(value),
        );
        void Promise.resolve(result)
          .then((component) => {
            if (!this.queue.some((item) => item.view === view)) {
              component.dispose?.();
              return;
            }
            view.component = component;
            if (options?.overlay) {
              const layout =
                typeof options.overlayOptions === "function"
                  ? { ...options.overlayOptions() }
                  : options.overlayOptions;
              if (layout) this.overlayLayouts.set(view, layout);
              const handle = this.native.showOverlay(component, layout);
              view.overlayHandle = handle;
              const originalHidden = handle.setHidden.bind(handle);
              handle.setHidden = (hidden) => {
                view.hidden = hidden;
                originalHidden(hidden);
                this.changed();
              };
              const previousCleanup = pending!.cleanup;
              pending!.cleanup = () => {
                handle.hide();
                previousCleanup();
              };
              options.onHandle?.(handle);
            } else if (this.activeDialog === view)
              this.native.setFocus(component);
            this.changed();
          })
          .catch((error) => pending?.reject(error));
      } catch (error) {
        pending?.reject(error);
      }
    });
    return promise as Promise<T>;
  }
  renderCustom(width: number): string[] {
    const dialog = this.activeDialog;
    if (
      dialog?.kind === "custom" &&
      typeof dialog.options?.overlayOptions === "function"
    ) {
      const layout = this.overlayLayouts.get(dialog);
      if (layout) {
        for (const key of Object.keys(layout))
          delete (layout as Record<string, unknown>)[key];
        Object.assign(layout, dialog.options.overlayOptions());
      }
    }
    return dialog?.kind === "custom" && dialog.component && !dialog.hidden
      ? this.native.renderComponent(
          dialog.options?.overlay
            ? { render: () => [], invalidate() {} }
            : dialog.component,
          width,
        )
      : [];
  }
  get dialogCapturesInput(): boolean {
    const dialog = this.activeDialog;
    if (!dialog) return false;
    if (dialog.kind !== "custom" || !dialog.options?.overlay) return true;
    return (
      !dialog.hidden &&
      !!dialog.overlayHandle?.isFocused() &&
      !!dialog.overlayHandle.getBounds()
    );
  }
  renderCustomOverlay():
    | { bounds: OverlayBounds; lines: string[]; focused: boolean }
    | undefined {
    const dialog = this.activeDialog;
    if (dialog?.kind !== "custom" || !dialog.options?.overlay) return;
    const lines = this.renderCustom(this.native.terminal.columns);
    const bounds = dialog.overlayHandle?.getBounds();
    if (!bounds) {
      if (dialog.overlayHandle?.isFocused())
        dialog.overlayHandle.unfocus({ target: this.editorComponent });
      return;
    }
    const start =
      Math.max(0, lines.length - this.native.terminal.rows) + bounds.row;
    return {
      bounds,
      lines: lines
        .slice(start, start + bounds.height)
        .map((line) => sliceByColumn(line, bounds.col, bounds.width)),
      focused: dialog.overlayHandle!.isFocused(),
    };
  }
  handleCustomInput(raw: string): void {
    const dialog = this.activeDialog;
    if (dialog?.kind === "custom" && !dialog.hidden)
      this.native.input(raw, dialog.component);
  }
  notify(message: string, type: "info" | "warning" | "error" = "info"): void {
    this.notifications.push({ message, type });
    this.changed();
  }
  onTerminalInput(handler: TerminalInputHandler): () => void {
    this.inputListeners.add(handler);
    return () => this.inputListeners.delete(handler);
  }
  processTerminalInput(data: string): string | undefined {
    for (const handler of this.inputListeners) {
      const result = handler(data);
      if (result?.consume) return undefined;
      if (result?.data !== undefined) data = result.data;
    }
    return data;
  }
  setStatus(key: string, text: string | undefined): void {
    if (text === undefined) this.statuses.delete(key);
    else this.statuses.set(key, text);
    this.changed();
  }
  setWorkingMessage(message?: string): void {
    this.workingMessage = message;
    this.changed();
  }
  setWorkingVisible(visible: boolean): void {
    this.workingVisible = visible;
    this.changed();
  }
  setWorkingIndicator(options?: WorkingIndicatorOptions): void {
    this.workingIndicator = options;
    this.changed();
  }
  setHiddenThinkingLabel(label?: string): void {
    this.hiddenThinkingLabel = label;
    this.changed();
  }
  setWidget(
    key: string,
    content: string[] | WidgetFactory | undefined,
    options?: ExtensionWidgetOptions,
  ): void {
    const replacement =
      typeof content === "function"
        ? content(this.native, this.theme)
        : content;
    const old = this.widgets.get(key)?.content;
    if (old && !Array.isArray(old)) old.dispose?.();
    if (replacement)
      this.widgets.set(key, {
        content: replacement,
        placement: options?.placement ?? "aboveEditor",
      });
    else this.widgets.delete(key);
    this.changed();
  }
  setHeader(factory: Parameters<ExtensionUIContext["setHeader"]>[0]): void {
    const next = factory?.(this.native, this.theme);
    this.header?.dispose?.();
    this.header = next;
    this.changed();
  }
  setFooter(factory: Parameters<ExtensionUIContext["setFooter"]>[0]): void {
    const next = factory?.(this.native, this.theme, this.footerData);
    this.footer?.dispose?.();
    this.footer = next;
    this.changed();
  }
  renderWidgets(
    width: number,
    placement: "aboveEditor" | "belowEditor" = "aboveEditor",
  ): string[] {
    return [...this.widgets.values()]
      .filter((widget) => widget.placement === placement)
      .flatMap((widget) =>
        Array.isArray(widget.content)
          ? widget.content
          : widget.content.render(Math.max(1, width)),
      );
  }
  renderHeader(width: number): string[] {
    return this.header?.render(Math.max(1, width)) ?? [];
  }
  renderFooter(width: number): string[] {
    return this.footer?.render(Math.max(1, width)) ?? [];
  }
  setTitle(title: string): void {
    this.native.terminal.setTitle(title);
  }
  private editorTheme(): EditorTheme {
    return {
      borderColor: (text) => this.theme.fg("border", text),
      selectList: {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
    };
  }
  private makeEditor(): EditorComponent {
    const editor =
      this.editorFactory?.(this.native, this.editorTheme(), this.keybindings) ??
      new CustomEditor(this.native, this.editorTheme(), this.keybindings);
    editor.onSubmit = (text) => this.options.onSubmit?.(text);
    editor.onChange = () => this.changed();
    editor.setAutocompleteProvider?.(this.autocomplete);
    this.native.setFocus(editor);
    return editor;
  }
  pasteToEditor(text: string): void {
    this.editorComponent.handleInput(`\x1b[200~${text}\x1b[201~`);
    this.changed();
  }
  setEditorText(text: string): void {
    this.editorComponent.setText(text);
    this.changed();
  }
  getEditorText(): string {
    return (
      this.editorComponent.getExpandedText?.() ?? this.editorComponent.getText()
    );
  }
  handleEditorInput(raw: string): void {
    this.native.input(raw, this.editorComponent);
  }
  renderEditor(width: number): string[] {
    return this.editorComponent.render(Math.max(1, width));
  }
  setBaseAutocompleteProvider(base: AutocompleteProvider): void {
    if (!this.editorComponent.setAutocompleteProvider)
      throw new Error("Current custom editor does not support autocomplete");
    let provider = base;
    const triggers = [...(base.triggerCharacters ?? [])];
    for (const factory of this.autocompleteWrappers) {
      provider = factory(provider);
      triggers.push(...(provider.triggerCharacters ?? []));
    }
    if (triggers.length) provider.triggerCharacters = [...new Set(triggers)];
    this.editorComponent.setAutocompleteProvider(provider);
    this.baseAutocomplete = base;
    this.autocomplete = provider;
    this.changed();
  }
  addAutocompleteProvider(
    factory: Parameters<ExtensionUIContext["addAutocompleteProvider"]>[0],
  ): void {
    if (!this.editorComponent.setAutocompleteProvider)
      throw new Error("Current custom editor does not support autocomplete");
    const provider = factory(this.autocomplete);
    const triggers = [
      ...(this.autocomplete.triggerCharacters ?? []),
      ...(provider.triggerCharacters ?? []),
    ];
    if (triggers.length) provider.triggerCharacters = [...new Set(triggers)];
    this.editorComponent.setAutocompleteProvider(provider);
    this.autocompleteWrappers.push(factory);
    this.autocomplete = provider;
    this.changed();
  }
  setEditorComponent(factory: EditorFactory | undefined): void {
    const text = this.getEditorText();
    const previousFactory = this.editorFactory;
    this.editorFactory = factory;
    let next: EditorComponent;
    try {
      next = this.makeEditor();
      next.setText(text);
    } catch (error) {
      this.editorFactory = previousFactory;
      throw error;
    }
    const old = this.editorComponent as EditorComponent & { dispose?(): void };
    this.editorComponent = next;
    old.dispose?.();
    this.changed();
  }
  getEditorComponent(): EditorFactory | undefined {
    return this.editorFactory;
  }
  getAllThemes(): { name: string; path: string | undefined }[] {
    return [
      { name: "opencode", path: undefined },
      ...themes.getAvailableThemesWithPaths(),
    ];
  }
  getTheme(name: string): Theme | undefined {
    return name === "opencode"
      ? createNativeTheme()
      : themes.getThemeByName(name);
  }
  setTheme(theme: string | Theme): { success: boolean; error?: string } {
    try {
      const next =
        typeof theme === "string"
          ? this.getTheme(theme)
          : theme === this.themeProxy
            ? this.currentTheme
            : theme;
      if (!next) return { success: false, error: `Theme not found: ${theme}` };
      this.currentTheme = next;
      this.editorComponent.borderColor = (text) =>
        this.theme.fg("border", text);
      for (const component of [
        this.editorComponent,
        this.header,
        this.footer,
        ...[...this.widgets.values()].map((widget) =>
          Array.isArray(widget.content) ? undefined : widget.content,
        ),
        this.activeDialog?.kind === "custom"
          ? this.activeDialog.component
          : undefined,
      ])
        component?.invalidate();
      this.changed();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }
  getToolsExpanded(): boolean {
    return this.toolsExpanded;
  }
  setToolsExpanded(expanded: boolean): void {
    this.toolsExpanded = expanded;
    this.changed();
  }
  resize(columns: number, rows: number): void {
    this.native.resize(columns, rows);
  }
  resetSessionUI(): void {
    this.assertLive();
    const text = this.getEditorText();
    const errors: unknown[] = [];
    this.disposed = true;
    try {
      for (const pending of [...this.queue]) {
        try {
          pending.finish(pending.view.kind === "confirm" ? false : undefined);
        } catch (error) {
          errors.push(error);
        }
      }
      for (const component of [
        this.header,
        this.footer,
        this.editorComponent as OwnedComponent,
        ...[...this.widgets.values()].map((widget) =>
          Array.isArray(widget.content) ? undefined : widget.content,
        ),
      ]) {
        try {
          component?.dispose?.();
        } catch (error) {
          errors.push(error);
        }
      }
      this.header = undefined;
      this.footer = undefined;
      this.widgets.clear();
      this.statuses.clear();
      this.notifications.length = 0;
      this.inputListeners.clear();
      this.editorFactory = undefined;
      this.autocompleteWrappers = [];
      this.autocomplete = this.baseAutocomplete;
      this.workingMessage = undefined;
      this.workingVisible = true;
      this.workingIndicator = undefined;
      this.hiddenThinkingLabel = undefined;
      this.toolsExpanded = false;
      this.overlayLayouts = new WeakMap();
      try {
        this.native.resetSessionUI();
      } catch (error) {
        errors.push(error);
      }
      try {
        this.editorComponent = this.makeEditor();
        this.editorComponent.setText(text);
      } catch (error) {
        errors.push(error);
      }
    } finally {
      this.disposed = false;
      this.changed();
    }
    if (errors.length)
      throw new AggregateError(errors, "Extension session UI reset failed");
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    for (const pending of [...this.queue]) {
      try {
        pending.finish(pending.view.kind === "confirm" ? false : undefined);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const component of [
      this.header,
      this.footer,
      this.editorComponent as OwnedComponent,
      ...[...this.widgets.values()].map((widget) =>
        Array.isArray(widget.content) ? undefined : widget.content,
      ),
    ]) {
      try {
        component?.dispose?.();
      } catch (error) {
        errors.push(error);
      }
    }
    this.widgets.clear();
    this.listeners.clear();
    this.inputListeners.clear();
    this.native.stop();
    if (errors.length)
      throw new AggregateError(errors, "Extension UI disposal failed");
  }
}
