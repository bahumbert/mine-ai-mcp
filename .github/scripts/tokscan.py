#!/usr/bin/env python3
"""
tokscan - estimate the token cost of a repo AND of what surrounds an agent session.
Can compare the working tree with a git ref and gate pull requests in CI.

Features:
  1. Repo scan: total, per folder, per extension/language (density), per file.
  2. Init cost: CLAUDE.md (+ @imports), rules, skills, agents, commands,
     Copilot instructions, AGENTS.md, configured MCP servers.
  3. --measure CMD: token cost of a command's output (tests, build, git...).
  4. --find NAME / --find-sample N: "naive" cost (grep + whole-file read) vs
     "targeted" cost (function body only) to locate a function.
  5. --calibrate: measure the real chars/token ratio per extension with the
     Anthropic count_tokens endpoint (needs ANTHROPIC_API_KEY).
  6. Files too big to read in one go (--big-threshold), tagged lockfile / minified.
  7. Share of comments and docstrings per language (heuristic).
  8. --diff [REF] / --diff-history N: git diff sizes; with --measure, an
     edit-test loop model (--loop N).
  9. --compare REF: working tree vs a git ref (total, per folder, new big files,
     init cost). --long-functions N lists long functions (only new/grown ones with
     --compare). --fail-over PCT / --fail-long N turn that into an exit code.
 10. --json PATH / --markdown PATH: machine-readable summary / compact PR comment.

Tokens are ESTIMATED by default (chars / ratio, 3.5 by default, ~25 % margin).
No dependencies (Python 3.8+).

Examples:
    python tokscan.py
    python tokscan.py . --measure "pytest -q" --measure "git status"
    python tokscan.py . --find parse_config --find-sample 30
    python tokscan.py . --calibrate --model claude-sonnet-5-5
    python tokscan.py . --no-home --compare origin/main --long-functions 80 \\
        --fail-over 10 --fail-long 150 --markdown report.md --json report.json
"""
import argparse
import bisect
import json
import os
import random
import re
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

DEFAULT_IGNORE = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "env", "dist",
    "build", "target", ".idea", ".vscode", ".next", ".cache", ".mypy_cache",
    ".pytest_cache", ".gradle", ".tox",
}

BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tga", ".dds",
    ".psd", ".svgz", ".pdf", ".zip", ".gz", ".tar", ".7z", ".rar", ".bz2",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".class", ".jar", ".pyc",
    ".mp3", ".mp4", ".wav", ".ogg", ".mov", ".avi", ".woff", ".woff2",
    ".ttf", ".otf", ".eot", ".dat", ".db", ".sqlite", ".lock",
}

# --- JS / TS definition patterns -------------------------------------------------
# Parameter lists: balanced parentheses, nested up to 3 levels, may span lines.
_P1 = r"[^()]*(?:\([^()]*\)[^()]*)*"
_P2 = r"[^()]*(?:\(" + _P1 + r"\)[^()]*)*"
_PARAMS = r"\(" + _P2 + r"\)"
_GEN = r"(?:<[^()\n]*>)?"                       # generic parameters <T extends X>
_NAME = r"([A-Za-z_$][\w$]*)"
_NOT_KW = r"(?!(?:if|for|while|switch|catch|return|function|new|else|do|try)\b)"
_JS_MODS = r"(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)[ \t]+)*"
_JS = [
    # function declarations: function f(, export function, export async function, generics
    r"\bfunction\*?[ \t]+" + _NAME + r"[ \t]*" + _GEN + r"[ \t]*\(",
    # export default function (anonymous, reported as "default")
    r"\bexport[ \t]+(default)[ \t]+(?:async[ \t]+)?function\*?[ \t]*" + _GEN + r"[ \t]*\(",
    # const f = (a): T => ..., const f = async <T>(a) => ..., const f = x => ..., const f = function
    r"^[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+" + _NAME + r"[ \t]*(?::[^=\n]+)?=[ \t]*(?:async[ \t]*)?"
    r"(?:function\b|" + _GEN + _PARAMS + r"(?:[ \t]*:[^=;{]*?)?[ \t]*=>|[A-Za-z_$][\w$]*[ \t]*=>)",
    # class / object properties holding functions: handler = async (e) => ..., on: (e) => ..., run: function (
    r"^[ \t]+" + _JS_MODS + _NOT_KW + _NAME + r"[ \t]*[:=][ \t]*(?:async[ \t]*)?"
    # The arrow must open a block / parenthesised body or end the line: this excludes
    # function *types* such as `cb: (x: number) => void,` and one-line stubs.
    r"(?:function\b|(?:" + _GEN + _PARAMS + r"(?:[ \t]*:[^=;{]*?)?|[A-Za-z_$][\w$]*)[ \t]*=>[ \t]*(?:[{(]|$))",
    # class / object methods: [modifiers] [*]name[<T>](params)[: ReturnType] {
    r"^[ \t]+" + _JS_MODS + r"\*?" + _NOT_KW + _NAME + r"[ \t]*" + _GEN + r"[ \t]*" + _PARAMS +
    r"[ \t]*(?::[^{;]*)?\{",
]
_MODS = r"(?:(?:public|private|protected|internal|static|final|abstract|synchronized|async|override|virtual)[ \t]+)+"
_JAVALIKE = [r"^[ \t]*" + _MODS + r"[\w<>\[\],.? \t]+?[ \t]+([A-Za-z_]\w*)[ \t]*\([^;{]*\)[ \t]*(?:throws[ \t]+[\w., \t]+)?\{"]

DEF_REGEX = {
    ".py": [r"^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)"],
    ".js": _JS, ".jsx": _JS, ".ts": _JS, ".tsx": _JS, ".mjs": _JS, ".cjs": _JS,
    ".go": [r"^func[ \t]+(?:\([^)]*\)[ \t]*)?([A-Za-z_]\w*)[ \t]*[\(\[]"],
    ".rs": [r"^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:const[ \t]+)?(?:async[ \t]+)?(?:unsafe[ \t]+)?fn[ \t]+([A-Za-z_]\w*)"],
    ".java": _JAVALIKE, ".cs": _JAVALIKE,
    ".kt": [r"\bfun[ \t]+(?:<[^>]*>[ \t]*)?(?:[\w.]+\.)?([A-Za-z_]\w*)[ \t]*\("],
    ".rb": [r"^[ \t]*def[ \t]+(?:self\.)?([A-Za-z_]\w*[?!=]?)"],
    ".php": [r"\bfunction[ \t]+&?([A-Za-z_]\w*)[ \t]*\("],
    ".lua": [r"\bfunction[ \t]+(?:[\w.]+[.:])?([A-Za-z_]\w*)[ \t]*\("],
}
BODY_STYLE = {".py": "indent", ".rb": "end", ".lua": "end"}

LOCK_NAMES = {"package-lock.json", "pnpm-lock.yaml", "yarn.lock", "composer.lock",
              "poetry.lock", "Pipfile.lock", "Cargo.lock", "go.sum", "uv.lock"}

NO_EXT = "(no ext.)"
LONG_LIMIT = 5000  # max body lines scanned when looking for long functions

# (line comment prefixes, block (open, close) or None,
#  triple-quote docstrings, backticks = strings, quotes = strings)
_SLASH = (("//",), ("/*", "*/"), False, True, True)
_HASH = (("#",), None, False, False, True)
COMMENT_STYLE = {".py": (("#",), None, True, False, True),
                 ".lua": (("--",), ("--[[", "]]"), False, False, True),
                 ".sql": (("--",), ("/*", "*/"), False, False, True),
                 ".css": ((), ("/*", "*/"), False, False, True)}
for _e in (".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".java", ".c", ".h", ".cpp", ".cc", ".hpp",
           ".cs", ".go", ".rs", ".kt", ".swift", ".scala", ".dart", ".php", ".scss"):
    COMMENT_STYLE[_e] = _SLASH
for _e in (".sh", ".bash", ".zsh", ".rb", ".yml", ".yaml", ".toml", ".r", ".pl", ".mk", ".ps1"):
    COMMENT_STYLE[_e] = _HASH
for _e in (".html", ".htm", ".xml", ".svg"):
    COMMENT_STYLE[_e] = ((), ("<!--", "-->"), False, False, False)

_COMMENT_RX = {}


