import { expect, test } from "bun:test";
import {
  TextareaRenderable,
  type KeyEvent,
  type PasteEvent,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Input } from "@earendil-works/pi-tui";
import { OverlayManager } from "../src/ui/overlays.ts";
async function setup(width = 100, height = 32) {
  const testRenderer = await createTestRenderer({
    width,
    height,
    kittyKeyboard: true,
  });
  const editor = new TextareaRenderable(testRenderer.renderer, {
    id: "underlying-draft",
    width: 40,
    height: 3,
  });
  testRenderer.renderer.root.add(editor);
  editor.setText("Сохрани мой черновик");
  editor.focus();
  const manager = new OverlayManager(testRenderer.renderer);
  const key = (event: KeyEvent) => manager.handleKey(event),
    paste = (event: PasteEvent) => {
      if (manager.isOpen) {
        event.preventDefault();
        event.stopPropagation();
        manager.handlePaste(new TextDecoder().decode(event.bytes));
      }
    };
  testRenderer.renderer.keyInput.on("keypress", key);
  testRenderer.renderer.keyInput.on("paste", paste);
  return {
    ...testRenderer,
    editor,
    manager,
    cleanup: async () => {
      testRenderer.renderer.keyInput.off("keypress", key);
      testRenderer.renderer.keyInput.off("paste", paste);
      manager.dispose();
      editor.destroyRecursively();
      await testRenderer.dispose();
    },
  };
}
test("menu renders, filters Unicode, navigates and restores composer focus and draft", async () => {
  const s = await setup();
  let chosen = "";
  try {
    s.manager.openMenu({
      title: "Commands",
      items: [
        { id: "one", label: "New session" },
        { id: "two", label: "Модели" },
      ],
      onSelect: (id) => {
        chosen = id;
      },
    });
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain("Commands");
    expect(s.captureCharFrame()).toContain("› New session");
    expect(s.editor.focused).toBe(false);
    await s.mockInput.pasteBracketedText("Мод");
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain("› Модели");
    expect(s.captureCharFrame()).not.toContain("New session");
    s.mockInput.pressEnter();
    await s.renderOnce();
    expect(chosen).toBe("two");
    expect(s.manager.isOpen).toBe(false);
    expect(s.editor.focused).toBe(true);
    expect(s.editor.plainText).toBe("Сохрани мой черновик");
  } finally {
    await s.cleanup();
  }
});
test("menu paging keeps selection visible, supports tabs, clicks, and empty states", async () => {
  const s = await setup(50, 12);
  let chosen = "",
    tab = -1;
  try {
    s.manager.openMenu({
      title: "Sessions",
      items: Array.from({ length: 40 }, (_, i) => ({
        id: String(i),
        label: `Session ${i}`,
      })),
      tabs: ["Recent", "All"],
      onTab: (index) => {
        tab = index;
      },
      onSelect: (id) => {
        chosen = id;
      },
    });
    s.mockInput.pressKey("\x1b[6~");
    s.mockInput.pressTab();
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain("› Session 7");
    expect(tab).toBe(1);
    expect(s.captureCharFrame()).toContain("[All]");
    const lines = s.captureCharFrame().split("\n"),
      row = lines.findIndex((line) => line.includes("Session 8")),
      column = lines[row]!.indexOf("Session 8");
    await s.mockMouse.click(column, row);
    expect(chosen).toBe("8");
    s.manager.openMenu({ title: "Empty", items: [], onSelect: () => {} });
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain("No items");
    s.mockInput.pressEnter();
    expect(s.manager.isOpen).toBe(true);
    s.manager.openMenu({
      title: "Search",
      items: [{ id: "a", label: "Alpha" }],
      query: "none",
      onSelect: () => {},
    });
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain("No results");
  } finally {
    await s.cleanup();
  }
});
test("Unicode editable and secret inputs never echo secrets and multiline submit works", async () => {
  const s = await setup();
  let submitted = "";
  try {
    s.manager.openInput({
      title: "API key",
      secret: true,
      onSubmit: (value) => {
        submitted = value;
      },
    });
    await s.mockInput.pasteBracketedText("секрет🌍");
    await s.renderOnce();
    expect(s.captureCharFrame()).not.toContain("секрет");
    expect(s.captureCharFrame()).toContain("•••••••");
    s.mockInput.pressBackspace();
    s.mockInput.pressEnter();
    expect(submitted).toBe("секрет");
    s.manager.openInput({
      title: "Message",
      value: "one",
      multiline: true,
      onSubmit: (value) => {
        submitted = value;
      },
    });
    s.mockInput.pressEnter({ shift: true });
    await s.mockInput.pasteBracketedText("two 🌍");
    s.resize(20, 8);
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain("two 🌍");
    s.mockInput.pressEnter();
    expect(submitted).toBe("one\ntwo 🌍");
    expect(s.editor.plainText).toBe("Сохрани мой черновик");
  } finally {
    await s.cleanup();
  }
});
test("native bridge forwards raw keys and bracketed paste, refreshes and cancels once", async () => {
  const s = await setup();
  let cancel = 0,
    body = "Native question";
  const inputs: string[] = [],
    widths: number[] = [];
  try {
    s.manager.openNative({
      title: "Extension",
      render: (width) => {
        widths.push(width);
        return body;
      },
      onInput: (raw) => {
        inputs.push(raw);
      },
      onCancel: () => {
        cancel++;
      },
    });
    await s.renderOnce();
    s.mockInput.pressArrow("down");
    await s.mockInput.pasteBracketedText("yes");
    expect(inputs).toContain("\x1b[57353u");
    expect(inputs).toContain("\x1b[200~yes\x1b[201~");
    body = "Updated";
    s.manager.refresh();
    s.resize(20, 8);
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain("Updated");
    expect(widths.at(-1)).toBeLessThanOrEqual(20);
    s.mockInput.pressEscape();
    expect(inputs).toContain("\x1b[27u");
    expect(s.manager.isOpen).toBe(true);
    expect(cancel).toBe(0);
    s.mockInput.pressCtrlC();
    expect(cancel).toBe(1);
    s.manager.close();
    expect(cancel).toBe(1);
    expect(s.editor.focused).toBe(true);
  } finally {
    await s.cleanup();
  }
});
test("text detail scroll and keyboard actions work; rejected callbacks surface visibly", async () => {
  const s = await setup(60, 14);
  let action = "";
  try {
    s.manager.openText({
      title: "Details",
      body: Array.from({ length: 80 }, (_, i) => `Detail line ${i}`).join("\n"),
      actions: [
        { id: "accept", label: "Accept" },
        { id: "reject", label: "Reject" },
      ],
      onAction: (id) => {
        action = id;
      },
    });
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain("Detail line 0");
    s.mockInput.pressKey("\x1b[6~");
    await s.renderOnce();
    expect(s.captureCharFrame()).not.toContain("Detail line 0");
    s.mockInput.pressTab();
    s.mockInput.pressEnter();
    expect(action).toBe("reject");
    s.manager.openMenu({
      title: "Fail",
      items: [{ id: "x", label: "Throw" }],
      onSelect: async () => {
        throw new Error("Visible failure");
      },
    });
    s.mockInput.pressEnter();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain("Action failed");
    expect(s.captureCharFrame()).toContain("Visible failure");
  } finally {
    await s.cleanup();
  }
});
test("menu and input cancellation settles exactly once on escape, close, replacement and disposal", async () => {
  const s = await setup();
  let menuCancelled = 0,
    inputCancelled = 0;
  const menu = () =>
    s.manager.openMenu({
      title: "Choose",
      items: [{ id: "a", label: "Alpha" }],
      onSelect: () => {},
      onCancel: () => {
        menuCancelled++;
      },
    });
  const input = () =>
    s.manager.openInput({
      title: "Input",
      onSubmit: () => {},
      onCancel: () => {
        inputCancelled++;
      },
    });
  try {
    menu();
    s.mockInput.pressEscape();
    s.manager.close();
    expect(menuCancelled).toBe(1);
    input();
    s.manager.close();
    s.manager.close();
    expect(inputCancelled).toBe(1);
    menu();
    input();
    expect(menuCancelled).toBe(2);
    menu();
    expect(inputCancelled).toBe(2);
    s.manager.dispose();
    expect(menuCancelled).toBe(3);
    s.manager.dispose();
    expect(menuCancelled).toBe(3);
  } finally {
    await s.cleanup();
  }
});
test("successful input submit and menu selection never call cancellation", async () => {
  const s = await setup();
  let cancelled = 0,
    selected = "",
    submitted = "";
  try {
    s.manager.openMenu({
      title: "Choose",
      items: [{ id: "a", label: "Alpha" }],
      onSelect: (id) => {
        selected = id;
      },
      onCancel: () => {
        cancelled++;
      },
    });
    s.mockInput.pressEnter();
    expect(selected).toBe("a");
    expect(cancelled).toBe(0);
    s.manager.openInput({
      title: "Input",
      value: "secret",
      secret: true,
      onSubmit: (value) => {
        submitted = value;
      },
      onCancel: () => {
        cancelled++;
      },
    });
    s.mockInput.pressEnter();
    expect(submitted).toBe("secret");
    expect(cancelled).toBe(0);
    s.manager.close();
    expect(cancelled).toBe(0);
  } finally {
    await s.cleanup();
  }
});

