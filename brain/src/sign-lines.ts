// Fit model text to the free lines of a sign.

/** Wraps public sign text, refusing coordinates and line breaks. Width counts UTF-16 units. */
export function fitSignLines(input: readonly string[], width: number): { lines: string[]; refused: string[] } {
  const lines: string[] = [];
  const refused: string[] = [];
  for (const original of input) {
    if (/[\r\n]|(?:^|\D)-?\d+\s+-?\d+\s+-?\d+(?:\D|$)/u.test(original)) {
      refused.push(original);
      continue;
    }
    lines.push(...wrapLine(original, width));
  }
  return { lines, refused };
}

/** Wraps one accepted line without cutting a code point. */
function wrapLine(original: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of original.trim().split(/ +/u).filter(Boolean)) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = "";
    }
    if (current) current += " ";
    for (const char of word) {
      if (current.length + char.length > width) {
        lines.push(current);
        current = "";
      }
      current += char;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Keeps the longest prefix of complete accepted input lines that fits. */
export function fittingSignPrefix(lines: readonly string[], width: number): string[] {
  const kept: string[] = [];
  for (const line of lines) {
    const next = fitSignLines([line], width).lines;
    if (kept.length + next.length > 3) break;
    kept.push(...next);
  }
  return kept;
}

/** Describes every reason a first sign reply needs correction. */
export function signLineProblems(lines: readonly string[], width: number, fitted: { lines: string[]; refused: string[] }): string[] {
  const problems = lines.filter((line) => line.length > width).map((line) => `${JSON.stringify(line)} has ${line.length} characters; a line holds ${width}, spaces and punctuation included`);
  if (fitted.lines.length > 3) problems.push("three lines at most");
  if (fitted.refused.length > 0) problems.push("no coordinates or line breaks");
  return problems;
}