def comment_chars(text, ext):
    """Number of comment / docstring characters (heuristic, None if the language is not handled)."""
    style = COMMENT_STYLE.get(ext)
    if not style:
        return None
    prefixes, block, doc, backtick, strings = style
    rx = _COMMENT_RX.get(ext)
    if rx is None:
        alts = ['"""', "'''"] if doc else []
        if block:
            alts.append(re.escape(block[0]))
        alts += [re.escape(p) for p in prefixes]
        if strings:
            alts += ['"', "'"] + (["`"] if backtick else [])
        rx = _COMMENT_RX[ext] = re.compile("|".join(alts))
    n, i, cc = len(text), 0, 0
    while True:
        m = rx.search(text, i)
        if not m:
            break
        tok, s = m.group(), m.start()
        if doc and tok in ('"""', "'''"):
            j = text.find(tok, s + 3)
            end = n if j == -1 else j + 3
            if not text[text.rfind("\n", 0, s) + 1:s].strip():  # docstring: alone at line start
                cc += end - s
            i = end
        elif block and tok == block[0]:
            j = text.find(block[1], s + len(tok))
            end = n if j == -1 else j + len(block[1])
            cc += end - s
            i = end
        elif tok in prefixes:
            e = text.find("\n", s)
            e = n if e == -1 else e
            cc += e - s
            i = e
        else:  # string: skip it (end of line, except backtick)
            j = s + 1
            while j < n:
                c = text[j]
                if c == "\\":
                    j += 2
                    continue
                if c == tok:
                    j += 1
                    break
                if c == "\n" and tok != "`":
                    break
                j += 1
            i = j
    return cc


def fmt(n):
    return f"{n:,}"


def sfmt(n):
    return f"{n:+,}"


def pct_of(delta, base):
    return delta / base * 100 if base else 0.0


# ----------------------------------------------------------------------------
# Estimation
# ----------------------------------------------------------------------------
class Estimator:
    def __init__(self, default_ratio):
        self.default = default_ratio
        self.ratios = {}

    def ratio(self, ext):
        return self.ratios.get(ext, self.default)

    def tokens(self, chars, ext=""):
        return round(chars / self.ratio(ext))

    def text(self, s, ext=""):
        return self.tokens(len(s), ext)


# ----------------------------------------------------------------------------
# File listing / reading
# ----------------------------------------------------------------------------
def list_git(root):
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-co", "--exclude-standard", "-z"],
            capture_output=True, check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    names = out.stdout.decode("utf-8", "replace").split("\0")
    return [root / n for n in names if n]


def list_walk(root, ignore):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ignore]
        for f in filenames:
            yield Path(dirpath) / f


def decode_text(data, max_bytes):
    """Bytes -> text (CRLF normalised), None for binary / oversized data."""
    if len(data) > max_bytes or b"\0" in data[:8192]:
        return None
    return data.decode("utf-8", errors="ignore").replace("\r\n", "\n")


def read_text(path, max_bytes):
    try:
        if path.stat().st_size > max_bytes:
            return None
        data = path.read_bytes()
    except OSError:
        return None
    return decode_text(data, max_bytes)


def read_any(path):
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None


def bar(value, total, width=20):
    return "#" * (round(width * value / total) if total else 0)


def keep_path(rel, ignore, exts):
    """None = keep, "ignored" = silently dropped, "binary" = counted as skipped."""
    if any(part in ignore for part in rel.parts[:-1]):
        return "ignored"
    suffix = rel.suffix.lower()
    if exts and suffix not in exts:
        return "ignored"
    if suffix in BINARY_EXT:
        return "binary"
    return None


def make_record(rel, text, extra=True):
    suffix = rel.suffix.lower()
    lines = text.count("\n") + (1 if text and not text.endswith("\n") else 0)
    rec = {"rel": rel, "ext": suffix or NO_EXT, "chars": len(text), "lines": lines}
    if extra:
        rec["maxline"] = max((len(l) for l in text.split("\n")), default=0)
        rec["comment"] = comment_chars(text, suffix)
    return rec


def scan_current(root, files, ignore, exts, max_bytes, need_texts):
    records, texts, skipped = [], {}, 0
    for p in files:
        try:
            rel = p.relative_to(root)
        except ValueError:
            continue
        verdict = keep_path(rel, ignore, exts)
        if verdict == "ignored":
            continue
        if verdict == "binary":
            skipped += 1
            continue
        text = read_text(p, max_bytes)
        if text is None:
            skipped += 1
            continue
        records.append(make_record(rel, text))
        if need_texts:
            texts[rel] = text
    return records, texts, skipped


