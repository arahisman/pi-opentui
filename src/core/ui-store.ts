import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { object } from "./telemetry.ts";

export interface UiPreferences {
  [key: string]: unknown;
  sidebarVisible?: boolean;
  thinkingExpanded?: boolean;
  toolsExpanded?: boolean;
  lastSessionFile?: string;
}
export interface SessionNavigation {
  followLatest: boolean;
  anchorRowId?: string;
  anchorOffset?: number;
  windowEndRowId?: string;
  sidebarScrollTop: number;
  expandedToolRows: string[];
}
export interface SessionDraft {
  text: string;
  cursorOffset?: number;
  updatedAt: string;
}
export class UiStore {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
  }
  private read(name: string): unknown {
    const path = join(this.directory, name);
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (object(error).code === "ENOENT") return undefined;
      throw new Error(`Cannot load UI state ${path}`, { cause: error });
    }
  }
  private write(name: string, value: unknown): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, name),
      temporary = join(this.directory, `.${name}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(value) + "\n", "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, path);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        unlinkSync(temporary);
      } catch (cleanup) {
        if (object(cleanup).code !== "ENOENT")
          throw new AggregateError(
            [error, cleanup],
            `Cannot save or clean UI state ${path}`,
          );
      }
      throw new Error(`Cannot save UI state ${path}`, { cause: error });
    }
  }
  loadPreferences(): UiPreferences {
    const value = this.read("preferences.json");
    if (value === undefined) return {};
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid UI preferences: expected object");
    return structuredClone(value as UiPreferences);
  }
  savePreferences(patch: UiPreferences): void {
    this.write("preferences.json", { ...this.loadPreferences(), ...patch });
  }
  private draftFile(session: string): string {
    if (!session)
      throw new Error(
        "Draft requires a session path or explicit unsaved-session identity",
      );
    return `draft-${createHash("sha256")
      .update(session.startsWith("unsaved:") ? session : resolve(session))
      .digest("hex")}.json`;
  }
  loadNavigation(session: string): SessionNavigation | undefined {
    const value = this.read(
      this.draftFile(session).replace(/^draft-/, "navigation-"),
    );
    if (value === undefined) return undefined;
    const state = object(value);
    if (
      typeof state.followLatest !== "boolean" ||
      typeof state.sidebarScrollTop !== "number" ||
      !Number.isFinite(state.sidebarScrollTop) ||
      state.sidebarScrollTop < 0 ||
      (state.anchorOffset !== undefined &&
        (typeof state.anchorOffset !== "number" ||
          !Number.isFinite(state.anchorOffset) ||
          state.anchorOffset < 0)) ||
      [state.anchorRowId, state.windowEndRowId].some(
        (id) => id !== undefined && typeof id !== "string",
      ) ||
      !Array.isArray(state.expandedToolRows) ||
      state.expandedToolRows.some((id) => typeof id !== "string")
    )
      throw new Error("Invalid saved session navigation");
    return structuredClone(state) as unknown as SessionNavigation;
  }
  saveNavigation(session: string, state: SessionNavigation): void {
    this.write(
      this.draftFile(session).replace(/^draft-/, "navigation-"),
      state,
    );
  }
  loadDraft(session: string): SessionDraft | undefined {
    const value = this.read(this.draftFile(session));
    if (value === undefined) return undefined;
    const draft = object(value);
    if (
      typeof draft.text !== "string" ||
      typeof draft.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(draft.updatedAt)) ||
      (draft.cursorOffset !== undefined &&
        (!Number.isInteger(draft.cursorOffset) ||
          (draft.cursorOffset as number) < 0 ||
          (draft.cursorOffset as number) > draft.text.length))
    )
      throw new Error("Invalid session draft");
    return {
      text: draft.text,
      updatedAt: draft.updatedAt,
      ...(typeof draft.cursorOffset === "number"
        ? { cursorOffset: draft.cursorOffset }
        : {}),
    };
  }
  saveDraft(session: string, text: string, cursorOffset?: number): void {
    if (
      cursorOffset !== undefined &&
      (!Number.isInteger(cursorOffset) ||
        cursorOffset < 0 ||
        cursorOffset > text.length)
    )
      throw new Error("Draft cursorOffset is outside the text");
    this.write(this.draftFile(session), {
      text,
      updatedAt: new Date().toISOString(),
      ...(cursorOffset !== undefined ? { cursorOffset } : {}),
    });
  }
}