test("real Pi custom input receives Escape for back navigation without losing its overlay", async () => {
  const s = await setup();
  const component = new Input();
  let back = 0,
    cancelled = 0;
  component.setValue("Editing");
  component.onEscape = () => {
    back++;
    component.setValue("Back to questionnaire");
  };
  try {
    s.manager.openNative({
      title: "Pi custom component",
      render: (width) => component.render(width).join("\n"),
      onInput: (raw) => component.handleInput(raw),
      onCancel: () => {
        cancelled++;
      },
    });
    await s.renderOnce();
    s.mockInput.pressEscape();
    await s.renderOnce();
    expect(back).toBe(1);
    expect(component.getValue()).toBe("Back to questionnaire");
    expect(s.manager.isOpen).toBe(true);
    expect(cancelled).toBe(0);
    expect(s.captureCharFrame()).toContain("ctrl+c close");
    s.mockInput.pressCtrlC();
    expect(cancelled).toBe(1);
    expect(s.manager.isOpen).toBe(false);
  } finally {
    await s.cleanup();
  }
});
test("repeated replacement and wide/tiny resize retain exactly one overlay and peach full-width selection", async () => {
  const s = await setup(150, 46);
  try {
    for (let iteration = 0; iteration < 12; iteration++) {
      const [width, height] = iteration % 2 ? [20, 8] : [150, 46];
      s.resize(width!, height!);
      s.manager.openMenu({
        title: "Commands",
        items: [
          { id: "one", label: "Model" },
          { id: "two", label: "Sessions" },
        ],
        onSelect: () => {},
      });
      await s.renderOnce();
      expect(
        s.renderer.root
          .getChildren()
          .filter((child) => child.id === "overlay-layer").length,
      ).toBe(1);
      expect(s.captureCharFrame().match(/Commands/g)?.length).toBe(1);
      const row = s.renderer.root.findDescendantById("overlay-item-0-row")!;
      const selected = s
        .captureSpans()
        .lines.find((line) =>
          line.spans.some((span) => span.text.includes("› Model")),
        )!;
      const highlight = selected.spans.filter(
        (span) => span.bg.toInts().slice(0, 3).join(",") === "250,178,131",
      );
      expect(highlight.reduce((sum, span) => sum + span.width, 0)).toBe(
        row.width,
      );
      expect(
        highlight
          .find((span) => span.text.includes("Model"))!
          .fg.toInts()
          .slice(0, 3),
      ).toEqual([10, 10, 10]);
      s.mockInput.pressArrow("down");
      await s.renderOnce();
      expect(s.captureCharFrame().match(/Commands/g)?.length).toBe(1);
      s.manager.close();
      await s.renderOnce();
      expect(
        s.renderer.root
          .getChildren()
          .filter((child) => child.id === "overlay-layer").length,
      ).toBe(0);
      expect(s.captureCharFrame()).not.toContain("Commands");
    }
  } finally {
    await s.cleanup();
  }
});