def git_out(root, *args):
    try:
        p = subprocess.run(["git", "-C", str(root)] + list(args), capture_output=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return p.stdout.decode("utf-8", "replace") if p.returncode == 0 else None


def read_blobs(root, ref, paths, chunk=1000):
    """{path: bytes} for files of git ref REF (same content as `git show REF:path`, in batches)."""
    out = {}
    for c in range(0, len(paths), chunk):
        part = paths[c:c + chunk]
        inp = "".join(f"{ref}:./{p}\n" for p in part).encode("utf-8")
        try:
            buf = subprocess.run(["git", "-C", str(root), "cat-file", "--batch"], input=inp,
                                 capture_output=True, timeout=300).stdout
        except (OSError, subprocess.TimeoutExpired):
            continue
        pos = 0
        for p in part:
            nl = buf.find(b"\n", pos)
            if nl == -1:
                break
            header = buf[pos:nl].split()
            pos = nl + 1
            if len(header) == 3 and header[1] == b"blob":
                size = int(header[2])
                out[p] = buf[pos:pos + size]
                pos += size + 1
    return out


def scan_ref(root, ref, ignore, exts, max_bytes, need_texts):
    """Same filters as scan_current, on the tree of git ref REF. Returns (records, texts, skipped, names)."""
    listing = git_out(root, "ls-tree", "-r", "--name-only", "-z", ref)
    names = [n for n in (listing or "").split("\0") if n]
    wanted, skipped = [], 0
    for n in names:
        verdict = keep_path(Path(n), ignore, exts)
        if verdict == "binary":
            skipped += 1
        elif verdict is None:
            wanted.append(n)
    records, texts = [], {}
    for n, data in read_blobs(root, ref, wanted).items():
        text = decode_text(data, max_bytes)
        if text is None:
            skipped += 1
            continue
        rel = Path(n)
        records.append(make_record(rel, text, extra=False))
        if need_texts:
            texts[rel] = text
    return records, texts, skipped, names


# ----------------------------------------------------------------------------
# Init cost
# ----------------------------------------------------------------------------
def parse_frontmatter(text):
    m = re.match(r"^﻿?---[ \t]*\n(.*?)\n---[ \t]*(?:\n|$)", text, re.S)
    if not m:
        return {}
    fm, key, buf = {}, None, []

    def flush():
        if key is not None:
            val = " ".join(b for b in buf if b).strip()
            val = re.sub(r"^[>|][+-]?\s*", "", val)
            fm[key] = val.strip("\"'")

    for line in m.group(1).splitlines():
        km = re.match(r"^([A-Za-z_][\w-]*)[ \t]*:(.*)$", line)
        if km and not line.startswith((" ", "\t")):
            flush()
            key, buf = km.group(1), [km.group(2).strip()]
        elif key is not None:
            buf.append(line.strip())
    flush()
    return fm


def expand_imports(path, text, home, depth=5, seen=None):
    """Files imported with @path inside a CLAUDE.md (outside code fences)."""
    seen = seen if seen is not None else {str(path)}
    found, in_fence = [], False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for m in re.finditer(r"(?<![\w@./-])@((?:~|\.{1,2})?/?[\w./-]+\.\w+)", line):
            ref = m.group(1)
            if ref.startswith("~"):
                cand = home / ref[1:].lstrip("/")
            elif ref.startswith("/"):
                cand = Path(ref)
            else:
                cand = path.parent / ref
            if cand.is_file() and str(cand) not in seen:
                seen.add(str(cand))
                found.append(cand)
                sub = read_any(cand)
                if sub and depth > 1:
                    found.extend(expand_imports(cand, sub, home, depth - 1, seen))
    return found


def short_path(p, root, home):
    try:
        return p.relative_to(root).as_posix()
    except ValueError:
        pass
    try:
        return "~/" + p.relative_to(home).as_posix()
    except ValueError:
        return str(p)


def collect_init(root, home, est, rels, use_home, plugins, walk_parents=True):
    items, seen = [], set()

    def push(p, tool, always, cond, demand, note=""):
        key = (str(p), tool)
        if key in seen:
            return
        seen.add(key)
        items.append({"path": short_path(p, root, home), "tool": tool,
                      "always": always, "cond": cond, "demand": demand, "note": note})

    def add_file(p, tool, mode, note=""):
        text = read_any(p) if p.is_file() else None
        if text is None:
            return None
        t = est.text(text, ".md")
        push(p, tool, t if mode == "always" else 0, t if mode == "cond" else 0,
             t if mode == "demand" else 0, note)
        return text

    def add_meta(p, tool, fallback_name, note=""):
        text = read_any(p) if p.is_file() else None
        if text is None:
            return
        fm = parse_frontmatter(text)
        label = (fm.get("name") or fallback_name) + ": " + fm.get("description", "")
        push(p, tool, est.text(label, ".md"), 0, est.text(text, ".md"), note)

    def add_claude_md(p, note=""):
        text = add_file(p, "claude", "always", note)
        if text:
            for imp in expand_imports(p, text, home):
                add_file(imp, "claude", "always", "import of " + p.name)

    def claude_dir(base):
        for p in sorted((base / ".claude" / "rules").glob("**/*.md")):
            fm = parse_frontmatter(read_any(p) or "")
            add_file(p, "claude", "cond" if fm.get("paths") else "always",
                     "rule" + (" (paths:)" if fm.get("paths") else ""))
        for p in sorted((base / ".claude" / "skills").glob("*/SKILL.md")):
            add_meta(p, "claude", p.parent.name, "skill")
        for p in sorted((base / ".claude" / "agents").glob("*.md")):
            add_meta(p, "claude", p.stem, "agent")
        for p in sorted((base / ".claude" / "commands").glob("**/*.md")):
            add_meta(p, "claude", p.stem, "command")

    if use_home:
        add_claude_md(home / ".claude" / "CLAUDE.md")
        claude_dir(home)
        if plugins:
            pdir = home / ".claude" / "plugins"
            try:
                for p in sorted(pdir.rglob("SKILL.md")):
                    if "node_modules" not in p.parts:
                        add_meta(p, "claude", p.parent.name, "skill (plugin)")
                for p in sorted(pdir.rglob("*.md")):
                    if p.parent.name in ("agents", "commands") and "node_modules" not in p.parts:
                        add_meta(p, "claude", p.stem, p.parent.name[:-1] + " (plugin)")
            except OSError:
                pass

    d = root
    while True:
        add_claude_md(d / "CLAUDE.md", "" if d == root else "parent folder")
        add_claude_md(d / "CLAUDE.local.md")
        if not walk_parents or d == home or d.parent == d:
            break
        d = d.parent
    add_claude_md(root / ".claude" / "CLAUDE.md")
    claude_dir(root)
    for rel in rels:
        if rel.name == "CLAUDE.md" and len(rel.parts) > 1:
            add_file(root / rel, "claude", "demand", "loaded when the folder is read")

    add_file(root / ".github" / "copilot-instructions.md", "copilot", "always")
    for p in sorted((root / ".github" / "instructions").glob("*.instructions.md")):
        fm = parse_frontmatter(read_any(p) or "")
        apply_to = fm.get("applyTo", "")
        always = apply_to in ("**", "**/*", "*")
        add_file(p, "copilot", "always" if always else "cond", "applyTo: " + (apply_to or "(manual)"))
    for p in sorted((root / ".github" / "prompts").glob("*.prompt.md")):
        add_file(p, "copilot", "demand", "prompt")
    add_file(root / "AGENTS.md", "other", "always", "read by Copilot; Claude Code only via @import")
    return items


def collect_mcp(root, home, use_home):
    found = []

    def load_json(p):
        text = read_any(p)
        if text is None:
            return {}
        try:
            return json.loads(text)
        except ValueError:
            try:
                return json.loads(re.sub(r"^\s*//.*$", "", text, flags=re.M))
            except ValueError:
                return {}

    for name in (load_json(root / ".mcp.json").get("mcpServers") or {}):
        found.append((name, ".mcp.json"))
    for name in (load_json(root / ".vscode" / "mcp.json").get("servers") or {}):
        found.append((name, ".vscode/mcp.json"))
    if use_home:
        data = load_json(home / ".claude.json")
        for name in (data.get("mcpServers") or {}):
            found.append((name, "~/.claude.json (user)"))
        proj = (data.get("projects") or {}).get(str(root)) or {}
        for name in (proj.get("mcpServers") or {}):
            found.append((name, "~/.claude.json (project)"))
    return found


INIT_LABELS = (("claude", "Claude Code"), ("copilot", "Copilot (VS Code)"), ("other", "Other"))


def init_totals(items):
    out = {}
    for tool, _ in INIT_LABELS:
        rows = [i for i in items if i["tool"] == tool]
        if rows:
            out[tool] = {"always": sum(r["always"] for r in rows), "cond": sum(r["cond"] for r in rows),
                         "demand": sum(r["demand"] for r in rows), "files": len(rows)}
    return out


def print_init(items, mcp, top):
    print("\nINIT COST (configurable part only, estimated)")
    print("  always = injected in every session | cond. = only if the file matches |")
    print("  on demand = loaded when used (full body of skills, agents, commands)")
    shown_any = False
    for tool, label in INIT_LABELS:
        rows = [i for i in items if i["tool"] == tool]
        if not rows:
            continue
        shown_any = True
        rows.sort(key=lambda i: (-(i["always"] + i["cond"]), -i["demand"], i["path"]))
        print(f"\n  [{label}]")
        print(f"  {'always':>9} {'cond.':>8} {'on demand':>9}  file")
        for r in rows[:top]:
            note = f"  ({r['note']})" if r["note"] else ""
            print(f"  {fmt(r['always']):>9} {fmt(r['cond']):>8} {fmt(r['demand']):>9}  {r['path']}{note}")
        rest = rows[top:]
        if rest:
            print(f"  {'':>9} {'':>8} {'':>9}  ... + {len(rest)} more "
                  f"({fmt(sum(r['always'] for r in rest))} always, "
                  f"{fmt(sum(r['demand'] for r in rest))} on demand)")
        a = sum(r["always"] for r in rows)
        c = sum(r["cond"] for r in rows)
        dm = sum(r["demand"] for r in rows)
        print(f"  TOTAL always: ~{fmt(a)} tokens ({a / 200_000 * 100:.1f}% of 200k | "
              f"{a / 1_000_000 * 100:.1f}% of 1M); cond. max ~{fmt(c)}; on demand ~{fmt(dm)}")
    if not shown_any:
        print("\n  No instruction file found.")
    if mcp:
        print("\n  Configured MCP servers (cost NOT estimable here: their tool definitions")
        print("  are only known once connected; see /context):")
        for name, src in mcp:
            print(f"    - {name}  [{src}]")
    print("\n  Not included: the agent's system prompt and built-in tools (fixed part), MCP tool")
    print("  definitions. For the real total: /context in Claude Code.")


# ----------------------------------------------------------------------------
# Command measurement
# ----------------------------------------------------------------------------
def measure_commands(cmds, root, est, timeout):
    print("\nCOMMAND MEASUREMENT (raw output = what an agent would see if it reads it)")
    print(f"{'tokens':>10} {'lines':>7} {'code':>5} {'time':>7}  command")
    results = []
    for cmd in cmds:
        t0 = time.time()
        try:
            p = subprocess.run(cmd, shell=True, cwd=str(root), capture_output=True, timeout=timeout)
            out = (p.stdout + p.stderr).decode("utf-8", "replace")
            code = str(p.returncode)
        except subprocess.TimeoutExpired as exc:
            out = ((exc.stdout or b"") + (exc.stderr or b"")).decode("utf-8", "replace")
            code = "T/O"
        dt = time.time() - t0
        tok = est.text(out)
        results.append((cmd, tok, code))
        print(f"{fmt(tok):>10} {fmt(out.count(chr(10))):>7} {code:>5} {dt:>6.1f}s  {cmd}")
    print("  (code != 0: a failure often produces much more output than a success; measure both.)")
    return results


# ----------------------------------------------------------------------------
# Big files, comments, diffs, edit-test loop
# ----------------------------------------------------------------------------
def print_big(records, total, threshold, top):
    print(f"\nFILES TOO BIG TO READ IN ONE GO (> {fmt(threshold)} tokens)")
    big = sorted((r for r in records if r["tokens"] > threshold), key=lambda r: -r["tokens"])
    rows = []
    for r in big:
        tags = []
        if r["rel"].name in LOCK_NAMES:
            tags.append("lockfile")
        if r["maxline"] > 1000:
            tags.append("minified?")
        rows.append({"path": r["rel"].as_posix(), "tokens": r["tokens"], "tags": tags})
    if not big:
        print("  None.")
        return rows
    bt = sum(r["tokens"] for r in big)
    print(f"  {len(big)} file(s) = ~{fmt(bt)} tokens ({bt / total * 100:.1f}% of total)")
    print(f"{'tokens':>10}  {'tags':<18}  file")
    for r in rows[:top]:
        print(f"{fmt(r['tokens']):>10}  {', '.join(r['tags']):<18}  {r['path']}")
    if len(big) > top:
        print(f"  ... + {len(big) - top} more")
    print("  Arbitrary threshold (--big-threshold): the real read limit depends on the tool.")
    print("  Lockfiles / minified / generated data: exclude them from agent reads (tool exclusion")
    print("  rules, .gitignore, or --ignore here).")
    return rows


def print_comments(records, est):
    agg = defaultdict(lambda: [0, 0])
    for r in records:
        if r["comment"] is None:
            continue
        agg[r["ext"]][0] += est.tokens(r["comment"], r["ext"])
        agg[r["ext"]][1] += r["tokens"]
    if not agg:
        return []
    print("\nSHARE OF COMMENTS / DOCSTRINGS (per language, top 8)")
    print(f"{'tokens':>10}  {'% of language':>13}  ext")
    rows = []
    for ext, (c, t) in sorted(agg.items(), key=lambda kv: -kv[1][0])[:8]:
        print(f"{fmt(c):>10}  {c / t * 100 if t else 0:>12.1f}%  {ext}")
        rows.append({"ext": ext, "comment_tokens": c, "language_tokens": t})
    print("  Heuristic (strings and nested comments are mishandled in edge cases). Share computed in")
    print("  characters then converted: prose usually tokenizes better than code, so the real share")
    print("  in tokens is probably a bit lower. Comments also carry useful information: this figure")
    print("  measures a cost, not waste.")
    return rows


def diff_files(out):
    return out.count("\ndiff --git ") + (1 if out.startswith("diff --git ") else 0)


def run_diff(root, est, ref, history):
    print("\nDIFF SIZE (what an agent or a reviewer has to read)")
    median = None
    if ref is not None:
        out = git_out(root, "diff", ref)
        if out is None:
            print(f"  git diff {ref}: failed (not a git repo, or invalid ref).")
        else:
            print(f"  git diff {ref}: ~{fmt(est.text(out))} tokens, {diff_files(out)} file(s)")
    if history:
        revs = (git_out(root, "log", "-n", str(history), "--no-merges", "--format=%H") or "").split()
        sizes = []
        for rev in revs:
            out = git_out(root, "show", "--format=", "--patch", "--no-color", rev)
            if out is not None:
                sizes.append((est.text(out), diff_files(out), rev[:8]))
        if not sizes:
            print("  Git history not found or empty.")
        else:
            toks = sorted(s[0] for s in sizes)
            median = statistics.median(toks)
            p90 = toks[min(len(toks) - 1, int(len(toks) * 0.9))]
            print(f"  last {len(sizes)} commits (no merges): median ~{fmt(round(median))}, "
                  f"mean ~{fmt(round(statistics.mean(toks)))}, p90 ~{fmt(p90)}, max ~{fmt(toks[-1])} tokens")
            print(f"  files per commit: median {statistics.median(s[1] for s in sizes):.0f}")
            print("  biggest: " + ", ".join(f"{h} ({fmt(t)})" for t, _, h in sorted(sizes, reverse=True)[:3]))
    return median


def print_loop(iters, diff_median, measures):
    cmd, test_tok, code = measures[0]
    per = round(diff_median) + test_tok
    print(f"\nEDIT-TEST LOOP (model, {iters} iterations)")
    print(f"  per iteration: median diff ~{fmt(round(diff_median))} + output of `{cmd}` "
          f"(code {code}) ~{fmt(test_tok)} = ~{fmt(per)} tokens")
    print(f"  {iters} iterations: ~{fmt(per * iters)} tokens")
    print("  Lower bound: counts neither file re-reads, nor model outputs, nor failures")
    print("  more verbose than the measured run (also measure a failing run).")


# ----------------------------------------------------------------------------
# Cost of locating a function
# ----------------------------------------------------------------------------
def indent_of(line):
    return len(line) - len(line.lstrip(" \t"))


def brace_range(lines, i, limit, ext=""):
    """Body of a brace-delimited definition starting on line i: (start, end_exclusive).

    Skips comments, strings and template literals (including nested `${ ... `x` ... }`);
    ignores braces inside the parameter list (destructuring, default values, object
    types) so the first `{` outside parentheses opens the body."""
    n = len(lines)
    quotes = '"' if ext == ".rs" else "'\""  # Rust lifetimes use a lone '
    depth = paren = 0
    started = block = False
    last = ""  # last significant character seen in code (tells a regex literal from a division)
    stack = []  # "tpl" = inside a template literal, int = inside a ${ } expression (open braces)
    j = i
    while j < n and j < i + limit:
        ln = lines[j]
        k, m = 0, len(ln)
        while k < m:
            c = ln[k]
            if block:
                e = ln.find("*/", k)
                if e == -1:
                    k = m
                else:
                    block, k = False, e + 2
                continue
            top = stack[-1] if stack else None
            if top == "tpl":
                if c == "\\":
                    k += 2
                    continue
                if c == "`":
                    stack.pop()
                elif c == "$" and ln[k + 1:k + 2] == "{":
                    stack.append(1)
                    k += 1
                k += 1
                continue
            if c == "/" and k + 1 < m and ln[k + 1] in "/*":
                if ln[k + 1] == "/":
                    break
                block, k = True, k + 2
                continue
            if c == "/" and top is None and (last == "" or last in "(,=:[!&|?{};>" or ln[:k].rstrip().endswith("return")):
                e, in_class = k + 1, False  # regex literal: skip it (it may hold quotes and braces)
                while e < m and (in_class or ln[e] != "/"):
                    if ln[e] == "\\":
                        e += 1
                    elif ln[e] == "[":
                        in_class = True
                    elif ln[e] == "]":
                        in_class = False
                    e += 1
                if e < m:
                    last, k = "x", e + 1
                    continue
            if c in quotes:
                k += 1
                while k < m and ln[k] != c:
                    k += 2 if ln[k] == "\\" else 1
                k += 1
                last = "x"
                continue
            if c == "`":
                stack.append("tpl")
            elif top is not None:  # inside ${ }: only track its own braces
                if c == "{":
                    stack[-1] += 1
                elif c == "}":
                    stack[-1] -= 1
                    if stack[-1] == 0:
                        stack.pop()
            elif c == "(":
                paren += 1
            elif c == ")":
                paren = max(0, paren - 1)
            elif c == "{" and (started or paren == 0):
                depth += 1
                started = True
            elif c == "}" and started:
                depth -= 1
            if not c.isspace():
                last = c
            k += 1
        if started and depth <= 0 and not stack:
            return i, j + 1
        # expression-bodied one-liner (no braces) or bodiless signature: ends at `;` / `,` outside parentheses
        if not started and paren == 0 and not stack and (j >= i + 6 or ln.rstrip().endswith((";", ","))):
            return i, i + 1
        j += 1
    return i, (min(n, j) if started else i + 1)


def body_range(lines, i, style, limit=400, ext=""):
    n = len(lines)
    if style == "indent":
        base, s = indent_of(lines[i]), i
        while s > 0 and lines[s - 1].lstrip().startswith("@") and indent_of(lines[s - 1]) == base:
            s -= 1
        j = i + 1
        while j < n:
            ln = lines[j]
            if ln.strip() and indent_of(ln) <= base and not ln.lstrip().startswith((")", "]", "}")):
                break
            j += 1
        while j > i + 1 and not lines[j - 1].strip():
            j -= 1
        return s, j
    if style == "end":
        base, j = indent_of(lines[i]), i + 1
        while j < n:
            if lines[j].strip() == "end" and indent_of(lines[j]) == base:
                return i, j + 1
            j += 1
        return i, min(n, i + 60)
    return brace_range(lines, i, limit, ext)


def compile_defs(custom):
    if custom:
        return None, [re.compile(custom, re.M)]
    return {e: [re.compile(p, re.M) for p in ps] for e, ps in DEF_REGEX.items()}, None


def norm_exts(items):
    return {e.lower() if e.startswith(".") else "." + e.lower() for e in items} if items else None


def find_defs(texts, def_map, custom_list, def_exts):
    seen, out = set(), []
    for rel, text in texts.items():
        ext = rel.suffix.lower()
        if def_exts and ext not in def_exts:
            continue
        rxs = custom_list or (def_map or {}).get(ext)
        if not rxs:
            continue
        starts = [0] + [m.end() for m in re.finditer(r"\n", text)]
        for rx in rxs:
            for m in rx.finditer(text):
                name = next((g for g in m.groups() if g), None)
                if not name:
                    continue
                idx = bisect.bisect_right(starts, m.start()) - 1
                key = (name, rel, idx)
                if key not in seen:
                    seen.add(key)
                    out.append(key)
    return out


class LookupModel:
    def __init__(self, texts, est):
        self.texts, self.est = texts, est
        self._lines = {}

    def lines(self, rel):
        if rel not in self._lines:
            self._lines[rel] = self.texts[rel].splitlines()
        return self._lines[rel]

    def grep_cost(self, name):
        word = re.compile(r"\b" + re.escape(name) + r"\b")
        out, files = [], 0
        for rel, text in self.texts.items():
            if name not in text:
                continue
            hit = False
            for n, line in enumerate(self.lines(rel), 1):
                if word.search(line):
                    out.append(f"{rel.as_posix()}:{n}:{line}")
                    hit = True
            files += hit
        return self.est.text("\n".join(out)), len(out), files

    def cost(self, name, defs):
        grep_t, grep_lines, grep_files = self.grep_cost(name)
        files = {}
        body_t = 0
        for _, rel, idx in defs:
            ext = rel.suffix.lower()
            files[rel] = ext
            lines = self.lines(rel)
            s, e = body_range(lines, idx, BODY_STYLE.get(ext, "brace"), ext=ext)
            body_t += self.est.text("\n".join(lines[s:e]), ext)
        read_t = sum(self.est.text(self.texts[r], e) for r, e in files.items())
        return {"grep": grep_t, "grep_lines": grep_lines, "grep_files": grep_files,
                "read": read_t, "body": body_t, "naive": grep_t + read_t,
                "ext": next(iter(files.values()), "")}


def run_find(names, sample_n, seed, texts, est, def_regex, def_exts):
    def_map, custom = compile_defs(def_regex)
    defs = find_defs(texts, def_map, custom, norm_exts(def_exts))
    model = LookupModel(texts, est)
    by_name = defaultdict(list)
    for d in defs:
        by_name[d[0]].append(d)
    result = {"definitions": len(defs), "distinct_names": len(by_name),
              "files_with_definitions": len({d[1] for d in defs}), "lookups": [], "sample": None}
    print(f"\nFUNCTION DETECTION: {fmt(len(defs))} definitions ({fmt(len(by_name))} distinct names) "
          f"in {fmt(result['files_with_definitions'])} files")

    for name in names:
        print(f"\nLOOKUP OF `{name}`")
        if name not in by_name:
            print("  No definition found (unsupported language? try --def-regex).")
            g, gl, gf = model.grep_cost(name)
            print(f"  grep only: {fmt(g)} tokens ({gl} lines in {gf} files)")
            result["lookups"].append({"name": name, "found": False, "grep": g})
            continue
        c = model.cost(name, by_name[name])
        where = ", ".join(f"{r.as_posix()}:{i + 1}" for _, r, i in by_name[name][:4])
        print(f"  definition(s): {len(by_name[name])} ({where})")
        print(f"  grep -rn    : {fmt(c['grep']):>9} tokens ({c['grep_lines']} lines, {c['grep_files']} files)")
        print(f"  file read   : {fmt(c['read']):>9} tokens  (ceiling: whole file(s))")
        print(f"  body only   : {fmt(c['body']):>9} tokens  (floor: just the function)")
        ratio = c["naive"] / c["body"] if c["body"] else 0
        print(f"  => naive ~{fmt(c['naive'])} vs targeted ~{fmt(c['body'])}  (x{ratio:.1f})")
        result["lookups"].append({"name": name, "found": True, "definitions": len(by_name[name]),
                                  **{k: c[k] for k in ("grep", "read", "body", "naive")}})

    if sample_n:
        names_all = sorted({d[0] for d in defs if len(d[0]) >= 3})
        if not names_all:
            print("\nSAMPLE: no definition found.")
            return result
        rnd = random.Random(seed)
        picked = rnd.sample(names_all, min(sample_n, len(names_all)))
        stats = []
        for name in picked:
            c = model.cost(name, by_name[name])
            c["name"] = name
            stats.append(c)

        def avg(key, rows):
            return statistics.mean(r[key] for r in rows) if rows else 0

        print(f"\nAVERAGE COST TO LOCATE A FUNCTION (sample of {len(stats)} out of {len(names_all)}, seed {seed})")
        print(f"{'':<14}{'grep':>9}{'read':>10}{'body':>9}{'naive':>9}")
        print(f"{'mean':<14}{fmt(round(avg('grep', stats))):>9}{fmt(round(avg('read', stats))):>10}"
              f"{fmt(round(avg('body', stats))):>9}{fmt(round(avg('naive', stats))):>9}")
        print(f"{'median':<14}{fmt(round(statistics.median(r['grep'] for r in stats))):>9}"
              f"{fmt(round(statistics.median(r['read'] for r in stats))):>10}"
              f"{fmt(round(statistics.median(r['body'] for r in stats))):>9}"
              f"{fmt(round(statistics.median(r['naive'] for r in stats))):>9}")
        tot_body = sum(r["body"] for r in stats)
        factor = sum(r["naive"] for r in stats) / tot_body if tot_body else 0
        if tot_body:
            print(f"  => on average the naive path costs ~{factor:.1f}x the function body")
        by_ext = defaultdict(list)
        for r in stats:
            by_ext[r["ext"]].append(r)
        print("\n  per language (extension):")
        print(f"  {'ext':<8}{'n':>4}{'naive avg':>11}{'body avg':>12}")
        for ext, rows in sorted(by_ext.items(), key=lambda kv: -avg("naive", kv[1])):
            print(f"  {ext:<8}{len(rows):>4}{fmt(round(avg('naive', rows))):>11}{fmt(round(avg('body', rows))):>12}")
        print("\n  Top 5 most expensive:")
        for r in sorted(stats, key=lambda r: -r["naive"])[:5]:
            print(f"    {fmt(r['naive']):>8} tokens  {r['name']}  (grep {fmt(r['grep'])}, file {fmt(r['read'])})")
        result["sample"] = {"size": len(stats), "population": len(names_all), "seed": seed,
                            "mean": {k: round(avg(k, stats)) for k in ("grep", "read", "body", "naive")},
                            "naive_over_body": round(factor, 1)}
    print("\n  Simplified model: \"naive\" = one grep -rn + a whole-file read of the defining file;")
    print("  a real agent often reads in chunks (between floor and ceiling) and may chain")
    print("  several searches. An order of magnitude, not a measurement of Claude.")
    return result


# ----------------------------------------------------------------------------
# Long functions
# ----------------------------------------------------------------------------
def func_table(texts, def_map, custom, def_exts, only=None):
    """{(rel, name): [(body_lines, line_number), ...]} sorted longest first."""
    sub = texts if only is None else {r: texts[r] for r in only if r in texts}
    out, cache = defaultdict(list), {}
    for name, rel, idx in find_defs(sub, def_map, custom, def_exts):
        lines = cache.get(rel)
        if lines is None:
            lines = cache[rel] = sub[rel].splitlines()
        ext = rel.suffix.lower()
        s, e = body_range(lines, idx, BODY_STYLE.get(ext, "brace"), LONG_LIMIT, ext)
        out[(rel, name)].append((e - s, idx + 1))
    for v in out.values():
        v.sort(reverse=True)
    return out


def long_functions(texts, thr, def_regex, def_exts, old_texts=None, renames=None):
    """Functions with a body longer than thr lines; with old_texts only the new or grown ones."""
    def_map, custom = compile_defs(def_regex)
    exts = norm_exts(def_exts)
    after = func_table(texts, def_map, custom, exts)
    big = [k for k, v in after.items() if v[0][0] > thr]
    rows = []
    before = {}
    if old_texts is not None:
        renames = renames or {}
        before = func_table(old_texts, def_map, custom, exts, {renames.get(k[0], k[0]) for k in big})
    for rel, name in big:
        prev = [l for l, _ in before.get((renames.get(rel, rel) if renames else rel, name), [])]
        for i, (length, line) in enumerate(after[(rel, name)]):
            if length <= thr:
                break
            if old_texts is None:
                status = ""
            elif i >= len(prev):
                status = "new"
            elif length > prev[i]:
                status = f"grew {prev[i]} -> {length}"
            else:
                continue
            rows.append({"file": rel.as_posix(), "line": line, "name": name, "lines": length, "status": status})
    rows.sort(key=lambda r: (-r["lines"], r["file"], r["line"]))
    return rows


def print_long(rows, thr, ref, top):
    scope = f", new or grown vs {ref}" if ref else ""
    print(f"\nLONG FUNCTIONS (body > {thr} lines{scope})")
    if not rows:
        print("  None.")
        return
    print(f"  {len(rows)} found" + (f", top {top}" if len(rows) > top else ""))
    print(f"{'lines':>7}  {'status':<16}  location")
    for r in rows[:top]:
        print(f"{r['lines']:>7}  {r['status']:<16}  {r['file']}:{r['line']}  {r['name']}")
    if len(rows) > top:
        print(f"  ... + {len(rows) - top} more")


# ----------------------------------------------------------------------------
# Comparison with a git ref
# ----------------------------------------------------------------------------
def agg_dirs(records, depth):
    dirs = defaultdict(int)
    for r in records:
        parts = r["rel"].parts[:-1]
        if not parts:
            dirs["./ (root)"] += r["tokens"]
        for i in range(1, min(len(parts), depth) + 1):
            dirs["/".join(parts[:i]) + "/"] += r["tokens"]
    return dirs


def agg_ext(records):
    by_ext = defaultdict(lambda: [0, 0, 0])
    for r in records:
        s = by_ext[r["ext"]]
        s[0] += 1
        s[1] += r["lines"]
        s[2] += r["tokens"]
    return by_ext


def git_renames(root, ref):
    """{new_path: old_path} for files renamed between REF and the working tree."""
    out = git_out(root, "diff", "--name-status", "-M", "-z", "--relative", ref)
    ren, toks, i = {}, (out or "").split("\0"), 0
    while i < len(toks) and toks[i]:
        if toks[i][0] in "RC" and i + 2 < len(toks):
            if toks[i][0] == "R":
                ren[Path(toks[i + 2])] = Path(toks[i + 1])
            i += 3
        else:
            i += 2
    return ren


def compare_init(root, home, est, ref, cur_rels, ref_rels, ref_names, ignore):
    """Init cost (CLAUDE.md, .claude/**, Copilot files, AGENTS.md; no home config) before / after."""
    after = collect_init(root, home, est, cur_rels, False, False, walk_parents=False)
    md = [n for n in ref_names if n.lower().endswith(".md") and not any(p in ignore for p in n.split("/")[:-1])]
    with tempfile.TemporaryDirectory(prefix="tokscan_") as tmp:
        tmp = Path(tmp).resolve()
        for n, data in read_blobs(root, ref, md).items():
            dest = tmp / n
            try:
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)
            except OSError:
                pass
        before = collect_init(tmp, home, est, ref_rels, False, False, walk_parents=False)

    def key(i):
        return (i["path"], i["tool"])
    b = {key(i): i for i in before}
    a = {key(i): i for i in after}
    changes = []
    for k in set(a) | set(b):
        ia, ib = a.get(k), b.get(k)
        va = (ia["always"], ia["cond"], ia["demand"]) if ia else (0, 0, 0)
        vb = (ib["always"], ib["cond"], ib["demand"]) if ib else (0, 0, 0)
        if va != vb:
            changes.append({"path": k[0], "tool": k[1], "before": list(vb), "after": list(va),
                            "delta_always": va[0] - vb[0], "delta_demand": va[2] - vb[2]})
    changes.sort(key=lambda c: (-abs(c["delta_always"]), -abs(c["delta_demand"]), c["path"]))

    def tot(items, field):
        return sum(i[field] for i in items)
    return {"before": {f: tot(before, f) for f in ("always", "cond", "demand")},
            "after": {f: tot(after, f) for f in ("always", "cond", "demand")},
            "changes": changes}


