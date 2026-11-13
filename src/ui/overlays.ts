import {
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
  type StyledText,
} from "@opentui/core";
import { palette as p } from "../theme.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
export interface MenuItem {
  id: string;
  label: string;
  description?: string;
}
export interface MenuOptions {
  title: string;
  items: MenuItem[];
  onSelect: (id: string) => void | Promise<void>;
  onCancel?: () => void;
  query?: string;
  tabs?: string[];
  tabIndex?: number;
  onTab?: (index: number) => void;
}
export interface TextOptions {
  title: string;
  keepOpenOnAction?: boolean;
  onCancel?: () => void;
  body: string | StyledText;
  actions?: { id: string; label: string }[];
  onAction?: (id: string) => void | Promise<void>;
}
export interface InputOptions {
  title: string;
  value?: string;
  multiline?: boolean;
  secret?: boolean;
  onSubmit: (value: string) => void | Promise<void>;
  onCancel?: () => void;
}
export interface NativeOptions {
  title: string;
  render: (width: number) => StyledText | string;
  onInput: (raw: string) => void;
  onCancel?: () => void;
}
export interface NativeSurfaceOptions {
  row: number;
  col: number;
  width: number;
  height: number;
  content: StyledText;
  focused: boolean;
  onInput: (raw: string) => void;
  onCancel: () => void;
  onFocus: () => void;
}
type State =
  | {
      kind: "menu";
      options: MenuOptions;
      query: string;
      selected: number;
      tab: number;
    }
  | { kind: "text"; options: TextOptions; action: number }
  | { kind: "input"; options: InputOptions; value: string; cursor: number }
  | { kind: "native"; options: NativeOptions };
