const directions: Record<string, string> = {
  "57350": "D",
  "57351": "C",
  "57352": "A",
  "57353": "B",
};

export function normalizeArrowInput(raw: string): string {
  const match = /^\x1b\[(57350|57351|57352|57353)(?:;(\d+)(?::[12])?)?u$/.exec(raw);
  if (!match) return raw;
  const direction = directions[match[1]!];
  const modifiers = match[2] ?? "1";
  return modifiers === "1" ? `\x1b[${direction}` : `\x1b[1;${modifiers}${direction}`;
}