def build_compare(ref, cur, old, depth, threshold, renames):
    cur_tok = {r["rel"]: r["tokens"] for r in cur}
    old_tok = {r["rel"]: r["tokens"] for r in old}
    consumed = {o for n, o in renames.items() if n in cur_tok and o in old_tok}
    tb, ta = sum(old_tok.values()), sum(cur_tok.values())
    dir_b, dir_a = agg_dirs(old, depth), agg_dirs(cur, depth)
    folders = [{"path": k, "before": dir_b.get(k, 0), "after": dir_a.get(k, 0),
                "delta": dir_a.get(k, 0) - dir_b.get(k, 0)} for k in set(dir_a) | set(dir_b)]
    folders = sorted((f for f in folders if f["delta"]), key=lambda f: (-abs(f["delta"]), f["path"]))
    ext_b, ext_a = agg_ext(old), agg_ext(cur)
    exts = [{"ext": e, "before": ext_b[e][2] if e in ext_b else 0, "after": ext_a[e][2] if e in ext_a else 0}
            for e in set(ext_a) | set(ext_b)]
    for e in exts:
        e["delta"] = e["after"] - e["before"]
    exts = sorted((e for e in exts if e["delta"]), key=lambda e: -abs(e["delta"]))
    files, added, removed, crossed = [], 0, 0, []
    for rel, t in cur_tok.items():
        prev = renames.get(rel) if renames.get(rel) in old_tok else rel
        before = old_tok.get(prev)
        if before is None:
            added += 1
        if t != (before or 0):
            files.append({"path": rel.as_posix(), "before": before or 0, "after": t, "delta": t - (before or 0),
                          "status": "new" if before is None else ("renamed" if prev != rel else "modified")})
        if t > threshold and (before or 0) <= threshold:
            crossed.append({"path": rel.as_posix(), "before": before or 0, "after": t, "new_file": before is None})
    for rel, t in old_tok.items():
        if rel not in cur_tok and rel not in consumed:
            removed += 1
            files.append({"path": rel.as_posix(), "before": t, "after": 0, "delta": -t, "status": "removed"})
    files.sort(key=lambda f: (-abs(f["delta"]), f["path"]))
    crossed.sort(key=lambda f: -f["after"])
    return {"ref": ref, "before": {"files": len(old_tok), "tokens": tb}, "after": {"files": len(cur_tok), "tokens": ta},
            "delta": ta - tb, "delta_pct": round(pct_of(ta - tb, tb), 2),
            "files_added": added, "files_removed": removed, "files_changed": len(files),
            "folders": folders, "extensions": exts, "top_files": files, "crossed_big": crossed,
            "threshold": threshold, "init": None}