export class OverlayManager {
  private state?: State;
  private surface?: BoxRenderable;
  private surfaceText?: TextRenderable;
  private surfaceOptions?: NativeSurfaceOptions;
  private surfacePreviousFocus: Renderable | null = null;
  private layer?: BoxRenderable;
  private panel?: BoxRenderable;
  private heading?: TextRenderable;
  private query?: TextRenderable;
  private list?: ScrollBoxRenderable;
  private footer?: BoxRenderable;
  private previousFocus: Renderable | null = null;
  private disposed = false;
  private readonly resizeHandler = () => this.resize();
  constructor(
    readonly renderer: CliRenderer,
    private readonly onClose?: () => void,
  ) {
    renderer.on("resize", this.resizeHandler);
  }
  get isOpen(): boolean {
    return this.state !== undefined || !!this.surfaceOptions?.focused;
  }
  setNativeSurface(options: NativeSurfaceOptions | undefined): void {
    const wasFocused = !!this.surfaceOptions?.focused;
    this.surfaceOptions = options;
    if (!options) {
      const previous = this.surfacePreviousFocus;
      if (this.previousFocus === this.surface) this.previousFocus = previous;
      const ownsFocus = this.renderer.currentFocusedRenderable === this.surface;
      this.surface?.destroyRecursively();
      this.surface = undefined;
      this.surfaceText = undefined;
      this.surfacePreviousFocus = null;
      if (ownsFocus && previous && !previous.isDestroyed) previous.focus();
      this.renderer.requestRender();
      return;
    }
    if (!this.surface) {
      this.surface = new BoxRenderable(this.renderer, {
        id: "native-overlay-surface",
        position: "absolute",
        zIndex: 900,
        focusable: true,
        overflow: "hidden",
        backgroundColor: p.background,
        onMouseDown: () => this.surfaceOptions?.onFocus(),
      });
      this.surfaceText = new TextRenderable(this.renderer, {
        id: "native-overlay-surface-text",
        content: options.content,
        width: "100%",
        height: "100%",
        wrapMode: "none",
      });
      this.surface.add(this.surfaceText);
      this.renderer.root.add(this.surface);
    }
    this.surface.left = options.col;
    this.surface.top = options.row;
    this.surface.width = options.width;
    this.surface.height = options.height;
    this.surfaceText!.content = options.content;
    if (!this.state && options.focused && !wasFocused) {
      this.surfacePreviousFocus = this.renderer.currentFocusedRenderable;
      this.surface.focus();
    } else if (!options.focused && wasFocused) {
      if (this.previousFocus === this.surface)
        this.previousFocus = this.surfacePreviousFocus;
      if (
        this.renderer.currentFocusedRenderable === this.surface &&
        this.surfacePreviousFocus &&
        !this.surfacePreviousFocus.isDestroyed
      )
        this.surfacePreviousFocus.focus();
    }
    this.renderer.requestRender();
  }
  openMenu(options: MenuOptions): void {
    this.open({
      kind: "menu",
      options,
      query: options.query ?? "",
      selected: 0,
      tab: options.tabIndex ?? 0,
    });
  }
  openText(options: TextOptions): void {
    this.open({ kind: "text", options, action: 0 });
  }
  openInput(options: InputOptions): void {
    const value = options.value ?? "";
    this.open({
      kind: "input",
      options,
      value,
      cursor: Array.from(value).length,
    });
  }
  openNative(options: NativeOptions): void {
    this.open({ kind: "native", options });
  }
  private open(state: State): void {
    if (this.disposed) throw new Error("Overlay manager is disposed");
    if (this.state) this.teardown(false, true);
    this.previousFocus = this.renderer.currentFocusedRenderable;
    this.state = state;
    this.layer = new BoxRenderable(this.renderer, {
      id: "overlay-layer",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 1000,
      backgroundColor: "#00000099",
    });
    this.panel = new BoxRenderable(this.renderer, {
      id: "overlay-panel",
      position: "absolute",
      border: true,
      borderColor: p.borderActive,
      focusedBorderColor: p.borderActive,
      backgroundColor: p.backgroundPanel,
      paddingX: 1,
      flexDirection: "column",
      focusable: true,
      overflow: "hidden",
    });
    this.layer.add(this.panel);
    this.heading = new TextRenderable(this.renderer, {
      id: "overlay-title",
      content: state.options.title,
      fg: p.primary,
      height: 1,
      truncate: true,
    });
    this.panel.add(this.heading);
    this.query = new TextRenderable(this.renderer, {
      id: "overlay-query",
      content: "",
      fg: p.textMuted,
      height: 1,
      truncate: true,
    });
    this.panel.add(this.query);
    this.list = new ScrollBoxRenderable(this.renderer, {
      id: "overlay-content",
      flexGrow: 1,
      minHeight: 0,
      scrollY: true,
      scrollX: false,
      contentOptions: { flexDirection: "column" },
    });
    this.panel.add(this.list);
    this.footer = new BoxRenderable(this.renderer, {
      id: "overlay-footer",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      overflow: "hidden",
    });
    this.panel.add(this.footer);
    this.renderer.root.add(this.layer);
    this.panel.focus();
    this.resize();
  }
  captureDismissal(): () => void {
    const state = this.state;
    return () => {
      if (this.state === state) this.dismiss();
    };
  }
  dismiss(): void {
    this.teardown(false, false);
  }
  close(): void {
    this.teardown(true, true);
  }
  private teardown(notify: boolean, cancel: boolean): void {
    const old = this.state;
    if (!old) return;
    this.state = undefined;
    this.layer?.destroyRecursively();
    this.layer = undefined;
    this.panel = undefined;
    this.list = undefined;
    this.query = undefined;
    this.heading = undefined;
    this.footer = undefined;
    const focus = this.previousFocus;
    this.previousFocus = null;
    if (this.surfaceOptions?.focused) this.surface?.focus();
    else if (focus && !focus.isDestroyed) focus.focus();
    if (cancel) old.options.onCancel?.();
    if (notify) this.onClose?.();
    this.renderer.requestRender();
  }
  private layoutPanel(): void {
    if (!this.panel || !this.state) return;
    const state = this.state;
    const width = Math.max(1, Math.min(88, this.renderer.width));
    let desired = 26;
    if (state.kind === "menu")
      desired = Math.max(1, this.matching(state).length) + 5;
    else if (state.kind === "input")
      desired =
        (state.options.multiline
          ? Math.min(8, state.value.split("\n").length + 1)
          : 1) + 5;
    else if (state.kind === "text") {
      const body =
        typeof state.options.body === "string"
          ? state.options.body
          : state.options.body.chunks.map((chunk) => chunk.text).join("");
      desired =
        body
          .split("\n")
          .reduce(
            (height, line) =>
              height +
              Math.max(
                1,
                Math.ceil(visibleWidth(line) / Math.max(1, width - 4)),
              ),
            0,
          ) + 5;
    }
    const height = Math.max(1, Math.min(26, this.renderer.height, desired));
    this.panel.width = width;
    this.panel.height = height;
    this.panel.left = Math.max(
      0,
      Math.floor((this.renderer.width - width) / 2),
    );
    this.panel.top = Math.max(
      0,
      Math.floor((this.renderer.height - height) / 2),
    );
  }
  resize(): void {
    this.layoutPanel();
    this.refresh();
  }
  private matching(state: Extract<State, { kind: "menu" }>): MenuItem[] {
    const query = state.query.toLocaleLowerCase();
    return state.options.items.filter((item) =>
      `${item.label} ${item.description ?? ""}`
        .toLocaleLowerCase()
        .includes(query),
    );
  }
  private get pageSize(): number {
    return Math.max(
      1,
      (this.panel?.height ?? Math.min(26, this.renderer.height)) - 5,
    );
  }
  refresh(): void {
    const state = this.state;
    if (!state || !this.list || !this.query || !this.footer) return;
    this.layoutPanel();
    const oldScroll = this.list.scrollTop;
    for (const child of this.list.getChildren()) child.destroyRecursively();
    for (const child of this.footer.getChildren()) child.destroyRecursively();
    const add = (
      content: string | StyledText,
      id: string,
      selected = false,
      onClick?: () => void,
    ) => {
      const node = new TextRenderable(this.renderer, {
        id,
        content,
        fg: selected ? p.background : p.text,
        bg: selected ? p.primary : undefined,
        wrapMode: "word",
        ...(state.kind === "menu"
          ? { height: 1, width: "100%", truncate: true }
          : {}),
        onMouseDown: state.kind === "menu" ? undefined : onClick,
      });
      if (state.kind === "menu") {
        const row = new BoxRenderable(this.renderer, {
          id: `${id}-row`,
          width: "100%",
          height: 1,
          flexShrink: 0,
          backgroundColor: selected ? p.primary : p.backgroundPanel,
          onMouseDown: onClick,
        });
        row.add(node);
        this.list!.add(row);
      } else this.list!.add(node);
      return node;
    };
    const foot = (content: string, id: string, onClick?: () => void) =>
      this.footer!.add(
        new TextRenderable(this.renderer, {
          id,
          content,
          fg: p.textMuted,
          height: 1,
          truncate: true,
          onMouseDown: onClick,
        }),
      );
    if (state.kind === "menu") {
      const matches = this.matching(state);
      state.selected = Math.max(
        0,
        Math.min(state.selected, matches.length - 1),
      );
      this.query.content = `Search: ${state.query}${state.options.tabs?.length ? `  ${state.options.tabs.map((tab, index) => (index === state.tab ? `[${tab}]` : tab)).join("  ")}` : ""}`;
      const start = Math.floor(state.selected / this.pageSize) * this.pageSize;
      if (!matches.length)
        add(
          state.options.items.length ? "No results" : "No items",
          "overlay-empty",
        );
      matches.slice(start, start + this.pageSize).forEach((item, index) => {
        const selected = start + index === state.selected;
        add(
          `${selected ? "›" : " "} ${item.label}${item.description ? `  ${item.description}` : ""}`,
          `overlay-item-${start + index}`,
          selected,
          () => this.select(item.id),
        );
      });
      foot(
        this.renderer.width < 40
          ? "↑↓ enter · esc"
          : `↑↓ choose · enter · esc${state.options.tabs?.length ? " · tab" : ""}`,
        "overlay-hints",
      );
    } else if (state.kind === "input") {
      const characters = Array.from(state.value),
        masked = state.options.secret
          ? characters.map((char) => (char === "\n" ? "\n" : "•"))
          : characters;
      masked.splice(state.cursor, 0, "▏");
      this.query.content = state.options.secret ? "Secret input" : "Input";
      add(masked.join(""), "overlay-input");
      foot(
        `enter submit · esc${state.options.multiline ? " · shift+enter newline" : ""}`,
        "overlay-hints",
      );
    } else if (state.kind === "text") {
      this.query.content = "";
      add(state.options.body, "overlay-text");
      if (state.options.actions?.length)
        state.options.actions.forEach((action, index) =>
          foot(
            `${index === state.action ? "›" : " "}${action.label}  `,
            `overlay-action-${index}`,
            () => this.action(action.id),
          ),
        );
      else foot("↑↓ scroll · esc close", "overlay-hints");
      this.list.scrollTo(oldScroll);
    } else {
      this.query.content = "";
      add(
        state.options.render(
          Math.max(1, Math.min(88, this.renderer.width) - 4),
        ),
        "overlay-native",
      );
      foot("ctrl+c close", "overlay-hints");
      this.list.scrollTo(oldScroll);
    }
    this.renderer.requestRender();
  }
  private invoke(callback: () => void | Promise<void>): void {
    try {
      const result = callback();
      if (result) void result.catch((error) => this.showError(error));
    } catch (error) {
      this.showError(error);
    }
  }
  private showError(error: unknown): void {
    if (!this.disposed)
      this.openText({
        title: "Action failed",
        body: error instanceof Error ? error.message : String(error),
      });
  }
  private select(id: string): void {
    const state = this.state;
    if (state?.kind !== "menu") return;
    this.teardown(true, false);
    this.invoke(() => state.options.onSelect(id));
  }
  private action(id: string): void {
    const state = this.state;
    if (state?.kind !== "text") return;
    if (!state.options.keepOpenOnAction) this.teardown(true, false);
    this.invoke(() => state.options.onAction?.(id));
  }
  handlePaste(value: string): void {
    const state = this.state;
    if (!state) {
      if (this.surfaceOptions?.focused)
        this.surfaceOptions.onInput(`\x1b[200~${value}\x1b[201~`);
      return;
    }
    if (state.kind === "native") {
      state.options.onInput(`\x1b[200~${value}\x1b[201~`);
      this.refresh();
      return;
    }
    if (state.kind === "menu") {
      state.query += value.replace(/[\r\n]/g, " ");
      state.selected = 0;
      this.refresh();
    }
    if (state.kind === "input") {
      const characters = Array.from(state.value),
        insert = Array.from(
          state.options.multiline
            ? value.replace(/\r\n?/g, "\n")
            : value.replace(/[\r\n]/g, " "),
        );
      characters.splice(state.cursor, 0, ...insert);
      state.value = characters.join("");
      state.cursor += insert.length;
      this.refresh();
    }
  }
  handleKey(key: KeyEvent): boolean {
    const state = this.state;
    if (!state) {
      const surface = this.surfaceOptions;
      if (!surface?.focused) return false;
      key.preventDefault();
      key.stopPropagation();
      if (key.eventType !== "release") {
        if (key.ctrl && key.name === "c") surface.onCancel();
        else surface.onInput(key.raw || key.sequence);
      }
      return true;
    }
    key.preventDefault();
    key.stopPropagation();
    if (key.eventType === "release") return true;
    if (state.kind === "native") {
      if (key.ctrl && key.name === "c") {
        this.close();
        return true;
      }
      state.options.onInput(key.raw || key.sequence);
      if (this.state === state) this.refresh();
      return true;
    }
    if (key.name === "escape") {
      this.close();
      return true;
    }
    const enter = key.name === "return" || key.name === "enter";
    if (state.kind === "menu") {
      const matches = this.matching(state);
      if (key.name === "up") state.selected = Math.max(0, state.selected - 1);
      else if (key.name === "down")
        state.selected = Math.min(matches.length - 1, state.selected + 1);
      else if (key.name === "pageup")
        state.selected = Math.max(0, state.selected - this.pageSize);
      else if (key.name === "pagedown")
        state.selected = Math.min(
          matches.length - 1,
          state.selected + this.pageSize,
        );
      else if (key.name === "tab" && state.options.tabs?.length) {
        state.tab =
          (state.tab + (key.shift ? -1 : 1) + state.options.tabs.length) %
          state.options.tabs.length;
        state.options.onTab?.(state.tab);
      } else if (enter) {
        const item = matches[state.selected];
        if (item) this.select(item.id);
        return true;
      } else if (key.name === "backspace") {
        state.query = Array.from(state.query).slice(0, -1).join("");
        state.selected = 0;
      } else if (
        !key.ctrl &&
        !key.meta &&
        key.sequence &&
        !/[\x00-\x1f\x7f]/.test(key.sequence)
      ) {
        state.query += key.sequence;
        state.selected = 0;
      }
    } else if (state.kind === "input") {
      const characters = Array.from(state.value);
      if (enter) {
        if (key.shift && state.options.multiline) {
          this.handlePaste("\n");
          return true;
        }
        const value = state.value;
        this.teardown(true, false);
        this.invoke(() => state.options.onSubmit(value));
        return true;
      }
      if (key.name === "left") state.cursor = Math.max(0, state.cursor - 1);
      else if (key.name === "right")
        state.cursor = Math.min(characters.length, state.cursor + 1);
      else if (key.name === "home") state.cursor = 0;
      else if (key.name === "end") state.cursor = characters.length;
      else if (key.name === "backspace" && state.cursor > 0) {
        characters.splice(--state.cursor, 1);
        state.value = characters.join("");
      } else if (key.name === "delete") {
        characters.splice(state.cursor, 1);
        state.value = characters.join("");
      } else if (key.ctrl && key.name === "u") {
        state.value = "";
        state.cursor = 0;
      } else if (
        !key.ctrl &&
        !key.meta &&
        key.sequence &&
        !/[\x00-\x1f\x7f]/.test(key.sequence)
      ) {
        this.handlePaste(key.sequence);
        return true;
      }
    } else {
      if (key.name === "up") this.list?.scrollBy(-1);
      else if (key.name === "down") this.list?.scrollBy(1);
      else if (key.name === "pageup") this.list?.scrollBy(-this.pageSize);
      else if (key.name === "pagedown") this.list?.scrollBy(this.pageSize);
      else if (
        (key.name === "tab" || key.name === "right" || key.name === "left") &&
        state.options.actions?.length
      )
        state.action =
          (state.action +
            (key.shift || key.name === "left" ? -1 : 1) +
            state.options.actions.length) %
          state.options.actions.length;
      else if (enter) {
        const action = state.options.actions?.[state.action];
        if (action) this.action(action.id);
        else this.close();
        return true;
      }
    }
    if (this.state === state) this.refresh();
    return true;
  }
  dispose(): void {
    this.teardown(false, true);
    const cancel = this.surfaceOptions?.onCancel;
    this.setNativeSurface(undefined);
    cancel?.();
    this.renderer.off("resize", this.resizeHandler);
    this.disposed = true;
  }
}
