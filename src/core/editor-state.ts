import {
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  renderFakeCursor,
  visibleWidth,
  type Keybinding,
} from "@earendil-works/pi-tui";

interface CursorEditor {
  getText(): string;
  getExpandedText(): string;
  getCursor(): { line: number; col: number };
}
function cursorEditor(editor: unknown): editor is CursorEditor {
  if (!editor || typeof editor !== "object") return false;
  const candidate = editor as Partial<CursorEditor>;
  return (
    typeof candidate.getText === "function" &&
    typeof candidate.getExpandedText === "function" &&
    typeof candidate.getCursor === "function"
  );
}
export function captureCursorOffset(editor: unknown): number | undefined {
  if (!cursorEditor(editor)) return undefined;
  const text = editor.getText();
  if (typeof text !== "string" || editor.getExpandedText() !== text)
    return undefined;
  const cursor = editor.getCursor();
  const lines = text.split("\n");
  if (
    !cursor ||
    !Number.isInteger(cursor.line) ||
    !Number.isInteger(cursor.col) ||
    cursor.line < 0 ||
    cursor.line >= lines.length ||
    cursor.col < 0 ||
    cursor.col > lines[cursor.line]!.length
  )
    return undefined;
  let offset = cursor.col;
  for (let line = 0; line < cursor.line; line++)
    offset += lines[line]!.length + 1;
  return offset;
}
function navigationKey(
  action: Keybinding,
  candidates: string[],
): string | undefined {
  const bindings = getKeybindings();
  const actions = Object.keys(bindings.getResolvedBindings()) as Keybinding[];
  return candidates.find(
    (key) =>
      bindings.matches(key, action) &&
      actions.every(
        (other) => other === action || !bindings.matches(key, other),
      ),
  );
}
export function restoreCursorOffset(editor: unknown, offset: number): boolean {
  if (!(editor instanceof Editor) || captureCursorOffset(editor) === undefined)
    return false;
  const text = editor.getText();
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length)
    return false;
  if (captureCursorOffset(editor) === offset) return true;
  const lines = text.split("\n");
  let targetLine = 0;
  let targetCol = offset;
  while (targetCol > lines[targetLine]!.length) {
    targetCol -= lines[targetLine]!.length + 1;
    targetLine++;
  }
  const line = lines[targetLine]!;
  let boundaryValid = targetCol === line.length;
  if (!boundaryValid) {
    for (const segment of new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    }).segment(line)) {
      if (segment.index > targetCol) break;
      if (segment.index === targetCol) {
        boundaryValid = true;
        break;
      }
    }
  }
  if (!boundaryValid) return false;
  const initial = editor.getCursor();
  const backwards = initial.line > targetLine;
  const boundary = navigationKey(
    backwards ? "tui.editor.cursorLineStart" : "tui.editor.cursorLineEnd",
    backwards ? ["\x1b[H", "\x01"] : ["\x1b[F", "\x05"],
  );
  const crossLine = navigationKey(
    backwards ? "tui.editor.cursorLeft" : "tui.editor.cursorRight",
    backwards ? ["\x1b[D", "\x02"] : ["\x1b[C", "\x06"],
  );
  if (initial.line !== targetLine && (!boundary || !crossLine)) return false;
  const padding = Editor.prototype.getPaddingX.call(editor);
  const width =
    lines.reduce(
      (maximum, value) => Math.max(maximum, visibleWidth(value)),
      1,
    ) +
    padding * 2 +
    1;
  Editor.prototype.render.call(editor, width);
  while (editor.getCursor().line !== targetLine) {
    const previous = editor.getCursor().line;
    Editor.prototype.handleInput.call(editor, boundary!);
    Editor.prototype.handleInput.call(editor, crossLine!);
    if (
      editor.getText() !== text ||
      editor.getCursor().line !== previous + (backwards ? -1 : 1)
    )
      return false;
  }
  const rendered = Editor.prototype.render.call(editor, width);
  const fakeStart = renderFakeCursor("\0").split("\0", 1)[0]!;
  const row = rendered.findIndex(
    (value) => value.includes(CURSOR_MARKER) || value.includes(fakeStart),
  );
  if (row < 0) return false;
  const x = padding + visibleWidth(line.slice(0, targetCol));
  Editor.prototype.handleMouse.call(editor, {
    type: "click",
    button: "left",
    x,
    y: row,
    screenX: x,
    screenY: row,
    width,
    height: rendered.length,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount: 1,
  });
  return editor.getText() === text && captureCursorOffset(editor) === offset;
}
