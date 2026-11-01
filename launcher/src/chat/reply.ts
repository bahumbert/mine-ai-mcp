// How our answers are written to the player: whisper lines for a host, a `tellraw` line for the local console (spec D2).
import { PLAYER_NAME } from "./parse.ts";

const MAX_WHISPER_CHARS = 233;
const MAX_WHISPER_LINES = 4;
const CUT_MARK = "...";
/** Break points, best first; the break must leave at least half a line, else the next kind is tried. */
const BREAK_POINTS = [
  { text: " | ", keep: 0 },
  { text: ", ", keep: 1 },
  { text: " ", keep: 0 },
] as const;

/** Where to cut `text` so the first part has at most `limit` characters: [length of the first part, length of the break skipped]. */
function findCut(text: string, limit: number): [number, number] {
  for (const point of BREAK_POINTS) {
    const at = text.lastIndexOf(point.text, limit - point.keep);
    if (at >= limit / 2) return [at + point.keep, point.text.length - point.keep];
  }
  const highSurrogateEnds = /[\uD800-\uDBFF]/u.test(text[limit - 1] ?? "");
  return [highSurrogateEnds ? limit - 1 : limit, 0];
}

/** Splits an answer into whispers of at most `maxChars`, at most `maxLines`; the last one ends with `...` when text was cut. */
export function toWhisperLines(text: string, maxChars = MAX_WHISPER_CHARS, maxLines = MAX_WHISPER_LINES): string[] {
  let rest = text.replace(/\s+/gu, " ").trim();
  const lines: string[] = [];
  while (rest !== "") {
    if (rest.length <= maxChars) {
      lines.push(rest);
      break;
    }
    const isLastLine = lines.length === maxLines - 1;
    const [head, skipped] = findCut(rest, isLastLine ? maxChars - CUT_MARK.length : maxChars);
    lines.push(isLastLine ? `${rest.slice(0, head).trimEnd()}${CUT_MARK}` : rest.slice(0, head).trimEnd());
    if (isLastLine) break;
    rest = rest.slice(head + skipped).trimStart();
  }
  return lines;
}

/** One console command that whispers `text` to `username` as JSON text; throws unless `username` is a player name. */
export function tellrawLine(username: string, text: string): string {
  if (!PLAYER_NAME.test(username)) throw new Error(`Not a player name: ${JSON.stringify(username)}`);
  const line = `tellraw ${username} ${JSON.stringify({ text: text.replace(/[\r\n]/gu, " ") })}`;
  if (/[\r\n]/u.test(line)) throw new Error("A tellraw line must not hold a line break");
  return `${line}\n`;
}