def print_compare(c, depth):
    print(f"\nCOMPARISON WITH {c['ref']}")
    print(f"  total : {fmt(c['before']['tokens'])} -> {fmt(c['after']['tokens'])} tokens "
          f"({sfmt(c['delta'])}, {c['delta_pct']:+.2f}%)")
    print(f"  files : {fmt(c['before']['files'])} -> {fmt(c['after']['files'])} "
          f"(+{c['files_added']} added, -{c['files_removed']} removed, {c['files_changed']} changed)")
    print(f"\n  BY FOLDER (top 10 by absolute delta, depth {depth})")
    print(f"  {'before':>10} {'after':>10} {'delta':>10}  folder")
    for f in c["folders"][:10]:
        print(f"  {fmt(f['before']):>10} {fmt(f['after']):>10} {sfmt(f['delta']):>10}  {f['path']}")
    if not c["folders"]:
        print("  (no change)")
    print("\n  BY FILE (top 10 by absolute delta)")
    print(f"  {'before':>10} {'after':>10} {'delta':>10}  file")
    for f in c["top_files"][:10]:
        print(f"  {fmt(f['before']):>10} {fmt(f['after']):>10} {sfmt(f['delta']):>10}  {f['path']} [{f['status']}]")
    print(f"\n  FILES NEWLY ABOVE --big-threshold ({fmt(c['threshold'])} tokens)")
    if not c["crossed_big"]:
        print("  None.")
    for f in c["crossed_big"][:10]:
        print(f"  {fmt(f['before']):>10} -> {fmt(f['after']):>9}  {f['path']}" + ("  (new file)" if f["new_file"] else ""))
    i = c.get("init")
    if i:
        print("\n  INIT COST (CLAUDE.md, .claude/**, Copilot, AGENTS.md; user config excluded)")
        for f, label in (("always", "always"), ("cond", "cond."), ("demand", "on demand")):
            print(f"  {label:>10}: {fmt(i['before'][f])} -> {fmt(i['after'][f])} ({sfmt(i['after'][f] - i['before'][f])})")
        for ch in i["changes"][:10]:
            print(f"  {sfmt(ch['delta_always']):>10} always, {sfmt(ch['delta_demand'])} on demand  {ch['path']}")


