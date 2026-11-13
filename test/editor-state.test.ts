import { expect, spyOn, test } from "bun:test";
import { Editor, getKeybindings } from "@earendil-works/pi-tui";
import {
  captureCursorOffset,
  restoreCursorOffset,
} from "../src/core/editor-state.ts";
import { ExtensionUIBridge } from "../src/host/extension-ui.ts";

function setup(text: string) {
  let submitted = 0;
  const bridge = new ExtensionUIBridge({
    onSubmit: () => {
      submitted++;
    },
  });
  bridge.setEditorText(text);
  const editor = bridge.editorComponent as Editor;
  let changed = 0;
  editor.onChange = () => {
    changed++;
  };
  return {
    bridge,
    editor,
    get submitted() {
      return submitted;
    },
    get changed() {
      return changed;
    },
  };
}
test("native Unicode multiline cursor offsets restore through public APIs without changing text or submitting", () => {
  const text = "first\nПривет 👩🏽‍💻 é 漢字\n\nlast";
  const s = setup(text);
  try {
    for (const offset of [0, 3, 6, 13, 20, 23, 25, text.length, 6, 0]) {
      if (offset > text.length) continue;
      const before = s.editor.getText();
      expect(restoreCursorOffset(s.editor, offset)).toBe(true);
      expect(captureCursorOffset(s.editor)).toBe(offset);
      expect(s.editor.getText()).toBe(before);
    }
    expect(s.changed).toBe(0);
    expect(s.submitted).toBe(0);
  } finally {
    s.bridge.dispose();
  }
});
test("cursor restoration crosses wrapped logical lines and preserves unfocused state", () => {
  const text = "a".repeat(1200) + "\n" + "漢字".repeat(300) + "\nend";
  const s = setup(text);
  try {
    s.editor.focused = false;
    s.editor.render(15);
    expect(restoreCursorOffset(s.editor, 606)).toBe(true);
    expect(s.editor.getCursor()).toEqual({ line: 0, col: 606 });
    s.editor.render(15);
    expect(restoreCursorOffset(s.editor, 1211)).toBe(true);
    expect(s.editor.getCursor()).toEqual({ line: 1, col: 10 });
    expect(s.editor.focused).toBe(false);
    expect(s.editor.getText()).toBe(text);
    expect(s.submitted).toBe(0);
    expect(s.changed).toBe(0);
  } finally {
    s.bridge.dispose();
  }
});
test("long-line restoration uses no character-by-character native input", () => {
  const s = setup("x".repeat(60000));
  const input = spyOn(Editor.prototype, "handleInput");
  const mouse = spyOn(Editor.prototype, "handleMouse");
  const render = spyOn(Editor.prototype, "render");
  try {
    expect(restoreCursorOffset(s.editor, 10)).toBe(true);
    expect(input).toHaveBeenCalledTimes(0);
    expect(mouse).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(2);
    expect(captureCursorOffset(s.editor)).toBe(10);
    expect(s.changed).toBe(0);
    expect(s.submitted).toBe(0);
  } finally {
    input.mockRestore();
    mouse.mockRestore();
    render.mockRestore();
    s.bridge.dispose();
  }
});
test("invalid offsets and partial graphemes are declined without moving the cursor", () => {
  const s = setup("a👩🏽‍💻éz");
  try {
    const initial = captureCursorOffset(s.editor);
    for (const offset of [-1, 1.5, Number.NaN, 9999, 2, 9]) {
      expect(restoreCursorOffset(s.editor, offset)).toBe(false);
      expect(captureCursorOffset(s.editor)).toBe(initial);
    }
    expect(s.changed).toBe(0);
    expect(s.submitted).toBe(0);
  } finally {
    s.bridge.dispose();
  }
});
test("expanded paste markers cannot be mapped and custom editors remain text-only", () => {
  const s = setup("");
  try {
    s.bridge.pasteToEditor("pasted line\n".repeat(30));
    expect(s.editor.getExpandedText()).not.toBe(s.editor.getText());
    expect(captureCursorOffset(s.editor)).toBeUndefined();
    expect(restoreCursorOffset(s.editor, 1)).toBe(false);
    const custom = {
      getText: () => "plain",
      setText: (_text: string) => {},
      handleInput: (_input: string) => {},
      render: () => ["plain"],
    };
    expect(captureCursorOffset(custom)).toBeUndefined();
    expect(restoreCursorOffset(custom, 2)).toBe(false);
    expect(captureCursorOffset(undefined)).toBeUndefined();
  } finally {
    s.bridge.dispose();
  }
});
test("addon factories, render wrappers and input handlers survive restoration", () => {
  const bridge = new ExtensionUIBridge();
  let intercepted = 0;
  const factory = (
    tui: Parameters<
      NonNullable<Parameters<ExtensionUIBridge["setEditorComponent"]>[0]>
    >[0],
    theme: Parameters<
      NonNullable<Parameters<ExtensionUIBridge["setEditorComponent"]>[0]>
    >[1],
  ) => {
    const editor = new Editor(tui, theme);
    const render = editor.render.bind(editor);
    editor.render = (width) => ["addon", ...render(width)];
    editor.handleInput = () => {
      intercepted++;
    };
    return editor;
  };
  try {
    bridge.setEditorComponent(factory);
    bridge.setEditorText("one\ntwo 👋\nthree");
    const editor = bridge.editorComponent;
    const input = editor.handleInput;
    expect(restoreCursorOffset(editor, 6)).toBe(true);
    expect(bridge.editorComponent).toBe(editor);
    expect(bridge.getEditorComponent()).toBe(factory);
    expect(editor.handleInput).toBe(input);
    expect(bridge.renderEditor(40)[0]).toBe("addon");
    expect(intercepted).toBe(0);
    expect(captureCursorOffset(editor)).toBe(6);
  } finally {
    bridge.dispose();
  }
});

test("conflicting navigation keybindings decline restoration before modifying content", () => {
  const s = setup("first\nsecond");
  const bindings = getKeybindings();
  const previous = bindings.getUserBindings();
  try {
    bindings.setUserBindings({
      ...previous,
      "tui.editor.undo": ["home", "ctrl+a"],
    });
    const offset = captureCursorOffset(s.editor);
    expect(restoreCursorOffset(s.editor, 2)).toBe(false);
    expect(captureCursorOffset(s.editor)).toBe(offset);
    expect(s.editor.getText()).toBe("first\nsecond");
    expect(s.changed).toBe(0);
    expect(s.submitted).toBe(0);
  } finally {
    bindings.setUserBindings(previous);
    s.bridge.dispose();
  }
});
