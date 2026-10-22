

const KEYWORDS = new Set([
  "auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else", "enum",
  "extern", "float", "for", "goto", "if", "inline", "int", "long", "register", "restrict", "return",
  "short", "signed", "sizeof", "static", "struct", "switch", "typedef", "union", "unsigned", "void",
  "volatile", "while", "_Bool", "bool", "size_t",
]);

// Replace comments, string and char literals with spaces (quotes are kept so
// a literal still reads as one token). Length and newlines are preserved, so
// an index into the result is an index into the original source.
export function blank(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") { out += " "; i++; }
    } else if (c === "/" && d === "*") {
      out += "  "; i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; }
      if (i < n) { out += "  "; i += 2; }
    } else if (c === '"' || c === "'") {
      out += c; i++;
      while (i < n && src[i] !== c && src[i] !== "\n") {
        const take = src[i] === "\\" && i + 1 < n ? 2 : 1;
        out += " ".repeat(take);
        i += take;
      }
      if (i < n && src[i] === c) { out += c; i++; }
    } else { out += c; i++; }
  }
  // Preprocessor lines (and their backslash continuations) carry no runtime
  // structure and may contain braces inside macros: blank them too.
  const lines = out.split("\n");
  let cont = false;
  for (let k = 0; k < lines.length; k++) {
    if (cont || /^\s*#/.test(lines[k])) {
      cont = /\\\s*$/.test(lines[k]);
      lines[k] = " ".repeat(lines[k].length);
    }
  }
  return lines.join("\n");
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (pos) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

// Cyclomatic complexity, counted the way lizard does: 1 + one per decision.
export function cyclomatic(code) {
  const count = (re) => (code.match(re) || []).length;
  return 1 + count(/\b(if|for|while|case)\b/g) + count(/&&|\|\|/g) + count(/\?/g);
}

function maxNesting(body) {
  let depth = 0, max = 0;
  for (const ch of body) {
    if (ch === "{") max = Math.max(max, ++depth);
    else if (ch === "}") depth--;
  }
  return max;
}

function callsIn(body) {
  const names = new Set();
  const re = /\b([A-Za-z_]\w*)\s*\(/g;
  let m;
  while ((m = re.exec(body))) if (!KEYWORDS.has(m[1])) names.add(m[1]);
  return [...names];
}

// Top-level `type name(params) { ... }` blocks.
export function findFunctions(src) {
  const code = blank(src);
  const lineOf = lineIndex(code);
  const fns = [];
  let depth = 0, boundary = 0, open = null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "{") {
      if (depth === 0) {
        const head = code.slice(boundary, i);
        const m = head.match(/([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*$/);
        if (m && !KEYWORDS.has(m[1]) && !/=/.test(head.slice(0, head.lastIndexOf(m[1])))) {
          open = { name: m[1], params: m[2].trim(), nameIdx: boundary + head.lastIndexOf(m[1]), bodyStart: i + 1 };
        }
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        if (open) {
          const body = code.slice(open.bodyStart, i);
          const startLine = lineOf(open.nameIdx), endLine = lineOf(i);
          const nloc = code.split("\n").slice(startLine - 1, endLine).filter((l) => l.trim()).length;
          fns.push({
            name: open.name, params: open.params, startLine, endLine, nloc,
            cyclomatic: cyclomatic(body), nesting: maxNesting(body), calls: callsIn(body),
          });
          open = null;
        }
        boundary = i + 1;
      }
    } else if (ch === ";" && depth === 0) {
      boundary = i + 1;
    }
  }
  return fns;
}