# ----------------------------------------------------------------------------
# Markdown report (PR comment)
# ----------------------------------------------------------------------------
def build_markdown(rep, args):
    L = ["<!-- tokscan -->", "### tokscan report", ""]
    t, c = rep["totals"], rep.get("comparison")
    if c:
        L.append(f"**{fmt(c['after']['tokens'])} tokens** vs `{c['ref']}`: {sfmt(c['delta'])} "
                 f"({c['delta_pct']:+.2f}%), was {fmt(c['before']['tokens'])}. "
                 f"Files: {c['files_added']} added, {c['files_removed']} removed, {c['files_changed']} changed.")
    else:
        L.append(f"**{fmt(t['tokens'])} tokens** in {fmt(t['files'])} files (estimate, {t['ratio']} chars/token).")
    L.append("")
    if c:
        if c["folders"]:
            L += ["| Folder | Before | After | Delta |", "|---|--:|--:|--:|"]
            L += [f"| `{f['path']}` | {fmt(f['before'])} | {fmt(f['after'])} | {sfmt(f['delta'])} |"
                  for f in c["folders"][:5]]
            L.append("")
        if c["top_files"]:
            L += ["<details><summary>Top file changes</summary>", ""]
            L += [f"- `{f['path']}` {sfmt(f['delta'])} ({f['status']})" for f in c["top_files"][:8]]
            L += ["", "</details>", ""]
        i = c.get("init")
        if i and (i["changes"] or i["before"] != i["after"]):
            a, b = i["after"], i["before"]
            L.append(f"**Init cost** (always loaded): {fmt(b['always'])} -> {fmt(a['always'])} "
                     f"({sfmt(a['always'] - b['always'])}); on demand {fmt(b['demand'])} -> {fmt(a['demand'])}")
            L.append("")
    else:
        L += ["| Folder | Tokens |", "|---|--:|"]
        L += [f"| `{f['path']}` | {fmt(f['tokens'])} |" for f in rep["folders"][:6]]
        L.append("")
    warn = rep["warnings"]
    if warn:
        L.append("**Warnings**")
        L += [f"- {w}" for w in warn[:6]]
        L.append("")
    lf = rep.get("long_functions")
    if lf:
        scope = "new or grown" if c else "all"
        L += [f"<details><summary>Long functions ({len(lf)}, {scope}, > {rep['long_threshold']} lines)</summary>", ""]
        L += [f"- `{r['file']}:{r['line']}` `{r['name']}` {r['lines']} lines" + (f" ({r['status']})" if r["status"] else "")
              for r in lf[:10]]
        if len(lf) > 10:
            L.append(f"- ... + {len(lf) - 10} more")
        L += ["", "</details>", ""]
    if not warn and not (c and c["folders"]):
        L.append("No notable change.")
    while L and not L[-1]:
        L.pop()
    if len(L) > 60:
        L = L[:59] + ["_(truncated)_"]
    return "\n".join(L) + "\n"


