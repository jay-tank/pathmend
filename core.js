"use strict";
/**
 * PathMend core: config file parsers, path evaluation, "did you mean" suggestions and
 * rename planning. No VS Code dependency.
 *
 * Every file system question goes through the guard returned by createGuard(). The guard
 * only touches paths that are inside a workspace folder, and walks symlinks itself so that a
 * link pointing outside the workspace is detected before anything behind it is touched.
 * The contents of referenced files are never read - only existence and type.
 */

const path = require("path");

const RULES = {
  PM001: "package.json path not found",
  PM002: "tsconfig / jsconfig path not found",
  PM003: "Dockerfile COPY / ADD source not found",
  PM004: "Compose build context / dockerfile not found",
  PM005: "GitHub Actions path not found",
  PM006: "CODEOWNERS path not found",
  PM007: "launch.json path not found",
  PM008: "GitLab CI local include not found",
  PM009: "Glob matches no files",
  PM010: "Path outside the workspace - not checked",
  PM011: "COPY / ADD source outside the Docker build context",
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function within(p, base) {
  const rel = path.relative(base, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

function isUrl(v) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^git@/.test(v) || /^(docker|data|npm|workspace|link|file):/i.test(v);
}

const GLOB_CHARS = /[*?[\]{}]/;

function isGlob(v) {
  return GLOB_CHARS.test(v);
}

function hasControl(v) {
  return /[\u0000-\u001f\u007f]/.test(v);
}

function globToRegex(glob, anyStar) {
  let re = "";
  let i = 0;
  let brace = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 2;
        if (glob[i] === "/") {
          re += "(?:.*/)?";
          i++;
        } else re += ".*";
        continue;
      }
      re += anyStar ? ".*" : "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (c === "[") {
      const j = glob.indexOf("]", i + 1);
      if (j > i + 1) {
        let cls = glob.slice(i + 1, j).replace(/\\/g, "\\\\");
        if (cls[0] === "!") cls = "^" + cls.slice(1);
        re += "[" + cls + "]";
        i = j + 1;
        continue;
      }
      re += "\\[";
      i++;
      continue;
    }
    if (c === "{") {
      brace++;
      re += "(?:";
      i++;
      continue;
    }
    if (c === "}" && brace > 0) {
      brace--;
      re += ")";
      i++;
      continue;
    }
    if (c === "," && brace > 0) {
      re += "|";
      i++;
      continue;
    }
    re += c.replace(/[.+^$()|\\/{}\]]/g, "\\$&");
    i++;
  }
  while (brace-- > 0) re += ")";
  try {
    return new RegExp("^" + re + "$");
  } catch (_) {
    return null;
  }
}

function makeMatcher(patterns) {
  const res = (patterns || [])
    .filter((p) => typeof p === "string" && p.trim())
    .map((p) => globToRegex(p.trim().replace(/^\.\//, "")))
    .filter(Boolean);
  return (rel) => res.some((r) => r.test(rel) || r.test(rel + "/"));
}

/** Optimal string alignment distance (Levenshtein plus adjacent transposition). */
function osa(a, b, max) {
  const n = a.length;
  const m = b.length;
  if (max === undefined) max = Infinity;
  if (Math.abs(n - m) > max) return max + 1;
  let prev2 = null;
  let prev = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1);
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[m];
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) starts.push(i + 1);
    else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

function posOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, col: offset - starts[lo] };
}

function splitLines(text) {
  return text.split(/\r\n|\n|\r/);
}

// ---------------------------------------------------------------------------
// Workspace guard: the only code that touches the file system
// ---------------------------------------------------------------------------

const OUTSIDE = Object.freeze({ state: "outside" });
const MISSING = Object.freeze({ state: "missing" });

/**
 * createGuard(fsMod, rootPaths) - existence checks confined to the workspace folders.
 * - A path that is not lexically inside a root is never passed to fs.
 * - Each component is lstat'ed from the (real) root downwards. A symlink is resolved by
 *   reading the link itself; if its target is outside every root the walk stops before the
 *   target is touched.
 */
function createGuard(fsMod, rootPaths) {
  const roots = rootPaths.map((r) => path.resolve(r));
  const real = roots.map((r) => {
    try {
      return path.resolve(fsMod.realpathSync(r));
    } catch (_) {
      return r;
    }
  });
  const cache = new Map();
  const insideReal = (p) => real.some((r) => within(p, r));
  const rootIndex = (p) => {
    let i = roots.findIndex((r) => within(p, r));
    if (i >= 0) return { i, rel: path.relative(roots[i], p) };
    i = real.findIndex((r) => within(p, r));
    if (i >= 0) return { i, rel: path.relative(real[i], p) };
    return null;
  };

  function walk(abs) {
    const ri = rootIndex(abs);
    if (!ri) return OUTSIDE;
    const queue = ri.rel ? ri.rel.split(path.sep).filter(Boolean) : [];
    let cur = real[ri.i];
    let st = null;
    let hops = 0;
    while (queue.length) {
      const part = queue.shift();
      if (part === ".") continue;
      if (part === "..") {
        cur = path.dirname(cur);
        st = null;
        if (!insideReal(cur)) return OUTSIDE;
        continue;
      }
      const next = path.join(cur, part);
      if (!insideReal(next)) return OUTSIDE;
      try {
        st = fsMod.lstatSync(next);
      } catch (_) {
        return MISSING;
      }
      if (st.isSymbolicLink()) {
        if (++hops > 32) return MISSING;
        let target;
        try {
          target = fsMod.readlinkSync(next);
        } catch (_) {
          return MISSING;
        }
        const t = path.resolve(cur, target);
        const j = real.findIndex((r) => within(t, r));
        if (j < 0) return OUTSIDE;
        const relT = path.relative(real[j], t);
        cur = real[j];
        st = null;
        queue.unshift(...(relT ? relT.split(path.sep).filter(Boolean) : []));
        continue;
      }
      if (queue.length && !st.isDirectory()) return MISSING;
      cur = next;
    }
    if (!st) {
      if (real.includes(cur)) return { state: "dir", real: cur, size: 0 };
      try {
        st = fsMod.lstatSync(cur);
      } catch (_) {
        return MISSING;
      }
    }
    return { state: st.isDirectory() ? "dir" : st.isFile() ? "file" : "other", real: cur, size: st.size };
  }

  function status(abs) {
    if (typeof abs !== "string" || !abs || hasControl(abs)) return MISSING;
    abs = path.resolve(abs);
    if (cache.has(abs)) return cache.get(abs);
    const r = walk(abs);
    cache.set(abs, r);
    return r;
  }

  function readText(abs, maxBytes) {
    const s = status(abs);
    if (s.state === "outside") return { skip: "outside" };
    if (s.state !== "file") return { skip: "missing" };
    if (s.size > maxBytes) return { skip: "large" };
    try {
      return { text: fsMod.readFileSync(s.real, "utf8") };
    } catch (_) {
      return { skip: "unreadable" };
    }
  }

  const inside = (p) => !!rootIndex(path.resolve(p));
  const rootOf = (p) => {
    const ri = rootIndex(path.resolve(p));
    return ri ? roots[ri.i] : null;
  };
  return { status, readText, inside, rootOf, roots, real };
}

