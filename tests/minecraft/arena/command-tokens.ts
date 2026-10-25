/** Text-level pieces of a Minecraft command: splitting it into words, and moving a number word without changing how it is written. */

const OPENING = "[{";
const CLOSING = "]}";

/**
 * The words of a command. A bracketed group (`[type=slab]`, `{Item:{id:"a b"}}`) or a quoted string is one word even
 * when it holds spaces, so a selector or an NBT compound is never cut in the middle. Runs of spaces between words
 * collapse to one on rejoin.
 */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote !== null) {
      if (char === "\\") current += char + (command[++i] ?? "");
      else {
        current += char;
        if (char === quote) quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (OPENING.includes(char)) depth++;
    else if (CLOSING.includes(char)) depth = Math.max(0, depth - 1);
    else if (/\s/u.test(char) && depth === 0) {
      if (current !== "") words.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current !== "") words.push(current);
  return words;
}

const NUMBER = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/u;
const RELATIVE = /^[~^](?:-?(?:\d+(?:\.\d+)?|\.\d+))?$/u;

/** `12`, `-3`, `25.5`: an absolute coordinate or number. */
export function isNumberWord(word: string | undefined): word is string {
  return word !== undefined && NUMBER.test(word);
}

/** `~`, `~1`, `^`, `^-2`: relative to where the command runs. */
export function isRelativeWord(word: string | undefined): word is string {
  return word !== undefined && RELATIVE.test(word);
}

/** Whether a word can be one component of a position. */
export function isCoordinateWord(word: string | undefined): word is string {
  return isNumberWord(word) || isRelativeWord(word);
}

/** A number word moved by an integer offset; an integer stays an integer, a decimal keeps its number of decimals. */
export function addToNumberWord(word: string, delta: number): string {
  if (delta === 0) return word;
  const decimals = word.split(".")[1]?.length ?? 0;
  return (Number(word) + delta).toFixed(decimals);
}
