import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UiStore } from "../src/core/ui-store.ts";
const directories: string[] = [];
const temp = () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ui-store-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
test("preferences preserve unknown keys in the UI-owned file", () => {
  const directory = temp(),
    store = new UiStore(directory);
  expect(store.loadPreferences()).toEqual({});
  store.savePreferences({ sidebarVisible: true, extension: { future: 1 } });
  store.savePreferences({ thinkingExpanded: false });
  const loaded = new UiStore(directory).loadPreferences();
  expect(loaded).toEqual({
    sidebarVisible: true,
    thinkingExpanded: false,
    extension: { future: 1 },
  });
  expect(statSync(join(directory, "preferences.json")).mode & 0o777).toBe(
    0o600,
  );
});
test("Unicode drafts survive reopen and remain isolated by canonical path and unsaved identity", () => {
  const directory = temp(),
    store = new UiStore(directory),
    session = join(directory, "session.jsonl"),
    draft = "Привет 🌍\n中文";
  store.saveDraft(session, draft, draft.length);
  store.saveDraft(join(directory, "other/session.jsonl"), "other");
  store.saveDraft("unsaved:one", "one");
  store.saveDraft("unsaved:two", "two");
  const reopened = new UiStore(directory);
  expect(reopened.loadDraft(join(directory, "./session.jsonl"))?.text).toBe(
    draft,
  );
  expect(reopened.loadDraft(session)?.cursorOffset).toBe(draft.length);
  expect(reopened.loadDraft(join(directory, "other/session.jsonl"))?.text).toBe(
    "other",
  );
  expect(reopened.loadDraft("unsaved:one")?.text).toBe("one");
  expect(reopened.loadDraft("unsaved:two")?.text).toBe("two");
  expect(reopened.loadDraft("unsaved:none")).toBeUndefined();
  for (const file of readdirSync(directory))
    expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
});
test("empty draft intentionally replaces old text and rejects invalid cursors", () => {
  const store = new UiStore(temp());
  store.saveDraft("unsaved:a", "old");
  store.saveDraft("unsaved:a", "", 0);
  expect(store.loadDraft("unsaved:a")?.text).toBe("");
  expect(() => store.saveDraft("unsaved:a", "x", 2)).toThrow("cursorOffset");
  expect(() => store.loadDraft("")).toThrow("requires a session");
});
test("malformed state fails visibly rather than overwriting it", () => {
  const directory = temp(),
    store = new UiStore(directory);
  writeFileSync(join(directory, "preferences.json"), "{bad");
  expect(() => store.loadPreferences()).toThrow("Cannot load UI state");
  expect(() => store.savePreferences({ sidebarVisible: true })).toThrow();
  expect(readFileSync(join(directory, "preferences.json"), "utf8")).toBe(
    "{bad",
  );
});
test("failed atomic rename cleans scratch files and surfaces the failure", () => {
  const directory = temp(),
    store = new UiStore(directory);
  store.saveDraft("unsaved:a", "before");
  const file = readdirSync(directory)[0]!;
  rmSync(join(directory, file));
  mkdirSync(join(directory, file));
  expect(() => store.saveDraft("unsaved:a", "after")).toThrow(
    "Cannot save UI state",
  );
  expect(readdirSync(directory)).toEqual([file]);
  expect(statSync(join(directory, file)).isDirectory()).toBe(true);
});
test("malformed persisted draft is reported", () => {
  const directory = temp(),
    store = new UiStore(directory);
  store.saveDraft("unsaved:a", "text");
  writeFileSync(
    join(directory, readdirSync(directory)[0]!),
    JSON.stringify({ text: 5, updatedAt: "bad" }),
  );
  expect(() => store.loadDraft("unsaved:a")).toThrow("Invalid session draft");
});

test("session navigation persists independently with private files and rejects corrupt state", () => {
  const directory = temp(),
    store = new UiStore(directory);
  const navigation = {
    followLatest: false,
    anchorRowId: "message:0",
    anchorOffset: 3,
    windowEndRowId: "later:0",
    sidebarScrollTop: 12,
    expandedToolRows: ["tool:0"],
  };
  store.saveNavigation("/project/a.jsonl", navigation);
  expect(new UiStore(directory).loadNavigation("/project/a.jsonl")).toEqual(
    navigation,
  );
  expect(store.loadNavigation("/project/b.jsonl")).toBeUndefined();
  const file = readdirSync(directory).find((name) =>
    name.startsWith("navigation-"),
  )!;
  expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
  writeFileSync(
    join(directory, file),
    JSON.stringify({ ...navigation, anchorOffset: -1 }),
  );
  expect(() => store.loadNavigation("/project/a.jsonl")).toThrow(
    "Invalid saved session navigation",
  );
});