// ---------------------------------------------------------------------------
// File index (relative paths from vscode.workspace.findFiles; no fs access)
// ---------------------------------------------------------------------------

function parentOf(rel) {
  const i = rel.lastIndexOf("/");
  return i > 0 ? rel.slice(0, i) : "";
}

class FileIndex {
  constructor() {
    this.roots = new Map();
    this.truncated = false;
  }
  _r(root) {
    let r = this.roots.get(root);
    if (!r) {
      r = { files: new Set(), dirs: new Set(), names: null };
      this.roots.set(root, r);
    }
    return r;
  }
  clear() {
    this.roots.clear();
    this.truncated = false;
  }
  add(root, rel) {
    if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return;
    const r = this._r(root);
    r.files.add(rel);
    let d = rel;
    while ((d = parentOf(d))) {
      if (r.dirs.has(d)) break;
      r.dirs.add(d);
    }
    r.names = null;
  }
  remove(root, rel) {
    const r = this.roots.get(root);
    if (!r) return;
    const pre = rel + "/";
    for (const f of [...r.files]) if (f === rel || f.startsWith(pre)) r.files.delete(f);
    for (const d of [...r.dirs]) if (d === rel || d.startsWith(pre)) r.dirs.delete(d);
    r.names = null;
  }
  _names(r) {
    if (r.names) return r.names;
    const names = new Map();
    const put = (rel, dir) => {
      const n = rel.slice(rel.lastIndexOf("/") + 1);
      let list = names.get(n);
      if (!list) names.set(n, (list = []));
      list.push({ rel, dir });
    };
    for (const f of r.files) put(f, false);
    for (const d of r.dirs) put(d, true);
    r.names = names;
    return names;
  }
  match(root, re, kind) {
    const r = this.roots.get(root);
    if (!r || !re) return false;
    if (kind !== "dir") for (const f of r.files) if (re.test(f)) return true;
    if (kind !== "file") for (const d of r.dirs) if (re.test(d) || re.test(d + "/")) return true;
    return false;
  }
  hasName(root, scopeRel, name, kind) {
    const r = this.roots.get(root);
    if (!r) return false;
    const list = this._names(r).get(name) || [];
    return list.some(
      (e) => (kind === "dir" ? e.dir : kind === "file" ? !e.dir : true) && (!scopeRel || e.rel.startsWith(scopeRel + "/"))
    );
  }
  suggest(root, rel, kind, confineRel) {
    const r = this.roots.get(root);
    if (!r || !rel) return null;
    const names = this._names(r);
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    if (!name) return null;
    const ok = (e) =>
      e.rel !== rel &&
      (kind === "dir" ? e.dir : kind === "file" ? !e.dir : true) &&
      (!confineRel || e.rel.startsWith(confineRel + "/"));
    let best = null;
    let bestScore = Infinity;
    const consider = (e, score) => {
      if (score < bestScore || (score === bestScore && best && e.rel.length < best.length)) {
        best = e.rel;
        bestScore = score;
      }
    };
    for (const e of names.get(name) || []) if (ok(e)) consider(e, osa(rel, e.rel));
    if (best) return best;
    const thr = name.length <= 4 ? 1 : Math.min(3, Math.max(1, Math.floor(name.length / 4)));
    for (const [n, list] of names) {
      if (Math.abs(n.length - name.length) > thr) continue;
      const d = osa(name, n, thr);
      if (d > thr || d === 0) continue;
      for (const e of list) if (ok(e)) consider(e, d * 1000 + osa(rel, e.rel));
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// JSONC parser with positions (comments, trailing commas, BOM; depth-limited)
// ---------------------------------------------------------------------------

const JSON_ESC = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

function parseJsonc(text) {
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = () => {
    throw new Error("json");
  };
  function ws() {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff) {
        i++;
        continue;
      }
      if (c === 47) {
        const d = text[i + 1];
        if (d === "/") {
          const e = text.indexOf("\n", i);
          i = e < 0 ? n : e + 1;
          continue;
        }
        if (d === "*") {
          const e = text.indexOf("*/", i + 2);
          if (e < 0) fail();
          i = e + 2;
          continue;
        }
      }
      return;
    }
  }
  function str() {
    const start = i;
    i++;
    let out = "";
    for (;;) {
      if (i >= n) fail();
      const c = text[i];
      if (c === '"') {
        i++;
        break;
      }
      if (c === "\n" || c === "\r") fail();
      if (c === "\\") {
        const e = text[i + 1];
        if (e === "u") {
          const h = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) fail();
          out += String.fromCharCode(parseInt(h, 16));
          i += 6;
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(JSON_ESC, e)) fail();
        out += JSON_ESC[e];
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return { type: "string", value: out, start: start + 1, end: i - 1 };
  }
  function value(depth) {
    if (depth > 200) fail();
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const props = [];
      for (;;) {
        ws();
        if (text[i] === "}") {
          i++;
          break;
        }
        if (text[i] !== '"') fail();
        const k = str();
        ws();
        if (text[i] !== ":") fail();
        i++;
        const v = value(depth + 1);
        props.push({ key: k.value, value: v });
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          break;
        }
        fail();
      }
      return { type: "object", props };
    }
    if (c === "[") {
      i++;
      const items = [];
      for (;;) {
        ws();
        if (text[i] === "]") {
          i++;
          break;
        }
        items.push(value(depth + 1));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          break;
        }
        fail();
      }
      return { type: "array", items };
    }
    if (c === '"') return str();
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
    if (!m) fail();
    i += m[0].length;
    return { type: "literal" };
  }
  try {
    const v = value(0);
    ws();
    return i >= n ? v : null;
  } catch (_) {
    return null;
  }
}

function jget(node, key) {
  if (!node || node.type !== "object") return null;
  let v = null;
  for (const p of node.props) if (p.key === key) v = p.value;
  return v;
}

// ---------------------------------------------------------------------------
// Line-oriented YAML reader with positions (block maps/sequences, block scalars,
// one-line flow sequences, quotes, comments, anchors/tags). Not a full YAML parser.
// ---------------------------------------------------------------------------