test("successful text actions do not cancel and sign-in actions can keep the waiting dialog open", async () => {
  const s = await setup();
  let cancelled = 0,
    actions = 0;
  try {
    s.manager.openText({
      title: "Continue sign-in",
      body: "Open the browser",
      keepOpenOnAction: true,
      actions: [{ id: "open", label: "Open browser" }],
      onAction: () => {
        actions++;
      },
      onCancel: () => {
        cancelled++;
      },
    });
    await s.renderOnce();
    s.mockInput.pressEnter();
    expect(actions).toBe(1);
    expect(cancelled).toBe(0);
    expect(s.manager.isOpen).toBe(true);
    s.mockInput.pressEscape();
    expect(cancelled).toBe(1);
    s.manager.openText({
      title: "Details",
      body: "Result",
      actions: [{ id: "accept", label: "Accept" }],
      onAction: () => {
        actions++;
      },
      onCancel: () => {
        cancelled++;
      },
    });
    await s.renderOnce();
    s.mockInput.pressEnter();
    expect(actions).toBe(2);
    expect(cancelled).toBe(1);
    expect(s.manager.isOpen).toBe(false);
  } finally {
    await s.cleanup();
  }
});

test("small menus use a compact centered panel while tall menus remain bounded", async () => {
  const s = await setup(120, 40);
  try {
    s.manager.openMenu({
      title: "Sign in",
      items: [
        { id: "oauth", label: "Subscription" },
        { id: "key", label: "API key" },
      ],
      onSelect: () => {},
    });
    await s.renderOnce();
    const panel = s.renderer.root.findDescendantById("overlay-panel")!;
    expect(panel.height).toBe(7);
    expect(panel.y).toBe(Math.floor((40 - panel.height) / 2));
    s.manager.openMenu({
      title: "Models",
      items: Array.from({ length: 100 }, (_, i) => ({
        id: `${i}`,
        label: `Model ${i}`,
      })),
      onSelect: () => {},
    });
    await s.renderOnce();
    expect(s.renderer.root.findDescendantById("overlay-panel")!.height).toBe(
      26,
    );
  } finally {
    await s.cleanup();
  }
});