# ----------------------------------------------------------------------------
# Calibration through the Anthropic API
# ----------------------------------------------------------------------------
def count_api(text, model, key, base_url):
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": text}]}).encode()
    req = urllib.request.Request(
        base_url.rstrip("/") + "/v1/messages/count_tokens", data=body,
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)["input_tokens"]


def calibrate(records, texts, est, model, top_k=6, per_ext=3):
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        print("--calibrate: ANTHROPIC_API_KEY is not set, calibration skipped.")
        return {}
    base_url = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
    chars_by_ext = defaultdict(int)
    for r in records:
        chars_by_ext[r["ext"]] += r["chars"]
    exts = [e for e, _ in sorted(chars_by_ext.items(), key=lambda kv: -kv[1]) if e != NO_EXT][:top_k]
    ratios, rows = {}, []
    try:
        baseline = count_api("a", model, key, base_url)
        for e in exts:
            cands = sorted(((rel, t) for rel, t in texts.items()
                            if rel.suffix.lower() == e and 800 <= len(t) <= 60000),
                           key=lambda x: len(x[1]))
            if not cands:
                continue
            start = max(0, len(cands) // 2 - per_ext // 2)
            pick = cands[start:start + per_ext]
            chars = tok = 0
            for _, t in pick:
                t = t[:20000]
                chars += len(t)
                tok += max(1, count_api(t, model, key, base_url) - baseline + 1)
            ratios[e] = chars / tok
            rows.append((e, len(pick), chars / tok))
    except (urllib.error.URLError, ValueError, KeyError) as exc:
        print(f"--calibrate: API call failed ({exc}), calibration skipped.")
        return {}
    print(f"\nRATIOS MEASURED via count_tokens (model {model}): characters per token")
    print(f"  {'ext':<8}{'files':>9}{'chars/token':>13}{'vs default':>12}")
    for e, n, r in rows:
        print(f"  {e:<8}{n:>9}{r:>13.2f}{(r / est.default - 1) * 100:>+11.0f}%")
    print("  (the lower the ratio, the more tokens per character the language costs;")
    print("   extensions not listed: default ratio)")
    return ratios


# ----------------------------------------------------------------------------
def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    try:  # output closed by `| head`: exit without traceback (absent on Windows)
        import signal
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    except (AttributeError, ValueError, ImportError):
        pass

    ap = argparse.ArgumentParser(description="Estimate the tokens of a repo and the session cost of an agent.")
    ap.add_argument("path", nargs="?", default=".", help="folder to analyse (default: .)")
    ap.add_argument("--ratio", type=float, default=3.5, help="default characters per token (3.5)")
    ap.add_argument("--depth", type=int, default=2, help="folder aggregation depth (2)")
    ap.add_argument("--files", type=int, default=20, help="files shown, 0 = all (20)")
    ap.add_argument("--ext", nargs="*", default=None, help="keep only these extensions, e.g. .py .md")
    ap.add_argument("--ignore", nargs="*", default=[], help="extra folder names to ignore")
    ap.add_argument("--no-git", action="store_true", help="do not use git ls-files")
    ap.add_argument("--max-size-mb", type=float, default=10, help="skip bigger files (10 MB)")
    ap.add_argument("--no-init", action="store_true", help="do not show the init cost")
    ap.add_argument("--init-top", type=int, default=15, help="rows shown per tool in the init cost (15)")
    ap.add_argument("--home", default=None, help="user folder to inspect (default: ~)")
    ap.add_argument("--no-home", action="store_true", help="ignore the user config (~/.claude...), e.g. in CI")
    ap.add_argument("--plugins", action="store_true", help="include Claude Code plugin skills/agents")
    ap.add_argument("--measure", action="append", default=[], metavar="CMD",
                    help="measure the tokens of a command's output (repeatable). WARNING: run as is")
    ap.add_argument("--timeout", type=int, default=300, help="timeout per measured command in s (300)")
    ap.add_argument("--big-threshold", type=int, default=10000, help="size (tokens) above which a file is too big (10000)")
    ap.add_argument("--big-top", type=int, default=10, help="too-big files shown (10)")
    ap.add_argument("--diff", nargs="?", const="HEAD", default=None, metavar="REF",
                    help="tokens of `git diff REF` (HEAD by default = ongoing changes); write --diff=REF if ambiguous")
    ap.add_argument("--diff-history", type=int, default=0, metavar="N", help="typical diff size over the last N commits")
    ap.add_argument("--loop", type=int, default=3, help="iterations of the edit-test loop model (3)")
    ap.add_argument("--find", action="append", default=[], metavar="NAME", help="cost to locate this function (repeatable)")
    ap.add_argument("--find-sample", type=int, default=0, metavar="N", help="average cost over N random functions")
    ap.add_argument("--seed", type=int, default=0, help="sampling seed (0)")
    ap.add_argument("--def-regex", default=None, help="custom definition regex (group 1 = name)")
    ap.add_argument("--def-ext", nargs="*", default=None, help="restrict function detection to these extensions")
    ap.add_argument("--calibrate", action="store_true", help="measure the real ratio via the count_tokens API (ANTHROPIC_API_KEY)")
    ap.add_argument("--model", default="claude-sonnet-5-5", help="model for --calibrate")
    ap.add_argument("--compare", default=None, metavar="REF",
                    help="compare the working tree with git ref REF (tokens, folders, big files, init cost)")
    ap.add_argument("--long-functions", type=int, default=None, metavar="N",
                    help="list functions/methods whose body is longer than N lines (only new/grown ones with --compare)")
    ap.add_argument("--long-top", type=int, default=20, help="long functions shown (20)")
    ap.add_argument("--fail-over", type=float, default=None, metavar="PCT",
                    help="with --compare: exit 1 if total tokens grew by more than PCT percent")
    ap.add_argument("--fail-long", type=int, default=None, metavar="N",
                    help="with --compare: exit 1 if a new/grown function body exceeds N lines")
    ap.add_argument("--json", dest="json_out", default=None, metavar="PATH", help="write a machine-readable summary to PATH")
    ap.add_argument("--markdown", dest="md_out", default=None, metavar="PATH", help="write a compact Markdown report (PR comment) to PATH")
    args = ap.parse_args()

    if (args.fail_over is not None or args.fail_long is not None) and not args.compare:
        ap.error("--fail-over and --fail-long require --compare")

    root = Path(args.path).resolve()
    if not root.is_dir():
        sys.exit(f"Folder not found: {root}")
    home = Path(args.home).resolve() if args.home else Path.home()
    ignore = DEFAULT_IGNORE | set(args.ignore)
    max_bytes = int(args.max_size_mb * 1024 * 1024)
    est = Estimator(args.ratio)
    if args.compare and git_out(root, "rev-parse", "--verify", "--quiet", args.compare + "^{commit}") is None:
        sys.exit(f"Unknown git ref (or not a git repo): {args.compare}")

    files, mode = None, "disk walk"
    if not args.no_git:
        files = list_git(root)
        if files is not None:
            mode = "git (respects .gitignore)"
    if files is None:
        files = list_walk(root, ignore)

    exts = norm_exts(args.ext)
    long_thr = min(x for x in (args.long_functions, args.fail_long) if x is not None) \
        if (args.long_functions is not None or args.fail_long is not None) else None
    need_texts = bool(args.find or args.find_sample or args.calibrate or long_thr is not None)

    records, texts, skipped = scan_current(root, files, ignore, exts, max_bytes, need_texts)

    if args.calibrate:
        est.ratios = calibrate(records, texts, est, args.model)
    for r in records:
        r["tokens"] = est.tokens(r["chars"], r["ext"])
    total = sum(r["tokens"] for r in records)

    rep = {"root": str(root), "source": mode, "ratio": args.ratio, "calibrated": dict(est.ratios),
           "totals": {"files": len(records), "skipped": skipped, "tokens": total,
                      "lines": sum(r["lines"] for r in records), "ratio": args.ratio},
           "warnings": []}
    warnings = rep["warnings"]

    print(f"Folder    : {root}")
    print(f"Source    : {mode}")
    print(f"Files     : {fmt(len(records))} analysed, {fmt(skipped)} skipped (binary / too big)")
    cal = " + measured per-extension ratios" if est.ratios else ""
    print(f"TOTAL     : ~{fmt(total)} tokens  (ratio {args.ratio} chars/token{cal}, margin ~25 %)")
    print(f"          = {total / 200_000:.1f}x a 200k window | {total / 1_000_000:.1f}x a 1M window")

    if not args.no_init:
        items = collect_init(root, home, est, [r["rel"] for r in records], not args.no_home, args.plugins)
        mcp = collect_mcp(root, home, not args.no_home)
        print_init(items, mcp, args.init_top)
        rep["init"] = {"items": items, "totals": init_totals(items), "mcp": [{"name": n, "source": s} for n, s in mcp]}

    dirs = agg_dirs(records, args.depth)
    by_ext = agg_ext(records)

    def table(title, rows):
        print(f"\n{title}")
        print(f"{'tokens':>10}  {'%':>6}  {'':<20}  name")
        for t, name in rows:
            pct = 100 * t / total if total else 0
            print(f"{fmt(t):>10}  {pct:5.1f}%  {bar(t, total):<20}  {name}")

    folder_rows = sorted(((t, d) for d, t in dirs.items()), reverse=True)
    table(f"BY FOLDER (cumulative, depth {args.depth})", folder_rows)
    rep["folders"] = [{"path": d, "tokens": t} for t, d in folder_rows]

    print("\nBY EXTENSION / LANGUAGE (top 8) - density = tokens per line")
    print(f"{'tokens':>10}  {'%':>6}  {'files':>8}  {'lines':>8}  {'tok/line':>9}  ext")
    rep["extensions"] = []
    for ext, (n, ln, t) in sorted(by_ext.items(), key=lambda kv: -kv[1][2]):
        rep["extensions"].append({"ext": ext, "files": n, "lines": ln, "tokens": t,
                                  "tokens_per_line": round(t / ln, 2) if ln else 0})
    for e in rep["extensions"][:8]:
        pct = 100 * e["tokens"] / total if total else 0
        print(f"{fmt(e['tokens']):>10}  {pct:5.1f}%  {fmt(e['files']):>8}  {fmt(e['lines']):>8}  {e['tokens_per_line']:>9.1f}  {e['ext']}")

    file_rows = sorted(((r["tokens"], r["rel"].as_posix()) for r in records), reverse=True)
    shown = file_rows if args.files == 0 else file_rows[: args.files]
    table(f"BY FILE ({'all' if args.files == 0 else 'top ' + str(args.files)})", shown)
    rep["top_files"] = [{"path": p, "tokens": t} for t, p in file_rows[:50]]

    rep["comments"] = print_comments(records, est)
    rep["big_files"] = print_big(records, total, args.big_threshold, args.big_top)

    measures = measure_commands(args.measure, root, est, args.timeout) if args.measure else []
    rep["measures"] = [{"command": c, "tokens": t, "exit_code": code} for c, t, code in measures]
    diff_median = None
    if args.diff is not None or args.diff_history:
        diff_median = run_diff(root, est, args.diff, args.diff_history)
        rep["diff_median_tokens"] = diff_median
    if measures and diff_median is not None:
        print_loop(args.loop, diff_median, measures)
    rep["find"] = None
    if args.find or args.find_sample:
        rep["find"] = run_find(args.find, args.find_sample, args.seed, texts, est, args.def_regex, args.def_ext)

    # ---- comparison with a git ref -------------------------------------------------
    cmp_res, old_texts, renames = None, None, {}
    if args.compare:
        old_recs, old_texts, _, ref_names = scan_ref(root, args.compare, ignore, exts, max_bytes, long_thr is not None)
        for r in old_recs:
            r["tokens"] = est.tokens(r["chars"], r["ext"])
        renames = git_renames(root, args.compare)
        cmp_res = build_compare(args.compare, records, old_recs, args.depth, args.big_threshold, renames)
        if not args.no_init:
            cmp_res["init"] = compare_init(root, home, est, args.compare, [r["rel"] for r in records],
                                           [r["rel"] for r in old_recs], ref_names, ignore)
        print_compare(cmp_res, args.depth)
    rep["comparison"] = cmp_res

    # ---- long functions ------------------------------------------------------------
    lf_rows, show_thr = [], args.long_functions if args.long_functions is not None else args.fail_long
    if long_thr is not None:
        lf_rows = long_functions(texts, long_thr, args.def_regex, args.def_ext, old_texts if args.compare else None, renames)
        shown_rows = [r for r in lf_rows if r["lines"] > show_thr]
        print_long(shown_rows, show_thr, args.compare, args.long_top)
        rep["long_functions"] = shown_rows
        rep["long_threshold"] = show_thr
    else:
        shown_rows = []

    # ---- gates and warnings --------------------------------------------------------
    failures = []
    if cmp_res:
        if args.fail_over is not None and cmp_res["delta_pct"] > args.fail_over:
            failures.append(f"total tokens grew {cmp_res['delta_pct']:+.2f}% (limit {args.fail_over:g}%)")
        if cmp_res["crossed_big"]:
            warnings.append(f"{len(cmp_res['crossed_big'])} file(s) newly above {fmt(args.big_threshold)} tokens: "
                            + ", ".join(f"`{f['path']}`" for f in cmp_res["crossed_big"][:3]))
        init = cmp_res.get("init")
        if init and init["after"]["always"] > init["before"]["always"]:
            warnings.append(f"always-loaded init cost grew by {fmt(init['after']['always'] - init['before']['always'])} tokens")
    if args.fail_long is not None:
        over = [r for r in lf_rows if r["lines"] > args.fail_long]
        if over:
            failures.append(f"{len(over)} new/grown function(s) longer than {args.fail_long} lines "
                            f"(longest: {over[0]['file']}:{over[0]['line']} {over[0]['name']}, {over[0]['lines']} lines)")
    if shown_rows:
        warnings.append(f"{len(shown_rows)} {'new/grown ' if args.compare else ''}function(s) longer than {show_thr} lines")
    warnings[:0] = [f"FAIL: {f}" for f in failures]
    rep["failures"] = failures

    if failures:
        print("\nFAILED:")
        for f in failures:
            print(f"  - {f}")

    if args.json_out:
        data = json.loads(json.dumps(rep, default=str))
        Path(args.json_out).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"\nJSON written: {args.json_out}")
    if args.md_out:
        Path(args.md_out).write_text(build_markdown(rep, args), encoding="utf-8")
        print(f"Markdown written: {args.md_out}")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