function stripYamlComment(t) {
  let q = null;
  for (let j = 0; j < t.length; j++) {
    const c = t[j];
    if (q) {
      if (q === "'" && c === "'") {
        if (t[j + 1] === "'") j++;
        else q = null;
      } else if (q === '"' && c === "\\") j++;
      else if (q === '"' && c === '"') q = null;
      continue;
    }
    if ((c === '"' || c === "'") && (j === 0 || /[\s[{,]/.test(t[j - 1]))) {
      q = c;
      continue;
    }
    if (c === "#" && (j === 0 || /\s/.test(t[j - 1]))) return t.slice(0, j).replace(/\s+$/, "");
  }
  return t;
}

function yamlScalar(t, line, col) {
  let m;
  while ((m = /^([&!][^\s]*)\s+/.exec(t))) {
    col += m[0].length;
    t = t.slice(m[0].length);
  }
  if (!t || /^[&!]\S*$/.test(t)) return { type: "scalar", value: "", line, col, endCol: col, quote: null, empty: true };
  if (t[0] === "*") return { type: "alias" };
  if (t[0] === '"') {
    let j = 1;
    let out = "";
    let esc = false;
    while (j < t.length && t[j] !== '"') {
      if (t[j] === "\\") {
        esc = true;
        const e = t[j + 1];
        out += e === "n" ? "\n" : e === "t" ? "\t" : e === undefined ? "" : e;
        j += 2;
        continue;
      }
      out += t[j];
      j++;
    }
    if (j >= t.length) return { type: "scalar", value: t, line, col, endCol: col + t.length, bad: true };
    return { type: "scalar", value: out, line, col: col + 1, endCol: col + j, quote: '"', escaped: esc };
  }
  if (t[0] === "'") {
    let j = 1;
    let out = "";
    let esc = false;
    while (j < t.length) {
      if (t[j] === "'") {
        if (t[j + 1] === "'") {
          out += "'";
          esc = true;
          j += 2;
          continue;
        }
        break;
      }
      out += t[j];
      j++;
    }
    if (j >= t.length) return { type: "scalar", value: t, line, col, endCol: col + t.length, bad: true };
    return { type: "scalar", value: out, line, col: col + 1, endCol: col + j, quote: "'", escaped: esc };
  }
  return { type: "scalar", value: t, line, col, endCol: col + t.length, quote: null };
}

function yamlFlowSeq(t, line, col) {
  const m = /^\[(.*)\]$/.exec(t);
  if (!m || /[[\]{}]/.test(m[1])) return { type: "flow" };
  const items = [];
  const inner = m[1];
  let start = 0;
  let q = null;
  const push = (end) => {
    const seg = inner.slice(start, end);
    const lead = seg.length - seg.replace(/^\s+/, "").length;
    const s = seg.trim();
    if (s) items.push(yamlScalar(s, line, col + 1 + start + lead));
  };
  for (let j = 0; j < inner.length; j++) {
    const c = inner[j];
    if (q) {
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === ",") {
      push(j);
      start = j + 1;
    }
  }
  push(inner.length);
  return { type: "seq", items, line };
}

function yamlKeySplit(t) {
  let j = 0;
  let key;
  if (t[0] === '"' || t[0] === "'") {
    const q = t[0];
    j = 1;
    while (j < t.length && t[j] !== q) j += t[j] === "\\" && q === '"' ? 2 : 1;
    if (j >= t.length) return null;
    key = t.slice(1, j);
    j++;
    while (t[j] === " ") j++;
    if (t[j] !== ":" || (t[j + 1] !== undefined && t[j + 1] !== " ")) return null;
  } else {
    const m = /:(?: |$)/.exec(t);
    if (!m || m.index === 0) return null;
    if (/^[[{]/.test(t)) return null;
    key = t.slice(0, m.index).trim();
    j = m.index;
  }
  j++;
  while (t[j] === " ") j++;
  return { key, value: t.slice(j), valueOffset: j };
}

function parseYaml(text) {
  const raw = splitLines(text);
  let i = 0;
  let virt = null;
  const isSeq = (t) => t === "-" || t.startsWith("- ");
  function info(n) {
    const s = raw[n].replace(/\t/g, " ");
    const m = /^( *)(.*?)\s*$/.exec(s);
    const t = m[2];
    if (!t || t[0] === "#" || t[0] === "%") return null;
    if (/^(---|\.\.\.)(\s|$)/.test(t)) return { doc: true, indent: -1, line: n };
    const body = stripYamlComment(t);
    if (!body) return null;
    return { indent: m[1].length, col: m[1].length, text: body, line: n };
  }
  function peek() {
    if (virt) return virt;
    while (i < raw.length) {
      const li = info(i);
      if (li) return li;
      i++;
    }
    return null;
  }
  function advance() {
    virt = null;
    i++;
  }
  function skipDeeper(ind) {
    let p;
    while ((p = peek()) && !p.doc && p.indent > ind) advance();
  }
  function blockScalar(ind) {
    const lines = [];
    let blockIndent = -1;
    while (i < raw.length) {
      const s = raw[i];
      if (!s.trim()) {
        i++;
        continue;
      }
      const indent = /^[ \t]*/.exec(s)[0].length;
      if (indent <= ind) break;
      if (blockIndent < 0) blockIndent = indent;
      if (indent < blockIndent) break;
      lines.push({ text: s.slice(blockIndent), line: i, col: blockIndent });
      i++;
    }
    return { type: "scalar", block: true, lines, value: lines.map((l) => l.text).join("\n") };
  }
  function node() {
    const p = peek();
    if (!p || p.doc) return null;
    if (isSeq(p.text)) return seq(p.indent);
    if (yamlKeySplit(p.text)) return map(p.indent);
    advance();
    const t = p.text;
    if (t[0] === "[") return yamlFlowSeq(t, p.line, p.col);
    if (t[0] === "{") return { type: "flow" };
    return yamlScalar(t, p.line, p.col);
  }
  function seq(ind) {
    const items = [];
    const out = { type: "seq", items, line: peek().line };
    for (;;) {
      const p = peek();
      if (!p || p.doc || p.indent !== ind || !isSeq(p.text)) break;
      const after = p.text.slice(1);
      const rest = after.replace(/^ +/, "");
      if (!rest) {
        advance();
        const q = peek();
        items.push(q && !q.doc && q.indent > ind ? node() : null);
      } else {
        const c = p.col + 1 + (after.length - rest.length);
        virt = { indent: c, col: c, text: rest, line: p.line };
        items.push(node());
      }
      skipDeeper(ind);
    }
    return out;
  }
  function map(ind) {
    const entries = [];
    const out = { type: "map", entries, line: peek().line };
    for (;;) {
      const p = peek();
      if (!p || p.doc || p.indent !== ind || isSeq(p.text)) break;
      const kv = yamlKeySplit(p.text);
      if (!kv) {
        advance();
        skipDeeper(ind);
        continue;
      }
      const vtext = kv.value;
      const vcol = p.col + kv.valueOffset;
      advance();
      let value = null;
      const bare = vtext.replace(/^([&!][^\s]*\s*)+/, "");
      if (!bare) {
        const q = peek();
        if (q && !q.doc && (q.indent > ind || (q.indent === ind && isSeq(q.text)))) value = node();
      } else if (/^[|>][0-9+-]*$/.test(bare)) {
        value = blockScalar(ind);
      } else if (bare[0] === "[") {
        value = yamlFlowSeq(bare, p.line, vcol + (vtext.length - bare.length));
      } else if (bare[0] === "{") {
        value = { type: "flow" };
      } else {
        value = yamlScalar(vtext, p.line, vcol);
      }
      entries.push({ key: kv.key, line: p.line, value });
      skipDeeper(ind);
    }
    return out;
  }
  const docs = [];
  let guard = 0;
  while (peek() && guard++ < 100000) {
    const p = peek();
    if (p.doc) {
      advance();
      continue;
    }
    const before = i;
    const n = node();
    if (n) docs.push(n);
    if (i === before && !virt) advance();
  }
  return docs;
}

function yget(node, key) {
  if (!node || node.type !== "map") return null;
  let v = null;
  for (const e of node.entries) if (e.key === key) v = e.value;
  return v;
}

function yscalar(node) {
  return node && node.type === "scalar" && !node.block && !node.bad && !node.empty ? node : null;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classify(file) {
  const parts = file.split(/[\\/]/);
  const base = parts[parts.length - 1] || "";
  const parent = parts[parts.length - 2] || "";
  const grand = parts[parts.length - 3] || "";
  if (base === "package.json") return "package";
  if (/^[tj]sconfig(\..+)?\.json$/i.test(base)) return "tsconfig";
  if (/\.dockerignore$/i.test(base)) return null;
  if (/^(Dockerfile|Containerfile)(\.[\w.-]+)?$/.test(base) || /\.(Dockerfile|dockerfile|Containerfile)$/.test(base)) return "dockerfile";
  if (/^(docker-)?compose(\.[\w.-]+)?\.ya?ml$/.test(base)) return "compose";
  if (/\.ya?ml$/.test(base) && parent === "workflows" && grand === ".github") return "workflow";
  if (/^action\.ya?ml$/.test(base) && parts.includes(".github")) return "action";
  if (base === "CODEOWNERS") return "codeowners";
  if (base === "launch.json" && parent === ".vscode") return "launch";
  if (base === ".gitlab-ci.yml" || /\.gitlab-ci\.ya?ml$/.test(base)) return "gitlab";
  return null;
}

// ---------------------------------------------------------------------------
// Reference extraction
// ---------------------------------------------------------------------------

function mkRef(o) {
  const r = Object.assign({ kind: "any", glob: false, alts: [], fmt: "rel", escape: "none" }, o);
  if (r.display === undefined) r.display = r.value;
  if (r.lead === undefined) r.lead = /^\.\//.test(r.value) ? "./" : "";
  if (r.trail === undefined) r.trail = r.value.length > 1 && /\/$/.test(r.value) ? "/" : "";
  return r;
}

function jsonRef(c, node, o) {
  const p = posOf(c.starts, node.start);
  return mkRef(
    Object.assign({ file: c.file, line: p.line, col: p.col, endCol: p.col + (node.end - node.start), value: node.value, escape: "json" }, o)
  );
}

function yamlRef(c, s, o) {
  return mkRef(
    Object.assign(
      {
        file: c.file,
        line: s.line,
        col: s.col,
        endCol: s.endCol,
        value: s.value,
        escape: s.quote === '"' ? "yaml-dq" : s.quote === "'" ? "yaml-sq" : "plain",
      },
      o
    )
  );
}

function extractPackage(c) {
  const tree = parseJsonc(c.text);
  if (!tree || tree.type !== "object") return [];
  const out = [];
  const base = path.dirname(c.file);
  const add = (node, label, o) => {
    if (!node || node.type !== "string" || !node.value) return;
    out.push(jsonRef(c, node, Object.assign({ code: "PM001", base, label: "package.json " + label }, o)));
  };
  add(jget(tree, "main"), "main", { kind: "file", alts: [".js", ".json", ".node", "/index.js", "/index.json", "/index.node"] });
  for (const k of ["module", "types", "typings", "browser"]) add(jget(tree, k), k, { kind: "file" });
  const bin = jget(tree, "bin");
  if (bin && bin.type === "string") add(bin, "bin", { kind: "file" });
  else if (bin && bin.type === "object") for (const p of bin.props) add(p.value, "bin." + p.key, { kind: "file" });
  const walk = (node, label, d) => {
    if (!node || d > 20) return;
    if (node.type === "string") {
      if (node.value.startsWith("./")) add(node, label, { kind: "file", glob: node.value.includes("*") ? "any" : false });
    } else if (node.type === "object") {
      for (const p of node.props) walk(p.value, label + '["' + p.key + '"]', d + 1);
    } else if (node.type === "array") {
      for (const it of node.items) walk(it, label, d + 1);
    }
  };
  walk(jget(tree, "exports"), "exports", 0);
  const files = jget(tree, "files");
  if (files && files.type === "array") {
    for (const it of files.items) {
      if (it.type === "string" && it.value && !it.value.startsWith("!")) add(it, "files", { kind: "any", glob: isGlob(it.value) ? "std" : false });
    }
  }
  let ws = jget(tree, "workspaces");
  if (ws && ws.type === "object") ws = jget(ws, "packages");
  if (ws && ws.type === "array") {
    for (const it of ws.items) {
      if (it.type === "string" && it.value && !it.value.startsWith("!")) add(it, "workspaces", { kind: "dir", glob: isGlob(it.value) ? "std" : false });
    }
  }
  return out;
}

// Module resolution suffixes TypeScript tries for a "paths" target without a wildcard.
const TS_MODULE_ALTS = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".d.mts", ".d.cts", ".js", ".jsx", ".mjs", ".cjs", ".json", "/index.ts", "/index.tsx", "/index.d.ts", "/index.js", "/index.jsx", "/package.json"];

/** Relative "extends" targets of a parsed tsconfig, as absolute paths (null for a package name). */
function tsExtends(tree, file) {
  const ext = jget(tree, "extends");
  const out = [];
  for (const n of ext && ext.type === "array" ? ext.items : [ext]) {
    if (!n || n.type !== "string" || !n.value) continue;
    if (!/^(\.\.?\/|\/)/.test(n.value) || n.value.includes("$")) {
      out.push(null);
      continue;
    }
    const abs = path.resolve(path.dirname(file), n.value);
    out.push(/\.json$/i.test(abs) ? abs : abs + ".json");
  }
  return out;
}

/** baseUrl of `file` or inherited through relative "extends" (later entries win); null when none, undefined when unknown. */
function inheritedBaseUrl(file, ctx, depth) {
  const info = ctx.tsInfo.get(file);
  if (!info || depth > 16) return undefined;
  if (info.baseUrl !== null) return info.baseUrl;
  for (let k = info.extends.length - 1; k >= 0; k--) {
    const e = info.extends[k];
    if (e === null) return undefined;
    const r = inheritedBaseUrl(e, ctx, depth + 1);
    if (r !== null) return r;
  }
  return null;
}

/**
 * The directory "paths" of `file` are resolved against: its own baseUrl, else the baseUrl it
 * inherits through relative "extends", else its own folder. Undefined when that is unknown (a
 * package name in "extends", or a base config that was not read): the entries are then not
 * checked rather than checked against a guess.
 */
function tsPathsBase(file, ctx) {
  const r = inheritedBaseUrl(file, ctx, 0);
  if (r === undefined) return undefined;
  return r === null ? path.dirname(file) : r;
}

function tsInfoOf(c) {
  const tree = parseJsonc(c.text);
  if (!tree || tree.type !== "object") return null;
  const co = jget(tree, "compilerOptions");
  const b = jget(co, "baseUrl");
  const ok = b && b.type === "string" && b.value && !b.value.includes("$") && !hasControl(b.value);
  return { tree, baseUrl: ok ? path.resolve(path.dirname(c.file), b.value) : null, extends: tsExtends(tree, c.file) };
}

function extractTsconfig(c, ctx) {
  const info = ctx.tsInfo.get(c.file);
  const tree = info && info.tree;
  if (!tree || tree.type !== "object") return [];
  const out = [];
  const base = path.dirname(c.file);
  const name = path.basename(c.file);
  const add = (node, label, o) => {
    if (!node || node.type !== "string" || !node.value) return;
    out.push(jsonRef(c, node, Object.assign({ code: "PM002", base, label: name + " " + label }, o)));
  };
  const ext = jget(tree, "extends");
  for (const n of ext && ext.type === "array" ? ext.items : [ext]) {
    if (n && n.type === "string" && /^(\.\.?\/|\/)/.test(n.value)) add(n, "extends", { kind: "file", alts: [".json"] });
  }
  const files = jget(tree, "files");
  if (files && files.type === "array") for (const n of files.items) add(n, "files", { kind: "file" });
  const inc = jget(tree, "include");
  if (inc && inc.type === "array") for (const n of inc.items) if (n.type === "string") add(n, "include", { kind: "any", glob: isGlob(n.value) ? "std" : false });
  const refs = jget(tree, "references");
  if (refs && refs.type === "array") {
    for (const r of refs.items) add(jget(r, "path"), "references", { kind: "any", needFileIn: ["tsconfig.json"] });
  }
  const co = jget(tree, "compilerOptions");
  const baseUrl = jget(co, "baseUrl");
  if (baseUrl && baseUrl.type === "string" && baseUrl.value) add(baseUrl, "compilerOptions.baseUrl", { kind: "dir" });
  const typeRoots = jget(co, "typeRoots");
  if (typeRoots && typeRoots.type === "array") {
    for (const n of typeRoots.items) add(n, "compilerOptions.typeRoots", { kind: "dir" });
  }
  const paths = jget(co, "paths");
  let pathsBase = paths && paths.type === "object" ? tsPathsBase(c.file, ctx) : undefined;
  // A missing (or outside) baseUrl is reported once; its "paths" are then not checked against it.
  if (pathsBase !== undefined && ctx.guard.status(pathsBase).state !== "dir") pathsBase = undefined;
  if (pathsBase !== undefined) {
    for (const p of paths.props) {
      if (!p.value || p.value.type !== "array") continue;
      const label = 'compilerOptions.paths["' + p.key + '"]';
      for (const n of p.value.items) {
        if (!n || n.type !== "string" || !n.value || n.value.includes("$")) continue;
        if (n.value.includes("*")) add(n, label, { base: pathsBase, kind: "any", glob: "any" });
        else add(n, label, { base: pathsBase, kind: "any", alts: TS_MODULE_ALTS });
      }
    }
  }
  for (const k of ["outDir", "declarationDir"]) {
    const n = jget(co, k);
    if (n && n.type === "string" && n.value && !n.value.includes("$")) ctx.outDirs.push(path.resolve(base, n.value));
  }
  return out;
}

function skipYamlValue(v) {
  return !v || v.includes("$") || isUrl(v) || hasControl(v);
}

function extractCompose(c, ctx) {
  const out = [];
  const dir = path.dirname(c.file);
  for (const doc of parseYaml(c.text)) {
    const services = yget(doc, "services");
    if (!services || services.type !== "map") continue;
    for (const svc of services.entries) {
      const build = yget(svc.value, "build");
      if (!build) continue;
      let ctxNode = null;
      let dfNode = null;
      let inline = false;
      if (build.type === "scalar") ctxNode = yscalar(build);
      else if (build.type === "map") {
        ctxNode = yscalar(yget(build, "context"));
        dfNode = yscalar(yget(build, "dockerfile"));
        inline = !!yget(build, "dockerfile_inline");
      } else continue;
      const label = "compose service " + svc.key;
      let ctxAbs = dir;
      if (ctxNode) {
        const v = ctxNode.value;
        if (skipYamlValue(v) || /\.git(#|$)/.test(v)) continue;
        out.push(yamlRef(c, ctxNode, { code: "PM004", base: dir, kind: "dir", label: label + " build.context" }));
        ctxAbs = path.resolve(dir, v);
      }
      if (!ctx.inside(ctxAbs)) continue;
      let dfAbs = null;
      if (dfNode && !skipYamlValue(dfNode.value)) {
        out.push(yamlRef(c, dfNode, { code: "PM004", base: ctxAbs, kind: "file", label: label + " build.dockerfile" }));
        dfAbs = path.resolve(ctxAbs, dfNode.value);
      } else if (!dfNode && !inline) {
        dfAbs = path.join(ctxAbs, "Dockerfile");
      }
      if (dfAbs) {
        if (!ctx.links.has(dfAbs)) ctx.links.set(dfAbs, []);
        const list = ctx.links.get(dfAbs);
        if (!list.includes(ctxAbs)) list.push(ctxAbs);
      }
    }
  }
  return out;
}

const RUN_RE =
  /(^|&&|\|\||[;|(`]|\b(?:then|do|else)\s)\s*(?:(?:sudo|exec|time|nohup)\s+)*(?:(bash|sh|zsh|dash|ksh|python3?|node|ruby|perl|pwsh|source|\.)\s+(?:-[A-Za-z-]+\s+)*)?((?:\.\.?\/)?[\w@.+-][^\s;&|()<>`'"]*)/g;
const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1)$/;

function runTokens(scalar) {
  const out = [];
  let lines;
  if (scalar.block) lines = scalar.lines;
  else if (scalar.type === "scalar" && !scalar.bad && !scalar.escaped) lines = [{ text: scalar.value, line: scalar.line, col: scalar.col }];
  else return out;
  for (const l of lines) {
    RUN_RE.lastIndex = 0;
    let m;
    while ((m = RUN_RE.exec(l.text))) {
      const interp = m[2];
      let tok = m[3];
      const start = m.index + m[0].length - tok.length;
      tok = tok.replace(/[,:]+$/, "");
      if (!tok || tok.includes("$") || isGlob(tok) || isUrl(tok) || tok.startsWith("-")) continue;
      if (interp) {
        if (!tok.includes("/") && !SCRIPT_EXT.test(tok)) continue;
      } else if (!/^\.\.?\//.test(tok)) continue;
      out.push({ value: tok, line: l.line, col: l.col + start, endCol: l.col + start + tok.length });
    }
  }
  return out;
}

function repoRootOf(file) {
  const parts = file.split(path.sep);
  const i = parts.lastIndexOf(".github");
  return i > 0 ? parts.slice(0, i).join(path.sep) || path.sep : path.dirname(file);
}

function extractWorkflow(c, kind) {
  const out = [];
  const root = repoRootOf(c.file);
  const doc = parseYaml(c.text)[0];
  if (!doc || doc.type !== "map") return out;
  const wdRef = (node, label) => {
    const s = yscalar(node);
    if (!s || skipYamlValue(s.value)) return { skip: !!s, value: null };
    out.push(yamlRef(c, s, { code: "PM005", base: root, kind: "dir", label: label + " working-directory" }));
    return { skip: false, value: s.value };
  };
  const wd = (node) => yget(yget(yget(node, "defaults"), "run"), "working-directory");
  const doSteps = (steps, label, inherited) => {
    if (!steps || steps.type !== "seq") return;
    for (const step of steps.items) {
      if (!step || step.type !== "map") continue;
      const uses = yscalar(yget(step, "uses"));
      if (uses && uses.value.startsWith("./") && !skipYamlValue(uses.value)) {
        out.push(yamlRef(c, uses, { code: "PM005", base: root, kind: "dir", needFileIn: ["action.yml", "action.yaml", "Dockerfile"], label: label + " uses" }));
      }
      let eff = inherited;
      if (yget(step, "working-directory")) {
        const r = wdRef(yget(step, "working-directory"), label + " step");
        eff = r.skip ? { skip: true } : { skip: false, value: r.value };
      }
      const run = yget(step, "run");
      if (!run || eff.skip) continue;
      const base = eff.value ? path.resolve(root, eff.value) : root;
      for (const t of runTokens(run)) {
        out.push(
          mkRef({ file: c.file, line: t.line, col: t.col, endCol: t.endCol, value: t.value, escape: "shell", code: "PM005", base, kind: "file", requireBase: true, label: label + " run" })
        );
      }
    }
  };
  if (kind === "action") {
    doSteps(yget(yget(doc, "runs"), "steps"), "action", { skip: false, value: null });
    return out;
  }
  let wfWd = { skip: false, value: null };
  if (wd(doc)) {
    const r = wdRef(wd(doc), "workflow defaults");
    wfWd = r.skip ? { skip: true } : { skip: false, value: r.value };
  }
  const jobs = yget(doc, "jobs");
  if (!jobs || jobs.type !== "map") return out;
  for (const job of jobs.entries) {
    const j = job.value;
    if (!j || j.type !== "map") continue;
    const label = "job " + job.key;
    const steps = yget(j, "steps");
    const movedCheckout =
      steps &&
      steps.type === "seq" &&
      steps.items.some((s) => {
        const u = yscalar(yget(s, "uses"));
        return u && /^actions\/checkout@/.test(u.value) && yget(yget(s, "with"), "path");
      });
    if (movedCheckout) continue;
    const juses = yscalar(yget(j, "uses"));
    if (juses && juses.value.startsWith("./") && !skipYamlValue(juses.value)) {
      out.push(yamlRef(c, juses, { code: "PM005", base: root, kind: "file", label: label + " uses" }));
    }
    let eff = wfWd;
    if (wd(j)) {
      const r = wdRef(wd(j), label + " defaults");
      eff = r.skip ? { skip: true } : { skip: false, value: r.value };
    }
    doSteps(steps, label, eff);
  }
  return out;
}

function extractGitlab(c) {
  const out = [];
  const root = path.dirname(c.file);
  const doc = parseYaml(c.text)[0];
  const inc = yget(doc, "include");
  if (!inc) return out;
  const items = inc.type === "seq" ? inc.items : [inc];
  const add = (s) => {
    if (!s || skipYamlValue(s.value)) return;
    const v = s.value;
    const lead = v.startsWith("/");
    const r = yamlRef(c, s, { code: "PM008", base: root, kind: "file", label: ".gitlab-ci.yml include local", glob: isGlob(v) ? "std" : false });
    if (lead) {
      r.value = v.replace(/^\/+/, "");
      r.fmt = "root";
      r.lead = "";
    }
    out.push(r);
  };
  for (const it of items) {
    if (!it) continue;
    if (it.type === "scalar") add(yscalar(it));
    else if (it.type === "map") add(yscalar(yget(it, "local")));
  }
  return out;
}

function extractCodeowners(c) {
  const out = [];
  const dir = path.dirname(c.file);
  const root = /^(\.github|docs|\.gitlab)$/.test(path.basename(dir)) ? path.dirname(dir) : dir;
  const lines = splitLines(c.text);
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n];
    const lead = /^\s*/.exec(l)[0].length;
    const t = l.slice(lead);
    if (!t || t[0] === "#" || t[0] === "[" || t.startsWith("^[")) continue;
    const m = /^((?:\\.|[^\s\\])+)/.exec(t);
    if (!m) continue;
    const pat = m[1];
    if (/[*?[\]!]/.test(pat) || hasControl(pat)) continue;
    const escaped = pat.includes("\\");
    const unesc = pat.replace(/\\(.)/g, "$1");
    const core = unesc.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!core) continue;
    const anchored = unesc.startsWith("/") || core.includes("/");
    const kind = /\/$/.test(unesc) ? "dir" : "any";
    const r = mkRef({
      file: c.file,
      line: n,
      col: lead,
      endCol: lead + pat.length,
      value: unesc,
      display: pat,
      escape: escaped ? "noedit" : "shell",
      code: "PM006",
      base: root,
      kind,
      label: "CODEOWNERS",
    });
    if (unesc.startsWith("/")) {
      r.value = unesc.replace(/^\/+/, "");
      r.fmt = "root";
      r.lead = "";
    }
    if (!anchored) r.anywhere = core;
    out.push(r);
  }
  return out;
}

function extractLaunch(c, ctx) {
  const out = [];
  const tree = parseJsonc(c.text);
  const confs = jget(tree, "configurations");
  if (!confs || confs.type !== "array") return out;
  const folder = path.dirname(path.dirname(c.file));
  for (const conf of confs.items) {
    for (const [k, kind] of [["program", "file"], ["cwd", "dir"]]) {
      const n = jget(conf, k);
      if (!n || n.type !== "string") continue;
      const m = /^\$\{(workspaceFolder|workspaceRoot)(?::([^}]+))?\}(.*)$/.exec(n.value);
      if (!m || m[3].includes("${") || hasControl(n.value)) continue;
      let base = folder;
      if (m[2]) {
        const f = ctx.roots.find((r) => r.name === m[2]);
        if (!f) continue;
        base = f.path;
      }
      const rest = m[3].replace(/^[\\/]+/, "");
      const r = jsonRef(c, n, { code: "PM007", base, kind, label: "launch.json " + k, fmt: "wsvar" });
      r.varPrefix = "${" + m[1] + (m[2] ? ":" + m[2] : "") + "}";
      r.value = rest || ".";
      r.lead = "";
      r.trail = rest.length > 1 && /\/$/.test(rest) ? "/" : "";
      out.push(r);
    }
  }
  return out;
}

function dockerTokens(text, from) {
  const toks = [];
  let j = from;
  const n = text.length;
  while (j < n) {
    while (j < n && /\s/.test(text[j])) j++;
    if (j >= n) break;
    let val = "";
    const start = j;
    let quoted = false;
    let cStart = j;
    let cEnd = -1;
    while (j < n && !/\s/.test(text[j])) {
      const ch = text[j];
      if (ch === '"' || ch === "'") {
        const e = text.indexOf(ch, j + 1);
        if (e < 0) return null;
        quoted = true;
        if (j === start) cStart = j + 1;
        val += text.slice(j + 1, e);
        cEnd = e;
        j = e + 1;
        continue;
      }
      val += ch;
      j++;
    }
    toks.push({ value: val, start: quoted ? cStart : start, end: quoted ? cEnd : j, quoted });
  }
  return toks;
}

function dockerJsonTokens(text, from) {
  const t = text.slice(from).trim();
  if (!/^\[.*\]$/.test(t)) return null;
  const toks = [];
  let j = text.indexOf("[", from) + 1;
  for (;;) {
    while (j < text.length && /[\s,]/.test(text[j])) j++;
    if (text[j] === "]") break;
    if (text[j] !== '"') return null;
    let k = j + 1;
    let val = "";
    let esc = false;
    while (k < text.length && text[k] !== '"') {
      if (text[k] === "\\") {
        esc = true;
        val += text[k + 1] || "";
        k += 2;
        continue;
      }
      val += text[k];
      k++;
    }
    if (k >= text.length) return null;
    toks.push({ value: val, start: j + 1, end: k, quoted: true, json: true, esc });
    j = k + 1;
  }
  return toks;
}

function parseDockerfile(text) {
  const raw = splitLines(text);
  let esc = "\\";
  for (const l of raw) {
    const m = /^\s*#\s*([a-zA-Z]+)\s*=\s*(\S+)\s*$/.exec(l);
    if (!m) break;
    if (m[1].toLowerCase() === "escape" && (m[2] === "`" || m[2] === "\\")) esc = m[2];
  }
  const instrs = [];
  let n = 0;
  while (n < raw.length) {
    if (/^\s*(#|$)/.test(raw[n])) {
      n++;
      continue;
    }
    const map = [];
    let textL = "";
    let cur = n;
    for (;;) {
      const l = raw[cur];
      const trimmed = l.replace(/\s+$/, "");
      const cont = trimmed.endsWith(esc);
      const body = cont ? trimmed.slice(0, -1) : l;
      for (let k = 0; k < body.length; k++) map.push({ line: cur, col: k });
      textL += body;
      cur++;
      if (!cont) break;
      while (cur < raw.length && /^\s*(#.*)?$/.test(raw[cur])) cur++;
      if (cur >= raw.length) break;
    }
    const hd = [];
    const re = /<<(-?)(["']?)([A-Za-z_]\w*)\2/g;
    let m;
    while ((m = re.exec(textL))) hd.push({ strip: m[1] === "-", word: m[3] });
    for (const h of hd) {
      while (cur < raw.length) {
        const l = raw[cur++];
        if ((h.strip ? l.replace(/^\t+/, "") : l) === h.word) break;
      }
    }
    instrs.push({ text: textL, map, heredoc: hd.length > 0 });
    n = cur;
  }
  return instrs;
}

function extractDockerfile(c, ctx) {
  const out = [];
  const dir = path.dirname(c.file);
  const linked = ctx.links.get(c.file);
  let bases;
  if (linked && linked.length) bases = linked.map((d) => ({ dir: d, confine: true }));
  else {
    bases = [{ dir, confine: false }];
    const root = ctx.rootOf(c.file);
    let d = dir;
    while (root && d !== root && within(d, root)) {
      d = path.dirname(d);
      bases.push({ dir: d, confine: false });
    }
  }
  for (const ins of parseDockerfile(c.text)) {
    const m = /^\s*(COPY|ADD)\s+/i.exec(ins.text);
    if (!m) continue;
    const from = m[0].length;
    let toks = ins.text.slice(from).trim().startsWith("[") ? dockerJsonTokens(ins.text, from) : dockerTokens(ins.text, from);
    if (!toks) continue;
    const flags = [];
    while (toks.length && !toks[0].json && toks[0].value.startsWith("--")) flags.push(toks.shift().value);
    if (flags.some((f) => /^--from(=|$)/i.test(f))) continue;
    if (toks.length < 2) continue;
    for (const t of toks.slice(0, -1)) {
      const v = t.value;
      if (!v || v.startsWith("<<") || v.includes("$") || isUrl(v) || hasControl(v)) continue;
      if (t.end <= t.start) continue;
      const a = ins.map[t.start];
      const b = ins.map[t.end - 1];
      if (!a || !b || a.line !== b.line) continue;
      const r = mkRef({
        file: c.file,
        line: a.line,
        col: a.col,
        endCol: b.col + 1,
        value: v,
        escape: t.json ? (t.esc ? "noedit" : "json") : t.quoted ? "noedit" : "shell",
        code: "PM003",
        base: bases[0].dir,
        bases,
        kind: "any",
        glob: isGlob(v) ? "std" : false,
        label: "Dockerfile " + m[1].toUpperCase() + " source",
      });
      if (v.startsWith("/")) {
        r.value = v.replace(/^\/+/, "") || ".";
        r.fmt = "root";
        r.lead = "";
      }
      out.push(r);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function staticPrefix(abs) {
  const parts = abs.split(path.sep);
  const out = [];
  for (const p of parts) {
    if (isGlob(p)) break;
    out.push(p);
  }
  return out.join(path.sep) || path.sep;
}

function checkOne(ref, abs, env) {
  const root = env.guard.rootOf(abs);
  if (!root) return { state: "outside", abs };
  const rel = toPosix(path.relative(root, abs));
  if (env.ignored(abs, root)) return { state: "skip", abs };
  if (ref.glob) {
    const prefix = staticPrefix(abs);
    const ps = env.guard.status(prefix);
    if (ps.state === "outside") return { state: "outside", abs };
    if (env.ignored(prefix, root)) return { state: "skip", abs };
    if (ps.state === "missing") return { state: "glob", abs };
    if (env.index.match(root, globToRegex(rel, ref.glob === "any"), ref.kind)) return { state: "ok", abs, hit: abs };
    return { state: env.index.truncated ? "skip" : "glob", abs };
  }
  if (ref.anywhere) {
    const scope = toPosix(path.relative(root, ref.base));
    if (scope.startsWith("..")) return { state: "skip", abs };
    const name = ref.anywhere.slice(ref.anywhere.lastIndexOf("/") + 1);
    if (env.index.hasName(root, scope, name, ref.kind)) return { state: "ok", abs, hit: abs, anywhere: true };
    return { state: env.index.truncated ? "skip" : "missing", abs, anywhere: true };
  }
  let st = env.guard.status(abs);
  if (st.state === "outside") return { state: "outside", abs };
  let hit = st.state === "missing" ? null : abs;
  if (!hit) {
    for (const a of ref.alts || []) {
      const s2 = env.guard.status(abs + a);
      if (s2.state === "outside") return { state: "outside", abs };
      if (s2.state !== "missing") {
        hit = abs + a;
        st = s2;
        break;
      }
    }
  }
  if (!hit) return { state: "missing", abs, root, rel };
  if (ref.kind === "dir" && st.state !== "dir") return { state: "notdir", abs };
  if (ref.kind === "file" && st.state === "dir") return { state: "notfile", abs };
  if (st.state === "dir" && ref.needFileIn) {
    let found = false;
    for (const nme of ref.needFileIn) {
      const s3 = env.guard.status(path.join(hit, nme));
      if (s3.state === "file") {
        found = true;
        break;
      }
    }
    if (!found) return { state: "noentry", abs };
  }
  return { state: "ok", abs, hit };
}

function evaluateRef(ref, env) {
  const v = ref.value;
  if (!v || hasControl(v) || isUrl(v) || (ref.fmt !== "wsvar" && v.includes("${"))) return { state: "skip" };
  const bases = ref.bases || [{ dir: ref.base, confine: false }];
  let first = null;
  for (const b of bases) {
    const abs = path.resolve(b.dir, v);
    let r;
    if (b.confine && !within(abs, b.dir)) r = { state: "context", abs, ctx: b.dir };
    else {
      if (ref.requireBase) {
        const bs = env.guard.status(b.dir);
        if (bs.state !== "dir") return { state: "skip" };
      }
      r = checkOne(ref, abs, env);
    }
    r.base = b.dir;
    r.confine = b.confine;
    if (r.state === "ok" || r.state === "skip") return r;
    if (!first) first = r;
  }
  return first;
}

function formatPath(ref, newAbs, base) {
  let rel = toPosix(path.relative(base, newAbs));
  if (ref.fmt === "root") rel = "/" + rel;
  else if (ref.fmt === "wsvar") rel = rel ? ref.varPrefix + "/" + rel : ref.varPrefix;
  else if (!rel) rel = ".";
  else if (ref.lead === "./" && !rel.startsWith("../")) rel = "./" + rel;
  if (ref.trail && !rel.endsWith("/")) rel += "/";
  return rel;
}

function encodeFor(ref, text) {
  switch (ref.escape) {
    case "json":
    case "yaml-dq":
      return JSON.stringify(text).slice(1, -1);
    case "yaml-sq":
      return text.replace(/'/g, "''");
    case "plain":
      return /^[-?:,[\]{}#&*!|>'"%@`]|: | #|\s$/.test(text) ? null : text;
    case "shell":
      return /[\s'"$`\\;&|<>()]/.test(text) ? null : text;
    default:
      return null;
  }
}

function relFor(p, roots) {
  for (const r of roots) if (within(p, r.path)) return toPosix(path.relative(r.path, p)) || ".";
  return p;
}

/**
 * analyze({ configs:[{file,text}], roots:[{path,name}], guard, index, settings })
 * settings: { ignoreReferences:[globs], exclude:[globs], disabledRules:[codes], reportOutside:bool }
 */
function analyze(opts) {
  const roots = opts.roots || [];
  const settings = opts.settings || {};
  const disabled = new Set(settings.disabledRules || []);
  const ignoreMatch = makeMatcher([].concat(settings.ignoreReferences || [], settings.exclude || []));
  const ctx = {
    links: new Map(),
    outDirs: [],
    roots,
    inside: (p) => opts.guard.inside(p),
    rootOf: (p) => opts.guard.rootOf(p),
  };
  const order = { compose: 0, tsconfig: 1, dockerfile: 3 };
  const configs = (opts.configs || [])
    .map((c) => Object.assign({}, c, { kind: classify(c.file) }))
    .filter((c) => c.kind)
    .sort((a, b) => (order[a.kind] === undefined ? 2 : order[a.kind]) - (order[b.kind] === undefined ? 2 : order[b.kind]));
  ctx.guard = opts.guard;
  ctx.tsInfo = new Map();
  for (const c of configs) {
    if (c.kind !== "tsconfig") continue;
    try {
      const info = tsInfoOf(c);
      if (info) ctx.tsInfo.set(c.file, info);
    } catch (_) {
      /* unparsable tsconfig: no references */
    }
  }
  const refs = [];
  for (const c of configs) {
    c.starts = lineStarts(c.text);
    c.lines = splitLines(c.text);
    let list = [];
    try {
      if (c.kind === "package") list = extractPackage(c);
      else if (c.kind === "tsconfig") list = extractTsconfig(c, ctx);
      else if (c.kind === "compose") list = extractCompose(c, ctx);
      else if (c.kind === "workflow" || c.kind === "action") list = extractWorkflow(c, c.kind);
      else if (c.kind === "gitlab") list = extractGitlab(c);
      else if (c.kind === "codeowners") list = extractCodeowners(c);
      else if (c.kind === "launch") list = extractLaunch(c, ctx);
      else if (c.kind === "dockerfile") list = extractDockerfile(c, ctx);
    } catch (_) {
      list = [];
    }
    for (const r of list) {
      r.raw = (c.lines[r.line] || "").slice(r.col, r.endCol);
      refs.push(r);
    }
  }
  const env = {
    guard: opts.guard,
    index: opts.index,
    ignored: (abs, root) => {
      if (ctx.outDirs.some((d) => within(abs, d))) return true;
      return ignoreMatch(toPosix(path.relative(root, abs)));
    },
  };
  const findings = [];
  for (const ref of refs) {
    const r = evaluateRef(ref, env);
    ref.result = r;
    if (!r || r.state === "ok" || r.state === "skip") continue;
    const shown = '"' + ref.display + '"';
    let code = ref.code;
    let message;
    let info = false;
    if (r.state === "outside") {
      code = "PM010";
      info = true;
      message = shown + " resolves outside the workspace - not checked (" + ref.label + ")";
      if (settings.reportOutside === false) continue;
    } else if (r.state === "context") {
      code = "PM011";
      message = shown + " is outside the Docker build context " + relFor(r.ctx, roots) + " - the build fails with \"forbidden path outside the build context\" (" + ref.label + ")";
    } else if (r.state === "glob") {
      code = "PM009";
      message = "No files match " + shown + " (" + ref.label + ")";
    } else if (r.state === "notdir") {
      message = shown + " is a file, a folder is expected (" + ref.label + ")";
    } else if (r.state === "notfile") {
      message = shown + " is a folder, a file is expected (" + ref.label + ")";
    } else if (r.state === "noentry") {
      message = shown + " has no " + ref.needFileIn.join(" / ") + " (" + ref.label + ")";
    } else {
      message = "Path not found: " + shown + (r.anywhere ? " (no file or folder with that name)" : "") + " (" + ref.label + ")";
    }
    if (disabled.has(code)) continue;
    let fix = null;
    if (r.state === "missing" && !r.anywhere && r.root && ref.escape !== "noedit") {
      const confine = r.confine ? toPosix(path.relative(r.root, r.base)) : "";
      const best = opts.index.suggest(r.root, r.rel, ref.kind, confine && !confine.startsWith("..") ? confine : "");
      if (best) {
        const newText = formatPath(ref, path.join(r.root, best), r.base);
        if (newText !== ref.display && encodeFor(ref, newText) !== null) fix = newText;
      }
    }
    findings.push({ file: ref.file, line: ref.line, col: ref.col, endCol: ref.endCol, code, message, info, fix, ref });
  }
  return { refs, findings, links: ctx.links };
}

/** Plan edits for references that pointed at a renamed path (computed from the pre-rename scan). */
function planRenames(refs, renames, isInside) {
  const plan = [];
  for (const ref of refs || []) {
    const r = ref.result;
    if (!r || r.state !== "ok" || r.anywhere || ref.escape === "noedit") continue;
    const target = r.hit || r.abs;
    for (const rn of renames) {
      const from = path.resolve(rn.from);
      const to = path.resolve(rn.to);
      if (!(target === from || target.startsWith(from + path.sep))) continue;
      if (ref.file === from || ref.file.startsWith(from + path.sep)) continue;
      let newAbs = to + target.slice(from.length);
      if (r.hit && r.hit !== r.abs) {
        const suffix = r.hit.slice(r.abs.length);
        newAbs = newAbs.endsWith(suffix) ? newAbs.slice(0, -suffix.length) : newAbs;
      }
      if (!isInside(newAbs) || !isInside(ref.file)) continue;
      if (r.confine && !within(newAbs, r.base)) continue;
      const newText = formatPath(ref, newAbs, r.base);
      if (newText === ref.display || encodeFor(ref, newText) === null) continue;
      plan.push({ ref, newText, from, to });
      break;
    }
  }
  return plan;
}

module.exports = {
  RULES,
  classify,
  createGuard,
  FileIndex,
  parseJsonc,
  parseYaml,
  parseDockerfile,
  runTokens,
  globToRegex,
  makeMatcher,
  osa,
  analyze,
  planRenames,
  encodeFor,
  formatPath,
  within,
  toPosix,
};
