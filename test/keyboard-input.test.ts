import { expect, test } from "bun:test";
import { matchesKey } from "@earendil-works/pi-tui";
import { normalizeArrowInput } from "../src/ui/keyboard-input.ts";

test("Kitty functional arrows reach Pi bindings with their modifiers preserved", () => {
  for (const [code, direction] of [[57350, "left"], [57351, "right"], [57352, "up"], [57353, "down"]] as const) {
    for (const [modifier, prefix] of [[1, ""], [2, "shift+"], [3, "alt+"], [5, "ctrl+"], [6, "shift+ctrl+"]] as const) {
      const raw = modifier === 1 ? `\x1b[${code}u` : `\x1b[${code};${modifier}u`;
      expect(matchesKey(normalizeArrowInput(raw), `${prefix}${direction}`)).toBe(true);
      expect(matchesKey(normalizeArrowInput(`\x1b[${code};${modifier}:2u`), `${prefix}${direction}`)).toBe(true);
    }
  }
});

test("legacy arrows and unrelated Kitty inputs are left intact", () => {
  for (const raw of ["\x1b[A", "\x1b[1;5D", "\x1b[97u", "\x1b[57350;1:3u", "\r", "hello", "\x1b[57354u"])
    expect(normalizeArrowInput(raw)).toBe(raw);
});
