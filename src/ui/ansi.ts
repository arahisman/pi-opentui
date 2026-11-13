import {
  RGBA,
  StyledText,
  TextAttributes,
  type TextChunk,
} from "@opentui/core";

export function ansiToStyledText(
  lines: string | readonly string[],
): StyledText {
  const source = typeof lines === "string" ? lines : lines.join("\n");
  const chunks: TextChunk[] = [];
  let fg: RGBA | undefined;
  let bg: RGBA | undefined;
  let attributes = 0;
  const cursorInverse: boolean[] = [];
  let text = "";
  const flush = () => {
    if (text) chunks.push({ __isChunk: true, text, fg, bg, attributes });
    text = "";
  };
  const sgr = (body: string) => {
    const values = body
      .replace(/::/g, ":")
      .split(/[;:]/)
      .map((value) => (value === "" ? 0 : Number(value)));
    for (let index = 0; index < values.length; index++) {
      const code = values[index]!;
      if (code === 0) {
        fg = undefined;
        bg = undefined;
        attributes = 0;
      } else if (code === 1) attributes |= TextAttributes.BOLD;
      else if (code === 2) attributes |= TextAttributes.DIM;
      else if (code === 3) attributes |= TextAttributes.ITALIC;
      else if (code === 4) attributes |= TextAttributes.UNDERLINE;
      else if (code === 5) attributes |= TextAttributes.BLINK;
      else if (code === 7) attributes |= TextAttributes.INVERSE;
      else if (code === 8) attributes |= TextAttributes.HIDDEN;
      else if (code === 9) attributes |= TextAttributes.STRIKETHROUGH;
      else if (code === 22)
        attributes &= ~(TextAttributes.BOLD | TextAttributes.DIM);
      else if (code === 23) attributes &= ~TextAttributes.ITALIC;
      else if (code === 24) attributes &= ~TextAttributes.UNDERLINE;
      else if (code === 25) attributes &= ~TextAttributes.BLINK;
      else if (code === 27) attributes &= ~TextAttributes.INVERSE;
      else if (code === 28) attributes &= ~TextAttributes.HIDDEN;
      else if (code === 29) attributes &= ~TextAttributes.STRIKETHROUGH;
      else if (code === 39) fg = undefined;
      else if (code === 49) bg = undefined;
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97))
        fg = RGBA.fromIndex(code >= 90 ? code - 90 + 8 : code - 30);
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107))
        bg = RGBA.fromIndex(code >= 100 ? code - 100 + 8 : code - 40);
      else if (code === 38 || code === 48) {
        const mode = values[++index];
        let color: RGBA | undefined;
        if (mode === 5) {
          const value = values[++index];
          if (
            value !== undefined &&
            Number.isInteger(value) &&
            value >= 0 &&
            value <= 255
          )
            color = RGBA.fromIndex(value);
        } else if (mode === 2) {
          const rgb = values.slice(index + 1, index + 4);
          index += 3;
          if (
            rgb.length === 3 &&
            rgb.every(
              (value) => Number.isInteger(value) && value >= 0 && value <= 255,
            )
          )
            color = RGBA.fromInts(rgb[0]!, rgb[1]!, rgb[2]!);
        }
        if (color) {
          if (code === 38) fg = color;
          else bg = color;
        }
      }
    }
  };
  for (let index = 0; index < source.length; ) {
    const code = source.charCodeAt(index);
    const escape = code === 27;
    const command = escape
      ? source[index + 1]
      : code === 0x9b
        ? "["
        : code === 0x9d
          ? "]"
          : code === 0x90
            ? "P"
            : code === 0x9e
              ? "^"
              : code === 0x9f
                ? "_"
                : code === 0x98
                  ? "X"
                  : undefined;
    if (command === "[") {
      flush();
      let end = index + (escape ? 2 : 1);
      const start = end;
      while (
        end < source.length &&
        !(source.charCodeAt(end) >= 0x40 && source.charCodeAt(end) <= 0x7e)
      )
        end++;
      if (source[end] === "m") sgr(source.slice(start, end));
      index = Math.min(source.length, end + 1);
    } else if (command && ["]", "P", "^", "_", "X"].includes(command)) {
      flush();
      index += escape ? 2 : 1;
      const start = index;
      while (
        index < source.length &&
        source.charCodeAt(index) !== 7 &&
        source.charCodeAt(index) !== 0x9c &&
        !(source[index] === "\x1b" && source[index + 1] === "\\")
      )
        index++;
      if (command === "_" && index < source.length) {
        const marker = source.slice(start, index);
        if (marker === "pi:fc") {
          cursorInverse.push((attributes & TextAttributes.INVERSE) !== 0);
          attributes |= TextAttributes.INVERSE;
        } else if (marker === "pi:/fc" && cursorInverse.length) {
          if (cursorInverse.pop()) attributes |= TextAttributes.INVERSE;
          else attributes &= ~TextAttributes.INVERSE;
        }
      }
      index += source[index] === "\x1b" ? 2 : 1;
    } else if (escape) {
      flush();
      index += 1;
      while (
        index < source.length &&
        source.charCodeAt(index) >= 0x20 &&
        source.charCodeAt(index) <= 0x2f
      )
        index++;
      if (index < source.length) index++;
    } else {
      if (code === 10 && cursorInverse.length) {
        flush();
        if (cursorInverse[0]) attributes |= TextAttributes.INVERSE;
        else attributes &= ~TextAttributes.INVERSE;
        cursorInverse.length = 0;
      }
      if (
        code === 10 ||
        code === 9 ||
        (code >= 32 && !(code >= 0x7f && code <= 0x9f))
      )
        text += source[index];
      index++;
    }
  }
  flush();
  return new StyledText(chunks);
}
