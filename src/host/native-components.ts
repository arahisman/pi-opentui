import {
  type Component,
  type Terminal,
  type ProgramStatus,
  type TuiInputListener,
} from "@earendil-works/pi-tui";
const {
  TuiBase,
}: typeof import("../../node_modules/@earendil-works/pi-tui/dist/tui.js") =
  await import(
    new URL("./tui.js", import.meta.resolve("@earendil-works/pi-tui")).href
  );

export class HeadlessTerminal implements Terminal {
  columns = 80;
  rows = 24;
  readonly kittyProtocolActive = false;
  title = "";
  progress = false;
  programStatus?: ProgramStatus;
  constructor(private changed: () => void) {}
  start(): void {
    throw new Error(
      "OpenTUI owns terminal input; a Pi terminal cannot be started",
    );
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    throw new Error(
      `Native component attempted a direct terminal write (${data.length} bytes)`,
    );
  }
  moveBy(): void {
    throw new Error(
      "Native components cannot move the OpenTUI terminal cursor",
    );
  }
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {
    this.changed();
  }
  clearFromCursor(): void {
    this.changed();
  }
  clearScreen(): void {
    this.changed();
  }
  setTitle(title: string): void {
    this.title = title;
    this.changed();
  }
  setProgress(active: boolean): void {
    this.progress = active;
    this.changed();
  }
  setProgramStatus(status: ProgramStatus): void {
    this.programStatus = status;
    this.changed();
  }
}

export class NativeComponentHost extends TuiBase {
  readonly mode = "fullscreen" as const;
  declare terminal: HeadlessTerminal;
  constructor(private changed: () => void) {
    super(new HeadlessTerminal(changed));
  }
  protected doRender(): void {
    this.changed();
  }
  override requestRender(): void {
    this.changed();
  }
  override renderNow(): void {
    this.changed();
  }
  private nativeInputListeners = new Set<TuiInputListener>();
  override addInputListener(listener: TuiInputListener): () => void {
    this.nativeInputListeners.add(listener);
    return () => this.nativeInputListeners.delete(listener);
  }
  override removeInputListener(listener: TuiInputListener): void {
    this.nativeInputListeners.delete(listener);
  }
  override setTerminalColorSchemeNotifications(): void {}
  override start(): void {
    throw new Error("OpenTUI owns the terminal lifecycle");
  }
  override async queryTerminalColors(): Promise<{}> {
    return {};
  }
  resetSessionUI(): void {
    while (this.hasOverlayEntries) this.hideOverlay();
    this.setFocus(null);
    this.clear();
    this.nativeInputListeners.clear();
    this.setShowHardwareCursor(false);
    this.setClearOnShrink(false);
    this.terminal.setProgress(false);
    this.terminal.setProgramStatus({ state: "clear" });
    this.terminal.setTitle("");
  }
  resize(columns: number, rows: number): void {
    this.terminal.columns = Math.max(1, columns);
    this.terminal.rows = Math.max(1, rows);
    this.invalidate();
    this.changed();
  }
  renderComponent(component: Component, width: number): string[] {
    return this.compositeOverlays(
      component.render(Math.max(1, width)),
      Math.max(1, width),
      this.terminal.rows,
    );
  }
  input(data: string, fallback?: Component): void {
    for (const listener of this.nativeInputListeners) {
      const result = listener(data);
      if (result?.consume) return;
      if (result?.data !== undefined) data = result.data;
    }
    (this.getFocusedComponent() ?? fallback)?.handleInput?.(data);
    this.changed();
  }
}
