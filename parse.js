// parse.js — a fast drop-in for marked 18.1.3 (default options: gfm on, breaks off).
// Written from scratch for the make.fun markdown-render-speed-02 bounty. It re-implements
// the rendering behaviour of marked (MIT, github.com/markedjs/marked, tag v18.1.3) as an
// independent implementation; marked itself is the reference the outputs are matched against,
// and its licence is credited in README.md. No marked code is vendored or copied here.
//
// Design: line-based block parsing (one split, cursor over lines, no repeated string
// slicing), two phases (block tokens + link definitions, then render with inline parsing),
// and a single-scan inline parser that jumps between special characters and resolves
// emphasis with the CommonMark delimiter-run algorithm.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

// Text escape: named entities pass through verbatim; numeric references are decoded
// (0, surrogates and >0x10FFFF become U+FFFD; decimal refs are at most 7 digits, hex at
// most 6); any other & becomes &amp;. < > " ' are escaped.
const TEXT_ESC_RE = /&(#\d{1,7};|#[xX][0-9a-fA-F]{1,6};|\w+;)|[&<>"']/g;
const HAS_SPECIAL_RE = /[&<>"']/;
function escapeText(s) {
  if (!HAS_SPECIAL_RE.test(s)) return s;
  return s.replace(TEXT_ESC_RE, (m, ent) => {
    if (ent !== undefined) {
      if (ent[0] === '#') {
        let cp;
        if (ent[1] === 'x' || ent[1] === 'X') cp = parseInt(ent.slice(2, -1), 16);
        else cp = parseInt(ent.slice(1, -1), 10);
        if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
        const ch = String.fromCodePoint(cp);
        return ESC_MAP[ch] || ch;
      }
      return m; // named entity, verbatim
    }
    return ESC_MAP[m];
  });
}

// Attribute escape (hrefs, titles, fence languages): entities pass through verbatim,
// including numeric ones (never decoded here); bare & and < > " ' are escaped.
const ATTR_ESC_RE = /&(#\d+;|#[xX][0-9a-fA-F]+;|\w+;)|[&<>"']/g;
function escapeAttr(s) {
  if (!HAS_SPECIAL_RE.test(s)) return s;
  return s.replace(ATTR_ESC_RE, (m, ent) => (ent !== undefined ? m : ESC_MAP[m]));
}

// Code escape: everything is escaped, entities are NOT decoded or passed through.
const CODE_ESC_RE = /[&<>"']/g;
function escapeCode(s) {
  if (!HAS_SPECIAL_RE.test(s)) return s;
  return s.replace(CODE_ESC_RE, (ch) => ESC_MAP[ch]);
}

// URL cleaning for link/image destinations: percent-encode like encodeURI (spaces become
// %20), %25 folds back to %, then attribute-escape. Returns null when the URL cannot be
// encoded (lone surrogate), which makes the link fail.
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return escapeAttr(href);
}

// ---------------------------------------------------------------------------
// Line helpers (tabs advance to the next multiple of 4 columns)
// ---------------------------------------------------------------------------

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Columns of leading whitespace (spaces count 1, tabs advance to the next multiple of 4).
function indentCols(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Index of the first non-space/tab character (line.length when blank).
function firstNonWs(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  return i;
}

// Column of the character at index `at` (tabs expanded from the line start).
function colAt(line, at) {
  let col = 0;
  for (let i = 0; i < at && i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4 - (col % 4);
    else col++;
  }
  return col;
}

// Remove `cols` columns of whitespace starting at index `at` (whose column is computed
// from the line start). Tab widths are measured from their position in the ORIGINAL
// line: a tab straddling the cut leaves spaces for its remainder, and tabs in the
// remaining leading whitespace are expanded to spaces (using original columns)
// whenever the removal shifts tab alignment, so their widths survive the cut.
function stripCols(line, at, cols, expandRest) {
  let col = colAt(line, at);
  const startCol = col;
  const target = col + cols;
  let i = at;
  let out = '';
  while (i < line.length && col < target) {
    const c = line.charCodeAt(i);
    if (c === 32) { i++; col++; }
    else if (c === 9) {
      const next = col + 4 - (col % 4);
      if (next <= target) { i++; col = next; }
      else {
        out = ' '.repeat(next - target);
        i++;
        col = next;
        break;
      }
    } else break;
  }
  // Expand tabs in the remaining leading whitespace (measured from original columns)
  // whenever the removal shifted tab alignment, a tab straddled the cut, or the
  // caller wants marked's list behavior (J() expands ALL leading tabs before
  // the content indent is sliced off).
  const removed = col - startCol;
  if (expandRest || removed % 4 !== 0 || out !== '') {
    let j = i;
    let c2 = col;
    while (j < line.length) {
      const ch = line.charCodeAt(j);
      if (ch === 32) { out += ' '; j++; c2++; }
      else if (ch === 9) {
        const n2 = c2 + 4 - (c2 % 4);
        out += ' '.repeat(n2 - c2);
        c2 = n2;
        j++;
      } else break;
    }
    if (j > i || out !== '') return out + line.slice(j);
  }
  return line.slice(i);
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

// Block tag names for HTML block type 6 (CommonMark list).
const BLOCK_TAGS = new Set(
  ('address article aside base basefont blockquote body caption center col colgroup dd ' +
   'details dialog dir div dl dt fieldset figcaption figure footer form frame frameset ' +
   'h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav ' +
   'noframes ol optgroup option p param search section summary table tbody td tfoot th ' +
   'thead title tr track ul').split(' '),
);

// Match an ATX heading line. Returns [level, text] or null.
function matchAtx(line) {
  const ind = indentCols(line);
  if (ind >= 4) return null;
  const i = firstNonWs(line);
  let j = i;
  while (j < line.length && line.charCodeAt(j) === 35) j++; // '#'
  const level = j - i;
  if (level === 0 || level > 6) return null;
  if (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  let text = line.slice(j).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  // Closing sequence: only hashes, preceded by a space. When the whole text is
  // hashes, it is the closing sequence (it was preceded by the space after the
  // opening marker).
  if (/^#+$/.test(text)) text = '';
  else {
    const m = /[ \t]+#+$/.exec(text);
    if (m) text = text.slice(0, m.index).replace(/[ \t]+$/, '');
  }
  return [level, text];
}

// Match a thematic break line.
function isHr(line) {
  const ind = indentCols(line);
  if (ind >= 4) return false;
  const i = firstNonWs(line);
  if (i >= line.length) return false;
  const ch = line[i];
  if (ch !== '*' && ch !== '-' && ch !== '_') return false;
  let count = 0;
  for (let j = i; j < line.length; j++) {
    const c = line[j];
    if (c === ch) count++;
    else if (c !== ' ' && c !== '\t') return false;
  }
  return count >= 3;
}

// Match a setext underline line. Returns 1 for '=', 2 for '-', 0 otherwise.
function setextLevel(line) {
  const ind = indentCols(line);
  if (ind >= 4) return 0;
  const i = firstNonWs(line);
  if (i >= line.length) return 0;
  const ch = line[i];
  if (ch !== '=' && ch !== '-') return 0;
  // The underline is a run of = or - followed only by trailing whitespace; no
  // spaces are allowed inside the run (unlike a thematic break).
  let j = i;
  while (j < line.length && line[j] === ch) j++;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  if (j < line.length) return 0;
  return ch === '=' ? 1 : 2;
}

// Match a fence opening line. Returns {ch, len, info, indent} or null.
function matchFence(line) {
  const ind = indentCols(line);
  if (ind >= 4) return null;
  const i = firstNonWs(line);
  if (i >= line.length) return null;
  const ch = line[i];
  if (ch !== '`' && ch !== '~') return null;
  let j = i;
  while (j < line.length && line[j] === ch) j++;
  const len = j - i;
  if (len < 3) return null;
  const info = line.slice(j).trim();
  if (ch === '`' && info.indexOf('`') !== -1) return null;
  return { ch, len, info, indent: ind };
}

// Match a fence closing line for the given opening fence.
function isFenceClose(line, fence) {
  const ind = indentCols(line);
  if (ind >= 4) return false;
  const i = firstNonWs(line);
  let j = i;
  while (j < line.length && line[j] === fence.ch) j++;
  if (j - i < fence.len) return false;
  for (let k = j; k < line.length; k++) {
    const c = line[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// Match a blockquote marker. Returns the index just past '>' or -1.
function quoteMarker(line) {
  const ind = indentCols(line);
  if (ind >= 4) return -1;
  const i = firstNonWs(line);
  if (i < line.length && line.charCodeAt(i) === 62) return i + 1; // '>'
  return -1;
}

// Match a list item marker. Returns {ordered, bullet, delim, num, markerEnd, contentIndent}
// or null. markerEnd is the index just past the marker; contentIndent is the column where
// the item's content starts.
function matchListMarker(line) {
  const ind = indentCols(line);
  if (ind >= 4) return null;
  const i = firstNonWs(line);
  if (i >= line.length) return null;
  const c = line.charCodeAt(i);
  let ordered = false;
  let bullet = '';
  let delim = '';
  let num = 0;
  let j = i;
  if (c === 45 || c === 43 || c === 42) { // - + *
    bullet = line[i];
    j = i + 1;
  } else if (c >= 48 && c <= 57) {
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    const digits = j - i;
    if (digits > 9) return null;
    if (j >= line.length || (line[j] !== '.' && line[j] !== ')')) return null;
    delim = line[j];
    num = parseInt(line.slice(i, j), 10);
    j++;
    ordered = true;
  } else return null;
  // After the marker there must be a space/tab, or end of line.
  if (j < line.length) {
    const d = line.charCodeAt(j);
    if (d !== 32 && d !== 9) return null;
  }
  // Content indent: marker width + following whitespace. Spaces count normally
  // (1-4 count, 5+ counts as 1). If the whitespace run contains a tab, the content
  // indent is marker width + 1 regardless of the spaces before the tab; the rest of
  // the tab's width stays in the content.
  // An empty item (nothing but spaces to EOL) has content indent marker width + 1.
  const markerCol = colAt(line, i);
  const afterCol = colAt(line, j);
  let k = j;
  let spaces = 0;
  let hasTab = false;
  while (k < line.length) {
    const d = line.charCodeAt(k);
    if (d === 32) { spaces++; k++; }
    else if (d === 9) { hasTab = true; k++; break; }
    else break;
  }
  const empty = k >= line.length;
  let contentIndent;
  if (empty) {
    contentIndent = afterCol + 1;
  } else if (hasTab) {
    contentIndent = afterCol + 1;
  } else if (spaces >= 1 && spaces <= 4) {
    contentIndent = afterCol + spaces;
  } else if (spaces === 0) {
    contentIndent = afterCol;
  } else {
    contentIndent = afterCol + 1;
  }
  return { ordered, bullet, delim, num, markerEnd: j, contentIndent, empty };
}

// Match a table delimiter row. Returns the alignments array or null.
function matchTableDelim(line) {
  const ind = indentCols(line);
  if (ind >= 4) return null;
  let s = line.slice(firstNonWs(line));
  s = s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (s.length === 0) return null;
  if (s.charCodeAt(0) === 124) s = s.slice(1); // leading |
  if (s.length > 0 && s.charCodeAt(s.length - 1) === 124) s = s.slice(0, -1);
  if (s.length === 0) return null;
  const cells = s.split('|');
  const aligns = [];
  for (let cell of cells) {
    cell = cell.trim();
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.charCodeAt(0) === 58;
    const right = cell.charCodeAt(cell.length - 1) === 58;
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

// Split a table row into cells on unescaped pipes; \| becomes | (before inline parsing).
function splitTableRow(line) {
  let s = line.slice(firstNonWs(line));
  s = s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (s.charCodeAt(0) === 124) s = s.slice(1);
  if (s.length > 0 && s.charCodeAt(s.length - 1) === 124) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && s[i + 1] === '|') { cur += '|'; i++; }
    else if (c === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

// Marked's Dt for fenced code: strip up to `indent` characters (char count,
// not columns) of leading whitespace from a content line. A tab counts as
// one character here, unlike the column-based stripCols.
function stripFenceIndent(line, indent) {
  if (indent <= 0) return line;
  const m = /^\s+/.exec(line);
  if (!m) return line;
  return line.slice(Math.min(m[0].length, indent));
}
// must match, must not be a setext underline (setext wins), must have the same cell
// count as the header, and the header must have at least one non-empty cell.
// Returns the alignments array, or null.
function isTableHeader(headerLine, delimLine) {
  if (setextLevel(delimLine) > 0) return null;
  const aligns = matchTableDelim(delimLine);
  if (!aligns) return null;
  const head = splitTableRow(headerLine);
  if (head.length !== aligns.length) return null;
  if (!head.some((c) => c !== '')) return null;
  return aligns;
}

// Does this line start an HTML block? Returns the type (1-7) or 0.
function htmlBlockType(line) {
  const ind = indentCols(line);
  if (ind >= 4) return 0;
  const i = firstNonWs(line);
  if (i >= line.length || line.charCodeAt(i) !== 60) return 0; // '<'
  const rest = line.slice(i);
  // Type 1: pre, script, style, textarea.
  let m = /^<(pre|script|style|textarea)([\s>]|$)/i.exec(rest);
  if (m) return 1;
  // Type 2: comment.
  if (rest.startsWith('<!--')) return 2;
  // Type 3: processing instruction.
  if (rest.startsWith('<?')) return 3;
  // Type 4: declaration.
  if (/^<![A-Z]/.test(rest)) return 4;
  // Type 5: CDATA.
  if (rest.startsWith('<![CDATA[')) return 5;
  // Type 6: block tag.
  m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)([\s/>]|$)/.exec(rest);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
  // Type 7: a complete open tag (attributes allowed) or close tag (name only,
  // no attributes) alone on the line.
  if (/^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>[ \t]*$/.test(rest)) return 7;
  if (/^<\/[a-zA-Z][a-zA-Z0-9-]*[ \t]*>[ \t]*$/.test(rest)) return 7;
  return 0;
}

// Can this line start a block that interrupts a paragraph? (ATX, fence, hr, blockquote,
// interrupting list, HTML types 1-6.)
function interruptsParagraph(line, inListItem) {
  if (isBlank(line)) return true;
  if (matchAtx(line)) return true;
  if (matchFence(line)) return true;
  if (isHr(line)) return true;
  if (quoteMarker(line) !== -1) return true;
  const lm = matchListMarker(line);
  // A list interrupts a paragraph, except an empty item and an ordered list not
  // starting at 1. Inside a list item, marked lets any ordered list interrupt.
  if (lm && !lm.empty && (!lm.ordered || lm.num === 1 || inListItem)) return true;
  const ht = htmlBlockType(line);
  if (ht >= 1 && ht <= 6) return true;
  return false;
}

// Can this line end a table body? Marked's table regex accepts ANY line as a
// body row (even one without pipes) unless it is blank, an hr, an ATX heading,
// a blockquote, indented code, a fence, a list item, or an HTML block start
// (types 1-6). Note the blank test is spaces-only: a tab-only line is a row
// (the regex's blank lookahead is ` *\n`, spaces only).
function interruptsTable(line) {
  if (/^ *$/.test(line)) return true;
  if (isHr(line)) return true;
  if (matchAtx(line)) return true;
  if (quoteMarker(line) !== -1) return true;
  if (/^(?: {4}| {0,3}\t)./.test(line)) return true;
  if (matchFence(line)) return true;
  if (/^ {0,3}(?:[*+-]|1[.)])[ \t]/.test(line)) return true;
  const ht = htmlBlockType(line);
  if (ht >= 1 && ht <= 6) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

// Normalize a link label: collapse whitespace runs to one space, trim, lowercase.
function normalizeLabel(label) {
  // Case folding like marked: lower -> upper -> lower folds ẞ/ß to "ss".
  return label.replace(/\s+/g, ' ').trim().toLowerCase().toUpperCase().toLowerCase();
}

// Parse a link destination starting at `s` (index `i`). Returns {dest, next} where next
// is the index just past the destination, or null. Handles <...> and bare destinations
// (balanced parens, no spaces or control characters).
function parseDest(s, i) {
  const n = s.length;
  if (i < n && s.charCodeAt(i) === 60) { // '<'
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = s[j];
      if (c === '>') return { dest: out, next: j + 1 };
      if (c === '\n' || c === '<') return null;
      if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
      out += c;
      j++;
    }
    return null;
  }
  let depth = 0;
  let j = i;
  let out = '';
  while (j < n) {
    const c = s[j];
    if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
    if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (c === '(') { depth++; out += c; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; out += c; j++; continue;
    }
    out += c;
    j++;
  }
  if (j === i) return null;
  return { dest: out, next: j };
}

// Parse a link title starting at `s` (index `i`). Returns {title, next} or null.
// Titles are "..." or '...' or (...); the delimiter may not appear unescaped inside
// (paren titles may not contain an unescaped open paren either).
function parseTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let j = i + 1;
  let out = '';
  while (j < n) {
    const c = s[j];
    if (c === close) return { title: out, next: j + 1 };
    if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { out += s[j + 1]; j += 2; continue; }
    if (q === '(' && c === '(') return null;
    out += c;
    j++;
  }
  return null;
}

function isAsciiPunct(ch) {
  return /[!-/:-@\[-`{-~]/.test(ch);
}

// Try to parse a link reference definition starting at lines[i]. The definition may span
// up to 3 lines (label line, destination line, title line). Returns {lines: count, label,
// href, title} or null.
// Parse a link reference definition starting at lines[i]. The definition may span
// lines (the label, destination, and title can each start on following lines, and
// the title may span lines), but not a blank line. Returns
// {lines, label, href, title} or null.
function parseDef(lines, i) {
  const line = lines[i];
  const ind = indentCols(line);
  if (ind >= 4) return null;
  const start = firstNonWs(line);
  if (line.charCodeAt(start) !== 91) return null; // '['
  // Join lines until a blank line (cap 50 lines) into one string for parsing.
  let text = line.slice(start);
  let j = i + 1;
  let joined = 1;
  while (j < lines.length && joined < 50 && !isBlank(lines[j])) {
    text += '\n' + lines[j];
    joined++;
    j++;
  }
  const n = text.length;
  // Label: [ ... ] with backslash escapes and balanced nested brackets.
  let depth = 0;
  let k = 0;
  let labelEnd = -1;
  while (k < n) {
    const c = text[k];
    if (c === '\\' && k + 1 < n && isAsciiPunct(text[k + 1])) { k += 2; continue; }
    if (c === '[') { depth++; k++; continue; }
    if (c === ']') {
      depth--;
      if (depth === 0) { labelEnd = k; break; }
      k++;
      continue;
    }
    k++;
  }
  if (labelEnd === -1) return null;
  const labelRaw = text.slice(1, labelEnd);
  if (labelRaw.length === 0 || labelRaw.length > 999) return null;
  // A label must not contain an unescaped [ or ] (balanced or not), and must
  // not be empty once whitespace is folded.
  for (let q = 0; q < labelRaw.length; q++) {
    if (labelRaw[q] === '\\') { q++; continue; }
    if (labelRaw[q] === '[' || labelRaw[q] === ']') return null;
  }
  if (normalizeLabel(labelRaw).length === 0) return null;
  k = labelEnd + 1;
  if (k >= n || text.charCodeAt(k) !== 58) return null; // ':'
  k++;
  // Skip whitespace (spaces, tabs, newlines) to the destination.
  while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9 || text.charCodeAt(k) === 10)) k++;
  if (k >= n) return null;
  const d = parseDest(text, k);
  if (!d) return null;
  k = d.next;
  let title = null;
  let kEnd = k;
  // After the destination, only whitespace may follow on the line, then an optional
  // title. A title must be preceded by whitespace (so <bar>(baz) is not a
  // definition). A title on the SAME line must parse cleanly or the definition
  // fails; a title on the NEXT line is only taken when it parses cleanly, otherwise
  // the definition simply has no title.
  if (k < n && text.charCodeAt(k) !== 32 && text.charCodeAt(k) !== 9 && text.charCodeAt(k) !== 10) return null;
  while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
  if (k >= n || text.charCodeAt(k) === 10) {
    // End of the destination line: the title may be on the next line.
    let k2 = k;
    if (k2 < n && text.charCodeAt(k2) === 10) k2++;
    while (k2 < n && (text.charCodeAt(k2) === 32 || text.charCodeAt(k2) === 9)) k2++;
    if (k2 < n && (text[k2] === '"' || text[k2] === "'" || text[k2] === '(')) {
      const t = parseTitle(text, k2);
      if (t) {
        let k3 = t.next;
        while (k3 < n && (text.charCodeAt(k3) === 32 || text.charCodeAt(k3) === 9)) k3++;
        if (k3 >= n || text.charCodeAt(k3) === 10) {
          title = t.title;
          kEnd = t.next;
        }
        // Otherwise the next line is not a title; the definition has no title.
      }
    }
  } else if (text[k] === '"' || text[k] === "'" || text[k] === '(') {
    // Title on the same line: it must parse cleanly or the definition fails.
    const t = parseTitle(text, k);
    if (!t) return null;
    title = t.title;
    k = t.next;
    kEnd = k;
    while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
    if (k < n && text.charCodeAt(k) !== 10) return null;
  } else {
    return null; // Trailing junk after the destination.
  }
  // Count the lines the definition used (newlines before the end of dest/title).
  let linesUsed = 1;
  for (let p = 0; p < kEnd; p++) if (text.charCodeAt(p) === 10) linesUsed++;
  return { lines: linesUsed, label: normalizeLabel(labelRaw), href: d.dest, title };
}

// ---------------------------------------------------------------------------
// Block tokenizer: lines -> tokens
// ---------------------------------------------------------------------------

// Token shapes:
//  {t:'h', d:depth, x:text}            heading (x = raw inline text)
//  {t:'p', x:text}                     paragraph
//  {t:'c', x:text, l:lang|null}        code block (x ends with \n unless empty)
//  {t:'r'}                             thematic break
//  {t:'q', b:[tokens]}                 blockquote
//  {t:'l', o:ordered, s:start, items:[{task, checked, b:[tokens]}]}
//  {t:'H', x:raw}                      raw HTML block
//  {t:'T', a:[align], h:[cells], b:[[cells]]}  table

// `noSetext` is an optional Set of line indices (into `lines`) that must not be
// treated as setext underlines: lazy continuation lines that look like underlines
// are paragraph text, not headings. `lazyLines` is an optional Set of line indices
// that are lazy continuations: paragraph text even when they look like block starts.
// `followedByBlank` says the source line just past this array is blank (relevant
// for HTML trailing newlines in containers). `extendsToEof` says this array runs to
// the end of the input.
function blockTokens(lines, links, lastTerminated, followedByBlank, extendsToEof, noSetext, lazyLines, inListItem) {
  const tokens = [];
  let loose = false;
  let pendingBlank = false;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { pendingBlank = true; i++; continue; }
    // A blank line between two top-level blocks makes the content loose (this is
    // what list items use; blank lines nested inside a sub-block do not count).
    if (pendingBlank && tokens.length > 0) loose = true;
    pendingBlank = false;

    // Indented code.
    if (indentCols(line) >= 4) {
      const start = i;
      let last = i;
      i++;
      while (i < n) {
        if (isBlank(lines[i])) { i++; continue; }
        if (indentCols(lines[i]) >= 4) { last = i; i++; continue; }
        break;
      }
      const parts = [];
      for (let k = start; k <= last; k++) {
        // Blank lines inside the block keep their content past 4 columns of indent.
        parts.push(stripCols(lines[k], 0, 4));
      }
      let text = parts.join('\n');
      if (text.length > 0) text += '\n';
      tokens.push({ t: 'c', x: text, l: null });
      i = last + 1;
      continue;
    }

    // Fenced code.
    const fence = matchFence(line);
    if (fence) {
      const start = i;
      i++;
      const content = [];
      let closed = false;
      while (i < n) {
        if (isFenceClose(lines[i], fence)) { closed = true; i++; break; }
        // Marked's Dt strips up to the fence's indent in characters from
        // every content line (blank lines included) — but its
        // indentCodeCompensation regex only matches backtick fences, so a
        // tilde fence keeps its content indent untouched.
        content.push(fence.ch === '`' ? stripFenceIndent(lines[i], fence.indent) : lines[i]);
        i++;
      }
      let text = content.join('\n');
      // Marked's fence regex consumes the newline before the closing fence,
      // and its renderer strips one trailing newline (if any) before adding
      // one back: a fence whose content ends with a blank line loses one
      // newline, and a fence with only a single blank line is empty.
      if (text.length > 0) {
        if (text.endsWith('\n')) text = text.slice(0, -1);
        text += '\n';
      }
      const lang = fence.info.length > 0 ? fence.info.split(/\s+/)[0] : null;
      tokens.push({ t: 'c', x: text, l: lang });
      continue;
    }

    // ATX heading.
    const atx = matchAtx(line);
    if (atx) {
      tokens.push({ t: 'h', d: atx[0], x: atx[1] });
      i++;
      continue;
    }

    // Thematic break.
    if (isHr(line)) {
      tokens.push({ t: 'r' });
      i++;
      continue;
    }

    // Blockquote.
    if (quoteMarker(line) !== -1) {
      const inner = [];
      const noSetext = new Set();
      const lazyLines = new Set();
      let lastSrcIdx = i;
      let lazyCount = 0;
      let lastIsLazySetext = false;
      // A fenced code block open inside the quote: lazy continuation lines
      // cannot continue it (they can only continue a paragraph), so a line
      // without a > marker ends the quote while a fence is open.
      let openFence = null;
      while (i < n) {
        const qm = quoteMarker(lines[i]);
        if (qm !== -1) {
          const rest = lines[i].slice(qm);
          inner.push(rest.length > 0 && (rest.charCodeAt(0) === 32 || rest.charCodeAt(0) === 9)
            ? stripCols(lines[i], qm, 1) : rest);
          if (inner[inner.length - 1] !== '') lastSrcIdx = i;
          lastIsLazySetext = false;
          const pushed = inner[inner.length - 1];
          if (openFence) {
            if (isFenceClose(pushed, openFence)) openFence = null;
          } else {
            const f = matchFence(pushed);
            if (f) openFence = f;
          }
          i++;
          continue;
        }
        if (isBlank(lines[i])) {
          // A blank line without a > marker ends the blockquote.
          break;
        }
        // Lazy continuation: a plain line continuing the quote's innermost open
        // paragraph. A setext underline is also a lazy line, but it stays paragraph
        // text: it never forms a heading, and (marked quirk) when it follows
        // another lazy line it is indented by four spaces. A lazy line indented by
        // four or more columns loses four columns (the indented-code indent).
        if (!openFence && (inner.length > 0 && (isParagraphLine(innermostLine(inner[inner.length - 1])) || lastIsLazySetext)) && !interruptsParagraph(lines[i])) {
          let lazyLine = lines[i];
          if (indentCols(lazyLine) >= 4) lazyLine = stripCols(lazyLine, 0, 4);
          lazyLines.add(inner.length);
          if (setextLevel(lazyLine) > 0) {
            if (lazyCount > 0) {
              inner.push('    ' + lazyLine.replace(/^[ \t]+/, ''));
            } else {
              noSetext.add(inner.length);
              inner.push(lazyLine);
            }
            lastIsLazySetext = true;
          } else {
            inner.push(lazyLine);
            lastIsLazySetext = false;
          }
          lastSrcIdx = i;
          lazyCount++;
          i++;
          continue;
        }
        break;
      }
      // Drop trailing empty lines from the quote content (a trailing line with only
      // spaces is paragraph content, not a blank line).
      while (inner.length > 0 && inner[inner.length - 1] === '') inner.pop();
      const innerTerminated = lastSrcIdx < n - 1 || lastTerminated;
      // Blank lines between the last content line and the end of the quote were
      // dropped above; the inner array is followed by a blank line in that case,
      // or (when the quote runs to the end of this array) by whatever follows it.
      const innerFollowedByBlank = i > lastSrcIdx + 1 || (i >= n && followedByBlank);
      const innerExtendsToEof = extendsToEof && lastSrcIdx === n - 1;
      tokens.push({ t: 'q', b: blockTokens(inner, links, innerTerminated, innerFollowedByBlank, innerExtendsToEof, noSetext.size > 0 ? noSetext : null, lazyLines.size > 0 ? lazyLines : null).tokens });
      continue;
    }

    // List.
    const lm = matchListMarker(line);
    if (lm) {
      const res = parseList(lines, i, links, lastTerminated, followedByBlank, extendsToEof);
      tokens.push(res.token);
      // The list consumed trailing blank lines after its last item; they
      // still separate this list from the next block.
      if (res.trailingBlank) pendingBlank = true;
      i = res.next;
      continue;
    }

    // HTML block.
    const ht = htmlBlockType(line);
    if (ht >= 1) {
      const start = i;
      let end = i; // inclusive index of the last consumed line
      let raw;
      if (ht === 1) {
        const tag = /^<\/?(pre|script|style|textarea)/i.exec(line.slice(firstNonWs(line)))[1].toLowerCase();
        const closeRe = new RegExp('</' + tag + '[\\s>]', 'i');
        if (closeRe.test(line)) {
          // The block opens and closes on the same line.
          end = i;
          i++;
        } else {
          i++;
          while (i < n) {
            if (closeRe.test(lines[i])) { end = i; i++; break; }
            end = i;
            i++;
          }
        }
        raw = htmlRaw(lines, start, end, i, lastTerminated, followedByBlank);
      } else if (ht === 2) {
        if (line.indexOf('-->') !== -1) { end = i; i++; }
        else {
          i++;
          while (i < n) {
            if (lines[i].indexOf('-->') !== -1) { end = i; i++; break; }
            end = i;
            i++;
          }
        }
        raw = htmlRaw(lines, start, end, i, lastTerminated, followedByBlank);
      } else if (ht === 3) {
        if (line.indexOf('?>') !== -1) { end = i; i++; }
        else {
          i++;
          while (i < n) {
            if (lines[i].indexOf('?>') !== -1) { end = i; i++; break; }
            end = i;
            i++;
          }
        }
        raw = htmlRaw(lines, start, end, i, lastTerminated, followedByBlank);
      } else if (ht === 4) {
        if (line.indexOf('>') !== -1) { end = i; i++; }
        else {
          i++;
          while (i < n) {
            if (lines[i].indexOf('>') !== -1) { end = i; i++; break; }
            end = i;
            i++;
          }
        }
        raw = htmlRaw(lines, start, end, i, lastTerminated, followedByBlank);
      } else if (ht === 5) {
        if (line.indexOf(']]>') !== -1) { end = i; i++; }
        else {
          i++;
          while (i < n) {
            if (lines[i].indexOf(']]>') !== -1) { end = i; i++; break; }
            end = i;
            i++;
          }
        }
        raw = htmlRaw(lines, start, end, i, lastTerminated, followedByBlank);
      } else {
        // Types 6-7: consume until a blank line or EOF. A block cut short by a blank
        // line carries no trailing newline; one that runs to the end of the INPUT
        // keeps the final newline when the last line was terminated.
        i++;
        while (i < n && !isBlank(lines[i])) { end = i; i++; }
        raw = lines.slice(start, end + 1).join('\n');
        if (i >= n && extendsToEof && lastTerminated) raw += '\n';
      }
      tokens.push({ t: 'H', x: raw });
      continue;
    }

    // Link reference definition.
    const def = parseDef(lines, i);
    if (def) {
      if (!links.has(def.label)) links.set(def.label, { href: def.href, title: def.title });
      i += def.lines;
      continue;
    }

    // Table: this line is the header row when the next line is a delimiter row that
    // matches it (same cell count, not a setext underline, header not all empty).
    if (i + 1 < n) {
      const aligns = isTableHeader(line, lines[i + 1]);
      if (aligns) {
        const head = splitTableRow(line);
        const body = [];
        i += 2;
        while (i < n && !interruptsTable(lines[i])) {
          body.push(splitTableRow(lines[i]));
          i++;
        }
        tokens.push({ t: 'T', a: aligns, h: head, b: body });
        continue;
      }
    }

    // Setext heading: one or more paragraph lines followed by an underline.
    {
      let j = i;
      let textLines = [];
      while (j < n && !isBlank(lines[j]) && !interruptsParagraph(lines[j], inListItem) && setextLevel(lines[j]) === 0) {
        textLines.push(lines[j]);
        j++;
      }
      if (textLines.length > 0 && j < n) {
        const lvl = setextLevel(lines[j]);
        if (lvl > 0 && !(noSetext && noSetext.has(j))) {
          // Setext heading text is trimmed (leading whitespace of the first line,
          // trailing whitespace of the last line).
          tokens.push({ t: 'h', d: lvl, x: textLines.join('\n').trim() });
          i = j + 1;
          continue;
        }
      }
    }

    // Paragraph: lines until a blank line or an interrupting block start.
    {
      const start = i;
      i++;
      while (i < n) {
        // A whitespace-only line is blank, except a non-empty one on the last line,
        // which is paragraph content (it has no newline after it).
        if (isBlank(lines[i])) {
          if (i === n - 1 && lines[i].length > 0) { i++; continue; }
          break;
        }
        // A lazy continuation line is paragraph text even when it looks like a
        // block start.
        if (lazyLines && lazyLines.has(i)) { i++; continue; }
        if (interruptsParagraph(lines[i], inListItem)) break;
        if (setextLevel(lines[i]) > 0 && !(noSetext && noSetext.has(i))) break;
        // A line followed by a table delimiter row starts a table, not a paragraph
        // line (but a setext underline is not a table delimiter here).
        if (i + 1 < n && matchTableDelim(lines[i + 1]) && setextLevel(lines[i + 1]) === 0) break;
        i++;
      }
      tokens.push({ t: 'p', x: lines.slice(start, i).join('\n') });
      continue;
    }
  }
  return { tokens, loose };
}

// Raw text of an HTML block (types 1-5) spanning lines[start..end]. `nextIdx` is the
// index of the line after the block. A trailing newline is included unless the block
// is followed by a blank line (in this array, or in the source just past this array).
function htmlRaw(lines, start, end, nextIdx, lastTerminated, followedByBlank) {
  let raw = lines.slice(start, end + 1).join('\n');
  let addNl;
  // Marked keeps the newline after an HTML block unless the next line is
  // empty; a whitespace-only line (spaces or tab) still keeps it.
  if (nextIdx < lines.length) addNl = lines[nextIdx].length > 0;
  else addNl = !followedByBlank && lastTerminated;
  if (addNl) raw += '\n';
  return raw;
}

// Strip leading blockquote markers and list markers to find the innermost content
// line (for lazy-continuation checks: a lazy line continues the innermost open
// paragraph, which may sit inside nested quotes and lists).
function innermostLine(line) {
  let s = line;
  for (;;) {
    const qm = quoteMarker(s);
    if (qm !== -1) {
      const rest = s.slice(qm);
      s = rest.length > 0 && (rest.charCodeAt(0) === 32 || rest.charCodeAt(0) === 9) ? stripCols(s, qm, 1) : rest;
      continue;
    }
    const lm = matchListMarker(s);
    if (lm && !isHr(s)) {
      if (lm.empty) return '';
      s = stripCols(s, lm.markerEnd, lm.contentIndent - colAt(s, lm.markerEnd));
      continue;
    }
    return s;
  }
}

// Is this line a plain paragraph line (not a block start of any kind)? Used to decide
// whether a lazy continuation line may join an open paragraph.
function isParagraphLine(line) {
  if (isBlank(line)) return false;
  if (indentCols(line) >= 4) return false;
  if (matchAtx(line)) return false;
  if (matchFence(line)) return false;
  if (isHr(line)) return false;
  if (quoteMarker(line) !== -1) return false;
  if (matchListMarker(line)) return false;
  if (htmlBlockType(line) >= 1) return false;
  if (setextLevel(line) > 0) return false;
  if (matchTableDelim(line)) return false;
  return true;
}

// Parse a list starting at lines[i]. Returns {token, next}.
function parseList(lines, i, links, lastTerminated, followedByBlank, extendsToEof) {
  const n = lines.length;
  const first = matchListMarker(lines[i]);
  const ordered = first.ordered;
  const bullet = first.bullet;
  const delim = first.delim;
  const startNum = first.num;
  const items = [];
  let loose = false;
  // Trailing blanks consumed after the last item: the parent needs to know
  // about them (a blank line between this list and the next block makes the
  // parent content loose).
  let lastTrailingBlanks = 0;
  while (i < n) {
    // A single blank line after an empty item does not end the list when an
    // item of the same list follows (the empty item's collection stops at
    // the blank, so it is not consumed as a trailing blank). Two blank
    // lines do end the list.
    if (isBlank(lines[i])) {
      if (i + 1 < n && !isBlank(lines[i + 1])) {
        const nm0 = matchListMarker(lines[i + 1]);
        if (nm0 && nm0.ordered === ordered && (ordered ? nm0.delim === delim : nm0.bullet === bullet) && !isHr(lines[i + 1])) {
          loose = true;
          i++;
        } else {
          break;
        }
      } else {
        break;
      }
    }
    const lm = matchListMarker(lines[i]);
    if (!lm) break;
    // A thematic break takes precedence over a list item (* * *, - - -, ...).
    if (isHr(lines[i])) break;
    if (lm.ordered !== ordered) break;
    if (ordered) {
      if (lm.delim !== delim) break;
    } else {
      if (lm.bullet !== bullet) break;
    }
    // One item: collect its lines.
    const contentIndent = lm.contentIndent;
    const itemLines = [];
    const itemNoSetext = new Set();
    const itemLazyLines = new Set();
    // First line: the content after the marker.
    let firstLine = '';
    if (!lm.empty) {
      firstLine = stripCols(lines[i], lm.markerEnd, contentIndent - colAt(lines[i], lm.markerEnd), true);
    }
    itemLines.push(firstLine);
    i++;
    let lastSrcIdx = i - 1;
    let seenContent = !isBlank(firstLine);
    let lastIsLazySetext = false;
    while (i < n) {
      const l = lines[i];
      if (isBlank(l)) {
        // An empty item (no content yet) ends at a blank line; otherwise the blank
        // line is part of the item (and makes it loose when content follows).
        if (!seenContent) break;
        itemLines.push('');
        lastIsLazySetext = false;
        i++;
        continue;
      }
      const ind = indentCols(l);
      if (ind >= contentIndent) {
        const stripped = stripCols(l, 0, contentIndent, true);
        itemLines.push(stripped);
        lastIsLazySetext = false;
        if (!isBlank(stripped)) {
          lastSrcIdx = i;
          seenContent = true;
        }
        i++;
        continue;
      }
      // Any list marker ends the current item (the outer loop decides whether it
      // continues this list; a different marker starts a new list).
      const nm = matchListMarker(l);
      if (nm) break;
      // Lazy continuation: a plain line continuing the item's innermost open
      // paragraph. A setext underline is also a lazy line, but it stays paragraph
      // text. A lazy line indented by four or more columns loses four columns.
      if (itemLines.length > 0 && (isParagraphLine(innermostLine(itemLines[itemLines.length - 1])) || lastIsLazySetext) && !interruptsParagraph(l)) {
        let lazyLine = l;
        if (indentCols(lazyLine) >= 4) lazyLine = stripCols(lazyLine, 0, 4);
        itemLazyLines.add(itemLines.length);
        if (setextLevel(lazyLine) > 0) {
          itemNoSetext.add(itemLines.length);
          lastIsLazySetext = true;
        } else {
          lastIsLazySetext = false;
        }
        itemLines.push(lazyLine);
        lastSrcIdx = i;
        seenContent = true;
        i++;
        continue;
      }
      break;
    }
    // Trailing empty lines of the item: they separate items (loose) when another item
    // follows; drop them from the item's content either way. (A trailing line with
    // only spaces is paragraph content, not a blank line.)
    let trailingBlanks = 0;
    while (itemLines.length > 0 && itemLines[itemLines.length - 1] === '') {
      itemLines.pop();
      trailingBlanks++;
    }
    lastTrailingBlanks = trailingBlanks;
    // Trailing blanks make the list loose only when this item has content (an empty
    // item's blanks separate nothing).
    if (trailingBlanks > 0 && itemLines.length > 0 && i < n) {
      const nm = matchListMarker(lines[i]);
      if (nm && nm.ordered === ordered && (ordered ? nm.delim === delim : nm.bullet === bullet)) {
        loose = true;
      }
    }
    // Task item?
    let task = false;
    let checked = false;
    if (itemLines.length > 0) {
      const m = /^\[( |x|X)\]([ \t]|$)/.exec(itemLines[0]);
      if (m) {
        task = true;
        checked = m[1] !== ' ';
        itemLines[0] = itemLines[0].slice(3).replace(/^[ \t]+/, '');
        if (itemLines[0] === '' && itemLines.length > 1) {
          // "[x] " alone on the first line: the content starts on the next line.
          itemLines.shift();
          // Indices in itemNoSetext/itemLazyLines shift down by one.
          if (itemNoSetext.size > 0) {
            const shifted = new Set();
            for (const idx of itemNoSetext) shifted.add(idx - 1);
            itemNoSetext.clear();
            for (const idx of shifted) itemNoSetext.add(idx);
          }
          if (itemLazyLines.size > 0) {
            const shifted = new Set();
            for (const idx of itemLazyLines) shifted.add(idx - 1);
            itemLazyLines.clear();
            for (const idx of shifted) itemLazyLines.add(idx);
          }
        }
      }
    }
    const innerTerminated = lastSrcIdx < n - 1 || lastTerminated;
    const itemFollowedByBlank = i > lastSrcIdx + 1 || (i >= n && followedByBlank);
    const itemExtendsToEof = extendsToEof && lastSrcIdx === n - 1;
    const parsed = blockTokens(itemLines, links, innerTerminated, itemFollowedByBlank, itemExtendsToEof, itemNoSetext.size > 0 ? itemNoSetext : null, itemLazyLines.size > 0 ? itemLazyLines : null, true);
    if (parsed.loose) loose = true;
    items.push({ task, checked, b: parsed.tokens });
  }
  return { token: { t: 'l', o: ordered, s: startNum, loose, items }, next: i, trailingBlank: lastTrailingBlanks > 0 };
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function renderBlocks(tokens, links) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.t) {
      case 'h':
        out += '<h' + tok.d + '>' + inline(tok.x, links, false) + '</h' + tok.d + '>\n';
        break;
      case 'p':
        out += '<p>' + inline(tok.x, links, false) + '</p>\n';
        break;
      case 'c': {
        const code = escapeCode(tok.x);
        // The fence info string has backslash escapes processed (only backslash
        // escapes; no other inline parsing).
        const lang = tok.l != null ? tok.l.replace(/\\([!-/:-@[-`{-~])/g, '$1') : null;
        out += lang != null
          ? '<pre><code class="language-' + escapeAttr(lang) + '">' + code + '</code></pre>\n'
          : '<pre><code>' + code + '</code></pre>\n';
        break;
      }
      case 'r':
        out += '<hr>\n';
        break;
      case 'q':
        out += '<blockquote>\n' + renderBlocks(tok.b, links) + '</blockquote>\n';
        break;
      case 'l': {
        out += tok.o
          ? (tok.s !== 1 ? '<ol start="' + tok.s + '">\n' : '<ol>\n')
          : '<ul>\n';
        for (const item of tok.items) {
          const box = item.task
            ? '<input ' + (item.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '
            : '';
          let body = '';
          const blocks = item.b;
          if (tok.loose && item.task) {
            // Loose list: the checkbox goes inside the first paragraph when
            // it is one; otherwise it gets a paragraph of its own.
            if (blocks.length > 0 && blocks[0].t === 'p') {
              body += '<p>' + box + inline(blocks[0].x, links, false) + '</p>\n';
              for (let bi = 1; bi < blocks.length; bi++) body += renderBlocks([blocks[bi]], links);
            } else {
              body += '<p>' + box + '</p>\n';
              for (const bt of blocks) body += renderBlocks([bt], links);
            }
          } else {
            for (const bt of blocks) {
              if (bt.t === 'p' && !tok.loose) {
                body += inline(bt.x, links, false);
              } else {
                body += renderBlocks([bt], links);
              }
            }
            body = box + body;
          }
          out += '<li>' + body + '</li>\n';
        }
        out += tok.o ? '</ol>\n' : '</ul>\n';
        break;
      }
      case 'H':
        out += tok.x;
        break;
      case 'T': {
        const cols = tok.a.length;
        out += '<table>\n<thead>\n<tr>\n';
        for (let c = 0; c < cols; c++) {
          const cell = c < tok.h.length ? tok.h[c] : '';
          out += tok.a[c] ? '<th align="' + tok.a[c] + '">' : '<th>';
          out += inline(cell, links, false) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (tok.b.length > 0) {
          out += '<tbody>';
          for (const row of tok.b) {
            out += '<tr>\n';
            for (let c = 0; c < cols; c++) {
              const cell = c < row.length ? row[c] : '';
              out += tok.a[c] ? '<td align="' + tok.a[c] + '">' : '<td>';
              out += inline(cell, links, false) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody></table>\n';
        } else {
          out += '</table>\n';
        }
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

const PUNCT_RE = /[\p{P}\p{S}]/u;
const SPACE_RE = /\s/;
function isPunctChar(ch) {
  return ch !== undefined && PUNCT_RE.test(ch);
}
function isSpaceChar(ch) {
  return ch === undefined || SPACE_RE.test(ch);
}

// Whether the backslash at `idx` is itself escaped (preceded by an odd
// number of consecutive backslashes).
function isBackslashEscaped(src, idx) {
  let count = 0;
  for (let k = idx - 1; k >= 0 && src[k] === '\\'; k--) count++;
  return count % 2 === 1;
}

// Find the end of a code span starting at `i` (src[i] is a backtick). The opening run
// has `runLen` backticks. Returns {end, content} where end is the index just past the
// closing run, or null when there is no closing run.
function parseCodeSpan(src, i, runLen, endLimit) {
  const n = src.length;
  const cap = endLimit !== undefined && endLimit !== -1 ? endLimit : n;
  let j = i + runLen;
  while (j < cap) {
    const k = src.indexOf('`', j);
    if (k === -1 || k >= cap) return null;
    let e = k;
    while (e < n && src[e] === '`') e++;
    if (e - k === runLen) {
      let content = src.slice(i + runLen, k);
      content = content.replace(/\n/g, ' ');
      // One leading and one trailing space are stripped when both are present and the
      // content is not all spaces.
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      return { end: e, content };
    }
    j = e;
  }
  return null;
}

// Find the index of the `]` matching the `[` at `open` (bracket nesting counts; code
// spans and backslash escapes inside are skipped). Returns -1 when there is none.
function findBracketEnd(src, open) {
  const n = src.length;
  let depth = 0;
  let i = open;
  while (i < n) {
    const c = src[i];
    if (c === '\\' && i + 1 < n && isAsciiPunct(src[i + 1])) { i += 2; continue; }
    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const span = parseCodeSpan(src, i, j - i);
      if (span) { i = span.end; continue; }
      i = j;
      continue;
    }
    if (c === '[') { depth++; i++; continue; }
    if (c === ']') {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

// Parse an inline link's (destination, title) starting at src[i] === '('. Returns
// {dest, title, next} where next is the index just past the closing ')', or null.
function parseInlineLink(src, i) {
  const n = src.length;
  let j = i + 1;
  // Spaces and at most one newline before the destination.
  while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
  if (j < n && src[j] === '\n') {
    j++;
    while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
  }
  if (j >= n) return null;
  let dest = '';
  let hasDest = false;
  if (src[j] !== ')') {
    const d = parseDest(src, j);
    if (!d) return null;
    dest = d.dest;
    hasDest = true;
    j = d.next;
  }
  // Spaces and at most one newline before an optional title.
  let k = j;
  while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
  let nl = false;
  if (k < n && src[k] === '\n') { nl = true; k++; while (k < n && (src[k] === ' ' || src[k] === '\t')) k++; }
  let title = null;
  if (k < n && src[k] !== ')') {
    if (!hasDest) return null;
    const t = parseTitle(src, k);
    if (!t) return null;
    title = t.title;
    k = t.next;
    while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
    if (k < n && src[k] === '\n') {
      k++;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
    }
  }
  if (k >= n || src[k] !== ')') return null;
  return { dest, title, next: k + 1 };
}

// Match an autolink <scheme:...> or <email> starting at src[i] === '<'.
// Returns {href, text, next} or null.
function parseAutolink(src, i) {
  const n = src.length;
  const end = src.indexOf('>', i + 1);
  if (end === -1 || end - i > 1000) return null;
  const inner = src.slice(i + 1, end);
  if (inner.length === 0 || /[\s<>]/.test(inner)) return null;
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.exec(inner);
  if (scheme) {
    return { href: inner, text: inner, next: end + 1 };
  }
  if (/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(inner)) {
    return { href: 'mailto:' + inner, text: inner, next: end + 1 };
  }
  return null;
}

// Match inline raw HTML starting at src[i] === '<'. Returns the index just past it, or -1.
function parseInlineHtml(src, i) {
  const n = src.length;
  const rest = src.slice(i);
  let m;
  // Comment: short forms <!--> and <!--->, else <!-- ... --> up to the first -->.
  if (rest.startsWith('<!-->')) return i + 5;
  if (rest.startsWith('<!--->')) return i + 6;
  if (rest.startsWith('<!--')) {
    const end = src.indexOf('-->', i + 4);
    if (end === -1) return -1;
    return end + 3;
  }
  // Processing instruction.
  if (rest.startsWith('<?')) {
    const end = src.indexOf('?>', i + 2);
    return end === -1 ? -1 : end + 2;
  }
  // Declaration.
  if (/^<![A-Z]/.test(rest)) {
    const end = src.indexOf('>', i + 2);
    return end === -1 ? -1 : end + 1;
  }
  // CDATA.
  if (rest.startsWith('<![CDATA[')) {
    const end = src.indexOf(']]>', i + 9);
    return end === -1 ? -1 : end + 3;
  }
  // Open tag (attributes allowed) or close tag (name only, no attributes).
  m = /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/.exec(rest);
  if (m) return i + m[0].length;
  m = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>/.exec(rest);
  if (m) return i + m[0].length;
  return -1;
}

// GFM extended autolinks. Try a www. or scheme URL at `i`; the caller guarantees the
// preceding character is a word boundary. `endLimit` (or -1) caps the URL so it cannot
// swallow the closing bracket of a pending link label. Returns {href, text, next} or null.
function parseGfmUrl(src, i, endLimit) {
  const n = src.length;
  const cap = endLimit !== undefined && endLimit !== -1 ? endLimit : n;
  let m = /^www\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*/.exec(src.slice(i));
  let isWww = true;
  if (!m) {
    // Scheme URLs are case-insensitive and include ftp (www. is not).
    m = /^(?:https?|ftp):\/\/[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*/i.exec(src.slice(i));
    isWww = false;
    if (!m) return null;
  }
  // A www. autolink needs a dot in the domain (www.foo alone is not a link).
  if (isWww && m[0].indexOf('.', 4) === -1) return null;
  let end = i + m[0].length;
  // The path: the full run of non-space, non-< characters.
  let j = end;
  while (j < cap) {
    const c = src[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '<') break;
    j++;
  }
  end = j;
  // Backpedal (marked's _backpedal), applied repeatedly until stable: a
  // `(` only matches as part of a balanced (...) group, so an unmatched
  // `(` ends the URL; trailing punctuation cannot match at the end.
  let urlText = src.slice(i, end);
  for (;;) {
    const bp = GFM_BACKPEDAL_RE.exec(urlText);
    const next = bp ? bp[0] : '';
    if (next === urlText) break;
    urlText = next;
  }
  end = i + urlText.length;
  if (end <= i) return null;
  const text = src.slice(i, end);
  const href = isWww ? 'http://' + text : text;
  return { href, text, next: end };
}

// GFM extended email autolink at `i`. The domain must contain a dot; the
// top-level label needs only one character. Returns {href, text, next} or null.
function parseGfmEmail(src, i) {
  // The lookahead lives inside the regex so it backtracks: when the full
  // domain is followed by a word char or hyphen, a shorter domain ending
  // before a `.` still matches (marked links the partial address).
  const m = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?=$|[\s]|[^a-zA-Z0-9_-])/.exec(src.slice(i));
  if (!m) return null;
  const text = m[0];
  const end = i + text.length;
  // The end of the full (non-backtracked) match, for the emphasis case:
  // an email at the end of a forming `__...__` span is re-parsed at the
  // end of the inner text, where the lookahead passes.
  const full = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+/.exec(src.slice(i));
  return { href: 'mailto:' + text, text, next: end, fullEnd: full ? i + full[0].length : end };
}

// GFM scheme email autolink: mailto:<email> or xmpp:<email>[/segment].
// Returns {href, text, next} or null.
function parseGfmSchemeEmail(src, i) {
  const m = /^(mailto:|xmpp:)([a-zA-Z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+)/.exec(src.slice(i));
  if (!m) return null;
  let end = i + m[0].length;
  if (m[1] === 'xmpp:' && src[end] === '/') {
    const pm = /^\/[A-Za-z0-9@.]+/.exec(src.slice(end));
    if (pm) end += pm[0].length;
  } else if (end < src.length && /[\w-]/.test(src[end])) {
    return null;
  }
  // Backpedal trailing punctuation off the whole match.
  while (end > i) {
    const c = src[end - 1];
    if (c === '?' || c === '!' || c === '.' || c === ',' || c === ':' || c === ';' || c === '*' || c === '_' || c === '~') { end--; continue; }
    break;
  }
  if (end <= i) return null;
  const text = src.slice(i, end);
  return { href: text, text, next: end };
}

// Strip HTML tags from a string (for image alt text).
const TAG_STRIP_RE = /<[^>]*>/g;
function stripTags(s) {
  return s.replace(TAG_STRIP_RE, '');
}

// For image alt text: an <img> inside the label contributes its alt text.
const IMG_ALT_RE = /<img[^>]*\salt="([^"]*)"[^>]*>/g;
function altText(s) {
  return stripTags(s.replace(IMG_ALT_RE, '$1'));
}

// Document-level `inLink` state, mirroring marked's Lexer state: an inline
// `<a ...>` tag sets it (GFM autolinks are then disabled for the rest of the
// document) until an inline `</a>` tag clears it. HTML blocks do not touch
// it (they never reach the inline tag tokenizer). Reset per parse() call.
let docInLink = false;
const START_A_TAG_RE = /^<a /i;
const END_A_TAG_RE = /^<\/a>/i;
// Marked's link/reflink label pattern (from its GFM rules): a backtick in
// the label must belong to a `...` code span (any run lengths) or be part of
// a `` run immediately before ]. Tested against label + ']'.
const LINK_LABEL_RE = /^(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*\]$/;
// Marked's emStrong/del masking passes (its #n): escaped punctuation reads
// as `+`, backticks inside code spans read as `+`, and `[...](...)`
// regions, code spans and tags are replaced by `[aaa...]` for the closer
// search — even when the link does not form.
const ANY_PUNCT_OUTSIDE_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const BLOCKSKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
// Marked's GFM URL backpedal: the URL is the longest prefix this matches.
const GFM_BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

// The main inline parser. Returns HTML. `inLink` disables link parsing (but not images)
// inside link text.
function inline(src, links, inLink) {
  const n = src.length;
  if (n === 0) return '';
  // Fast path: nothing that can start an inline construct, and no hard break.
  if (!/[*_`\[!\\<>~&]/.test(src) && !/www\.|:\/\/|@/.test(src) && !/ {2,}\n/.test(src)) return escapeText(src);

  // Parts: {t:'s', s} escaped text | {t:'d', c, n, o, cl} delimiter run |
  //        {t:'h', s} ready HTML | {t:'b'} hard break.
  const parts = [];
  // Counter for link ids: delimiter runs inside a link are tagged with the
  // link's id so emphasis cannot match across a link boundary.
  let linkCounter = 0;
  // Link/image openers not yet resolved: {pi (index of the '[' part),
  // pos (source index of '['), isImage, active}. Resolution happens when a
  // ] is found, against the nearest active opener (CommonMark).
  const openers = [];
  // Source indices of `[` that formed a link/image: their labels are
  // re-tokenized (or tagged with lk), so blockSkip masking does not apply
  // to them — unlike `[...](...)` regions whose link did not form.
  const formedLinkStarts = new Set();
  // by ( or [, return that bracket's index; otherwise -1. Marked tokenizes
  // the link first, so a URL or code span inside a forming label never
  // crosses its closing bracket — but if the link would not form (label
  // already contains a link, invalid label, bad dest/ref), the construct
  // may extend past the bracket.
  const pendingLinkClose = (from) => {
    let oi = -1;
    for (let k = openers.length - 1; k >= 0; k--) {
      if (openers[k].active) { oi = k; break; }
    }
    if (oi === -1) return -1;
    const op = openers[oi];
    let p = src.indexOf(']', from);
    while (p !== -1) {
      if (src[p + 1] === '(' || src[p + 1] === '[') break;
      p = src.indexOf(']', p + 1);
    }
    if (p === -1) return -1;
    if (!op.isImage) {
      for (let k = op.pi; k < parts.length; k++) {
        if (parts[k].isLink) return -1;
      }
    }
    const labelText = src.slice(op.pos + 1, p);
    if (!LINK_LABEL_RE.test(labelText + ']')) return -1;
    const after = p + 1;
    if (src[after] === '(') {
      const parsed = parseInlineLink(src, after);
      if (!parsed || cleanUrl(parsed.dest) === null) return -1;
    } else {
      const labelEnd = src.indexOf(']', after + 1);
      if (labelEnd === -1) return -1;
      const ref = labelEnd === after + 1 ? labelText : src.slice(after + 1, labelEnd);
      const hit = links.get(normalizeLabel(ref));
      if (!hit || cleanUrl(hit.href) === null) return -1;
    }
    return p;
  };
  let textBuf = '';
  const flushText = () => {
    if (textBuf.length > 0) {
      parts.push({ t: 's', s: escapeTextLt(textBuf) });
      textBuf = '';
    }
  };
  let i = 0;
  while (i < n) {
    const c = src[i];

    // Backslash escape or backslash hard break.
    if (c === '\\') {
      if (i + 1 < n && src[i + 1] === '\n') {
        flushText();
        parts.push({ t: 'b' });
        i += 2;
        // After a hard break, leading spaces/tabs of the next line are dropped.
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      if (i + 1 < n && isAsciiPunct(src[i + 1])) {
        // An escaped character is literal text; an ampersand still needs escaping
        // (the text flusher only escapes < > " ').
        const ch = src[i + 1];
        textBuf += ch === '&' ? '&amp;' : ch;
        i += 2;
        continue;
      }
      textBuf += '\\';
      i++;
      continue;
    }

    // Code span. A code span inside a forming link label cannot cross the
    // label's closing bracket (marked tokenizes the link first).
    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const span = parseCodeSpan(src, i, j - i, pendingLinkClose(i));
      if (span) {
        flushText();
        parts.push({ t: 'h', s: '<code>' + escapeCode(span.content) + '</code>' });
        i = span.end;
        continue;
      }
      // No closing run of the same length: the whole run is literal text.
      textBuf += src.slice(i, j);
      i = j;
      continue;
    }

    // Link or image opener: push onto the opener stack; resolution happens
    // when a ] is found (nearest-opener rule). Inside link text, [ is
    // literal but ![ still opens an image.
    if (c === '[' || (c === '!' && i + 1 < n && src[i + 1] === '[')) {
      const isImage = c === '!';
      if (!isImage && inLink) {
        textBuf += c;
        i++;
        continue;
      }
      flushText();
      const open = isImage ? i + 1 : i;
      openers.push({ pi: parts.length, pos: open, isImage, active: true, savedInLink: docInLink });
      parts.push({ t: 's', s: isImage ? '![' : '[' });
      i = open + 1;
      continue;
    }

    // Closing bracket: try to form a link/image with the nearest active opener.
    if (c === ']') {
      let oi = -1;
      for (let k = openers.length - 1; k >= 0; k--) {
        if (openers[k].active) { oi = k; break; }
      }
      if (oi !== -1) {
        const opener = openers[oi];
        const labelText = src.slice(opener.pos + 1, i);
        let dest = null;
        let title = null;
        let next = -1;
        const after = i + 1;
        // Marked's link/reflink regexes reject labels whose backticks do
        // not form code spans; when the label is invalid those tokenizers
        // never match and the shortcut (nolink) tokenizer is tried instead.
        const labelValid = after < n && (src[after] === '(' || src[after] === '[')
          ? LINK_LABEL_RE.test(labelText + ']')
          : true;
        if (after < n && src[after] === '(') {
          const parsed = labelValid ? parseInlineLink(src, after) : null;
          if (parsed) { dest = parsed.dest; title = parsed.title; next = parsed.next; }
          else {
            // Inline parse failed: fall back to a shortcut reference.
            const hit = links.get(normalizeLabel(labelText));
            if (hit) { dest = hit.href; title = hit.title; next = after; }
          }
        } else if (after < n && src[after] === '[') {
          if (labelValid) {
            const labelEnd = src.indexOf(']', after + 1);
            if (labelEnd !== -1) {
              const ref = labelEnd === after + 1 ? labelText : src.slice(after + 1, labelEnd);
              const hit = links.get(normalizeLabel(ref));
              if (hit) { dest = hit.href; title = hit.title; next = labelEnd + 1; }
            }
          } else {
            // Invalid label: reflink never matches, so the shortcut
            // reference for this label is tried (marked's nolink).
            const hit = links.get(normalizeLabel(labelText));
            if (hit) { dest = hit.href; title = hit.title; next = after; }
          }
        } else {
          const hit = links.get(normalizeLabel(labelText));
          if (hit) { dest = hit.href; title = hit.title; next = after; }
        }
        if (dest !== null) {
          const href = cleanUrl(dest);
          if (href !== null) {
            flushText();
            // A link cannot contain a link: if the label already contains a
            // formed link, this opener cannot form a link (it may still form
            // an image, whose alt text may contain links).
            let hasLink = false;
            if (!opener.isImage) {
              for (let k = opener.pi; k < parts.length; k++) {
                if (parts[k].isLink) { hasLink = true; break; }
              }
            }
            if (!hasLink) {
              formedLinkStarts.add(opener.pos);
              // Marked restores the inLink state after tokenizing link text:
              // an <a> tag inside the label does not leak out.
              docInLink = opener.savedInLink;
              if (opener.isImage) {
                const alt = altText(inline(labelText, links, false));
                docInLink = opener.savedInLink;
                parts.splice(opener.pi, parts.length - opener.pi, { t: 'h', s: '<img src="' + href + '" alt="' + escapeAttr(alt) + '"' + (title !== null ? ' title="' + escapeAttr(title) + '"' : '') + '>' });
                openers.splice(oi, 1);
              } else {
                const linkId = ++linkCounter;
                // Tag delimiter runs inside this link so emphasis cannot
                // match across the link boundary (marked masks link text
                // when searching for emphasis closers). GFM autolinks are
                // disabled inside link text: revert them to literal text.
                for (let k = opener.pi; k < parts.length; k++) {
                  const p = parts[k];
                  if (p.t === 'd') p.lk = linkId;
                  else if (p.gfm) parts[k] = { t: 's', s: escapeText(p.text) };
                }
                parts[opener.pi] = { t: 'h', s: '<a href="' + href + '"' + (title !== null ? ' title="' + escapeAttr(title) + '"' : '') + '>', isLink: true };
                parts.push({ t: 'h', s: '</a>' });
                // Only the resolved opener is deactivated; earlier openers
                // stay live (an image opener may still resolve later).
                opener.active = false;
              }
              i = next;
              continue;
            }
          }
        }
        // No link formed: deactivate this opener and treat ] as literal.
        opener.active = false;
      }
      textBuf += ']';
      i++;
      continue;
    }

    // Autolink or inline HTML.
    if (c === '<') {
      const auto = parseAutolink(src, i);
      if (auto) {
        flushText();
        const href = cleanUrl(auto.href);
        parts.push({ t: 'h', s: '<a href="' + (href !== null ? href : escapeAttr(auto.href)) + '">' + escapeText(auto.text) + '</a>' });
        i = auto.next;
        continue;
      }
      const htmlEnd = parseInlineHtml(src, i);
      if (htmlEnd !== -1) {
        flushText();
        const tagText = src.slice(i, htmlEnd);
        // An inline <a ...> tag sets the document-level inLink state (GFM
        // autolinks stay disabled until an inline </a> tag clears it).
        if (START_A_TAG_RE.test(tagText)) docInLink = true;
        else if (END_A_TAG_RE.test(tagText)) docInLink = false;
        parts.push({ t: 'h', s: tagText });
        i = htmlEnd;
        continue;
      }
      textBuf += '<';
      i++;
      continue;
    }

    // Emphasis / strikethrough delimiter run.
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && src[j] === c) j++;
      const runLen = j - i;
      // Neighbor characters as marked sees them in its MASKED source: an
      // escaped character (or an escaped backslash) reads as `+`
      // (punctuation) there, so a delimiter next to an escape classifies
      // against `+`, not against the raw escaped character.
      let before = i > 0 ? src[i - 1] : undefined;
      let after = j < n ? src[j] : undefined;
      if (before === '\\') before = '+';
      else if (before !== undefined && i > 1 && src[i - 2] === '\\' && isAsciiPunct(before) && !isBackslashEscaped(src, i - 2)) before = '+';
      if (after === '\\' && j + 1 < n && isAsciiPunct(src[j + 1])) after = '+';
      const beforeWs = isSpaceChar(before);
      const afterWs = isSpaceChar(after);
      const beforePunct = isPunctChar(before);
      const afterPunct = isPunctChar(after);
      const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
      let canOpen, canClose;
      if (c === '_') {
        canOpen = leftFlanking && (!rightFlanking || beforePunct);
        canClose = rightFlanking && (!leftFlanking || afterPunct);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      flushText();
      // pb/pa/w are for marked's RDelim classification: whether the run is
      // preceded by whitespace (pure opener) and the neighbor chars (for the
      // odd-match R flag).
      parts.push({ t: 'd', c, n: runLen, o: canOpen, cl: canClose, pb: before, pa: after, w: before !== undefined && beforeWs, pos: i });
      i = j;
      continue;
    }

    // Entity or bare ampersand.
    if (c === '&') {
      const m = /^&(#\d{1,7};|#[xX][0-9a-fA-F]{1,6};|\w+;)/.exec(src.slice(i));
      if (m) {
        const ent = m[1];
        if (ent[0] === '#') {
          let cp;
          if (ent[1] === 'x' || ent[1] === 'X') cp = parseInt(ent.slice(2, -1), 16);
          else cp = parseInt(ent.slice(1, -1), 10);
          if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
          const ch = String.fromCodePoint(cp);
          textBuf += ESC_MAP[ch] || ch;
        } else {
          textBuf += m[0];
        }
        i += m[0].length;
        continue;
      }
      textBuf += '&amp;';
      i++;
      continue;
    }

    // Newline: hard break when the line ends with two or more spaces.
    if (c === '\n') {
      let spaces = 0;
      let k = textBuf.length;
      while (k > 0 && textBuf[k - 1] === ' ') { spaces++; k--; }
      if (spaces >= 2) {
        textBuf = textBuf.slice(0, k);
        flushText();
        parts.push({ t: 'b' });
        // After a hard break, leading spaces/tabs of the next line are dropped
        // (a soft break keeps them).
        i++;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      } else {
        textBuf += '\n';
        i++;
      }
      continue;
    }

    // GFM extended autolinks: www. (needs a boundary before it: start,
    // whitespace, *, _, ~, (, [), http(s)://, mailto:/xmpp: email links, and
    // bare emails (no boundary). Disabled inside link text and while the
    // document-level inLink state is set (an unclosed inline <a> tag).
    if ((c === 'w' || c === 'h' || isWordStartChar(c)) && !inLink && !docInLink) {
      const prev = i > 0 ? src[i - 1] : undefined;
      let auto = null;
      // A URL autolink must not swallow the closing bracket of a pending
      // link label that would form: marked tokenizes the link first, so a
      // URL inside a forming label never extends past the `]`.
      const urlLimit = pendingLinkClose(i);
      if (src.startsWith('www.', i)) {
        const ok = prev === undefined || isSpaceChar(prev) ||
          prev === '*' || prev === '_' || prev === '~' || prev === '(' || prev === '[';
        if (ok) auto = parseGfmUrl(src, i, urlLimit);
      } else if (/^(?:https?|ftp):\/\//i.test(src.slice(i, i + 8))) {
        auto = parseGfmUrl(src, i, urlLimit);
      } else if (src.startsWith('mailto:', i) || src.startsWith('xmpp:', i)) {
        auto = parseGfmSchemeEmail(src, i);
      } else {
        auto = parseGfmEmail(src, i);
        // An email backtracked short because it is followed by `_`: if a
        // `_` opener is pending before it, the forming `__...__` span is
        // re-parsed with the email at the end of its inner text, where the
        // lookahead passes — so the full address links.
        if (auto && auto.fullEnd > auto.next && src[auto.fullEnd] === '_') {
          for (let k = parts.length - 1; k >= 0; k--) {
            const p = parts[k];
            if (p.t === 'd' && p.c === '_' && p.n > 0 && !p.masked && p.o) {
              const fullText = src.slice(i, auto.fullEnd);
              auto = { href: 'mailto:' + fullText, text: fullText, next: auto.fullEnd, fullEnd: auto.fullEnd };
              break;
            }
            if (p.t === 'h' && p.isLink) break;
          }
        }
      }
      if (auto) {
        flushText();
        const href = cleanUrl(auto.href);
        // Tagged so a link forming around it can revert it to literal text
        // (GFM autolinks are disabled inside link text).
        parts.push({ t: 'h', s: '<a href="' + (href !== null ? href : escapeAttr(auto.href)) + '">' + escapeText(auto.text) + '</a>', gfm: true, text: auto.text });
        i = auto.next;
        continue;
      }
    }

    textBuf += c;
    i++;
  }
  flushText();

  // Mask delimiter runs inside `[...](...)` regions whose link did not
  // form (marked's blockSkip masking for the emStrong/del search): they
  // are invisible as openers and closers. Runs inside a forming link's
  // label are handled by the lk tagging instead.
  {
    let hasDelim = false;
    for (const p of parts) if (p.t === 'd') { hasDelim = true; break; }
    if (hasDelim && src.includes('[') && src.includes('](')) {
      const maskedSrc = src.replace(ANY_PUNCT_OUTSIDE_CODE_RE, (m, s, r) => r ? '+'.repeat(m.length) : s ? s + m.slice(s.length, -s.length).replace(/`/g, '+') + s : m);
      BLOCKSKIP_RE.lastIndex = 0;
      let m;
      while ((m = BLOCKSKIP_RE.exec(maskedSrc)) !== null) {
        // Link regions whose link formed are re-tokenized recursively
        // (lk tagging), so they are not masked; every other blockSkip
        // match — a non-forming link, a code span (including a phantom one
        // spanning mismatched backtick runs), or a tag — masks the
        // delimiter runs inside it.
        if (m[0][0] === '[' && formedLinkStarts.has(m.index)) continue;
        const end = m.index + m[0].length;
        for (const p of parts) {
          if (p.t === 'd' && !p.lk && p.pos > m.index && p.pos < end) p.masked = true;
        }
      }
    }
  }

  processEmphasis(parts);

  let out = '';
  for (const p of parts) {
    if (p.t === 's' || p.t === 'h') out += p.s;
    else if (p.t === 'b') out += '<br>';
    else if (p.t === 'd') out += p.c.repeat(p.n);
  }
  return out;
}

// Escape only < > " ' (ampersands are already handled by the scanner).
const LT_ESC_RE = /[<>"']/g;
const HAS_LT_RE = /[<>"']/;
function escapeTextLt(s) {
  if (!HAS_LT_RE.test(s)) return s;
  return s.replace(LT_ESC_RE, (ch) => ESC_MAP[ch]);
}

function isWordStartChar(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
    c === '.' || c === '_' || c === '%' || c === '+' || c === '-';
}

// Characters that may precede a GFM autolink (besides whitespace and line start).
function isGfmBoundary(ch) {
  return ch === '(' || ch === '<' || ch === '[' || ch === '"' || ch === "'" || ch === '*' ||
    ch === '_' || ch === '~' || ch === '`';
}

// CommonMark delimiter-run emphasis processing over the parts array. Pairs each closer
// with the nearest matching opener; uses two delimiters for strong/del when both sides
// have at least two (subject to the odd-match rule), else one for emphasis/del.
// Emphasis / strikethrough matching, following marked's eager opener-driven
// tokenizers (emStrong/del) rather than CommonMark's closer-driven algorithm.
// For each opener run (left to right), scan forward with marked's counting
// rule: opener-like runs add to the open count, closer-like runs subtract
// from it; the first run that brings the count to zero (or below) closes the
// span. The inner text — INCLUDING the unused leftover delimiters of the
// opener and closer runs — is then processed recursively, because marked
// re-parses the inner text as a fresh string. The unused tail of the closer
// run (beyond the adjusted length b) stays outside the span.
const ALPHA_NUM_RE = /[\p{L}\p{N}]/u;

// Classify a delimiter run the way marked's RDelim regexes do, from its
// neighbor characters (pb = char before, pa = char after, undefined at the
// ends). Returns 'add' (pure opener, groups 3/4), 'both' (groups 5/6),
// 'close' (pure closer, groups 1/2), or null (no group matches: invisible).
// For `*`, a `~` neighbor counts as word-like, not punctuation; for `_`
// there is no group 6, so an intraword `_` run is invisible.
function rdelimClass(ch, pb, pa) {
  // A run preceded by the same delimiter char matches no group (the
  // `(?!\\*)`/`(?!_)`/`(?!~)` guards); this is how a closer remainder left
  // outside a span behaves.
  if (pb === ch) return null;
  const bWs = pb !== undefined && isSpaceChar(pb);
  const bPunct = pb !== undefined && isPunctChar(pb);
  const bNps = pb !== undefined && !bWs && !bPunct;
  const aEnd = pa === undefined;
  const aWs = pa !== undefined && isSpaceChar(pa);
  const aPunct = pa !== undefined && isPunctChar(pa);
  const aNps = pa !== undefined && !aWs && !aPunct;
  if (ch === '*') {
    const bNpsLike = bNps || pb === '~';
    const aNpsLike = aNps || pa === '~';
    const bPunctX = bPunct && pb !== '~';
    const aPunctX = aPunct && pa !== '~';
    const bPunctSpaceX = (bWs || bPunct) && pb !== '~';
    const aPunctSpaceX = (aWs || aPunct) && pa !== '~';
    if (bPunctX && (aWs || aEnd)) return 'close'; // g1
    if (bNpsLike && (aPunctSpaceX || aEnd)) return 'close'; // g2
    if (bPunctSpaceX && aNpsLike) return 'add'; // g3
    if (bWs && aPunctX) return 'add'; // g4
    if (bPunctX && aPunctX) return 'both'; // g5
    if (bNpsLike && aNpsLike) return 'both'; // g6
    return null;
  }
  if (ch === '_') {
    if (bPunct && (aWs || aEnd)) return 'close'; // g1
    if (bNps && (aWs || aPunct || aEnd)) return 'close'; // g2
    if ((bWs || bPunct) && aNps) return 'add'; // g3
    if (bWs && aPunct) return 'add'; // g4
    if (bPunct && aPunct) return 'both'; // g5
    return null; // no g6: intraword `_` is invisible
  }
  // '~' (del): g6 exists, no `~` special-casing (neighbors can't be `~`).
  if (bPunct && (aWs || aEnd)) return 'close'; // g1
  if (bNps && (aWs || aPunct || aEnd)) return 'close'; // g2
  if ((bWs || bPunct) && aNps) return 'add'; // g3
  if (bWs && aPunct) return 'add'; // g4
  if (bPunct && aPunct) return 'both'; // g5
  if (bNps && aNps) return 'both'; // g6
  return null;
}

// Whether this delimiter run can start an emphasis search (marked's LDelim
// plus the `if(!d||!n||u)` gate plus the `_` intraword check). `prevPart` is
// the part before the opener (undefined at the start); it determines `n`,
// the last character of the previous text token: "" at the start or after a
// non-text part, the char before the run after text — except that a text
// token ending in `_` leaves `n` empty.
function canOpenSearch(part, prevPart) {
  // Masked runs (inside a non-forming `[...](...)` region) are invisible.
  if (part.masked) return false;
  const pa = part.pa;
  // LDelim needs a non-whitespace character after the run.
  if (pa === undefined || isSpaceChar(pa)) return false;
  const d = isPunctChar(pa) && pa !== '~';
  let n = '';
  if (prevPart !== undefined) {
    if (prevPart.t === 's') n = part.pb ?? '';
    else if (prevPart.t === 'd') n = prevPart.c === '_' ? '' : prevPart.c;
  }
  const u = n !== '' && n !== '*' && n !== '_' && (isSpaceChar(n) || isPunctChar(n));
  if (d && n !== '' && !u) return false;
  if (part.c === '_' && !d && n !== '' && ALPHA_NUM_RE.test(n)) return false;
  return true;
}

// The RDelim regex's first alternative skips a single `ch` run bracketed by
// double runs of the other delimiter (`__...*...__` for `*`,
// `**..._...**` for `_`), when those are the first delimiter runs in the
// scan region with no other delimiter run between them. Returns the index
// of the skipped run, or -1. Runs inside a different link context are
// masked out (invisible here, and they don't block the pattern).
function findSkippedRun(parts, oi, ch, lk) {
  const other = ch === '*' ? '_' : '*';
  let singleIdx = -1;
  let state = 0;
  for (let k = oi + 1; k < parts.length; k++) {
    const r = parts[k];
    if (r.t !== 'd' || r.n === 0) continue;
    if ((r.lk || 0) !== lk) continue;
    if (state === 0) {
      if (r.c === other && r.n === 2) { state = 1; continue; }
      return -1;
    }
    if (state === 1) {
      if (r.c === ch && r.n === 1) { singleIdx = k; state = 2; continue; }
      return -1;
    }
    if (r.c === other && r.n >= 2) return singleIdx;
    return -1;
  }
  return -1;
}

function processEmphasis(parts) {
  for (let oi = 0; oi < parts.length; oi++) {
    const opener = parts[oi];
    if (opener.t !== 'd' || opener.n === 0) continue;
    const ch = opener.c;
    const K = opener.n;
    // Try the full run, then shorter retries: when emStrong fails, marked's
    // text tokenizer consumes one delimiter char and retries on the rest.
    // A retry's counting starts at the remaining length k, but the odd-match
    // rule still uses the original length K (the backup loop rewinds over
    // the consumed chars), and the retry gate sees n = the consumed char
    // (`*` → the gate needs a non-punct char after; `_` keeps the original
    // n; `~` always passes). For `~`, the LDelim matches at most 2 chars,
    // so a longer run's first attempt already uses k = 2.
    const prevPart = oi > 0 ? parts[oi - 1] : undefined;
    if (!canOpenSearch(opener, prevPart)) continue;
    const dAfter = opener.pa !== undefined && isPunctChar(opener.pa) && opener.pa !== '~';
    let matched = null;
    let kTop = ch === '~' ? Math.min(K, 2) : K;
    for (let k = kTop; k >= 1; k--) {
      if (k < kTop && ch === '*' && dAfter) break; // retry gate fails for `*`
      const match = findEmClose(parts, oi, k, K);
      if (match) { matched = { ...match, k }; break; }
    }
    if (!matched) continue;
    const { ci, use, tag, b, k } = matched;
    // Chars consumed before the matching attempt stay literal text in front
    // of the span (0 for a `~` run longer than 2 matching at k = 2).
    const consumed = ch === '~' && K > 2 && k === 2 ? 0 : K - k;
    const closer = parts[ci];
    // The inner text is re-parsed fresh (marked re-parses U). It includes
    // the unused leftovers of both runs: the opener leftover sits at the
    // start of the inner text (no char before it) and the closer leftover
    // at the end (no char after it). When there is no leftover on a side,
    // the edge inner part itself sits at the start/end of the inner text,
    // so its neighbor on that side is undefined.
    const innerParts = [];
    if (k > use) {
      innerParts.push({ t: 'd', c: opener.c, n: k - use, pb: undefined, pa: opener.pa, lk: opener.lk });
    }
    for (let k2 = oi + 1; k2 < ci; k2++) innerParts.push(parts[k2]);
    if (b > use) {
      innerParts.push({ t: 'd', c: closer.c, n: b - use, pb: closer.pb, pa: undefined, lk: closer.lk });
    }
    if (innerParts.length > 0) {
      if (k === use && innerParts[0].t === 'd') innerParts[0] = { ...innerParts[0], pb: undefined };
      if (b === use) {
        const li = innerParts.length - 1;
        if (innerParts[li].t === 'd') innerParts[li] = { ...innerParts[li], pa: undefined };
      }
    }
    processEmphasis(innerParts);
    let inner = '';
    for (const p of innerParts) {
      if (p.t === 's' || p.t === 'h') inner += p.s;
      else if (p.t === 'b') inner += '<br>';
      else if (p.t === 'd') inner += p.c.repeat(p.n);
    }
    const wrapped = { t: 'h', s: '<' + tag + '>' + inner + '</' + tag + '>' };
    // Replace the span [oi..ci] with [consumed literal text?, wrapped,
    // closer remainder?]. The closer remainder's preceding char in the outer
    // text is the delimiter itself, so it can never close.
    const replacement = [];
    if (consumed > 0) replacement.push({ t: 's', s: ch.repeat(consumed) });
    replacement.push(wrapped);
    if (closer.n > b) {
      replacement.push({ t: 'd', c: closer.c, n: closer.n - b, pb: closer.c, pa: closer.pa, lk: closer.lk });
    }
    parts.splice(oi, ci - oi + 1, ...replacement);
    // Single pass, like marked's tokenizer: an opener that failed is never
    // revisited (its runs may have been consumed into a span, which would
    // wrongly let it match now). Continue after the wrapped span, or at the
    // closer remainder if one was left outside it.
    oi = oi + replacement.length - 1 - (closer.n > b ? 1 : 0);
  }
}

// Scan forward from the opener at `oi` for its closer, using marked's
// counting rule. `kLen` is the opener length of this attempt (the remaining
// run after retries consumed chars); `yLen` is the original run length,
// which the odd-match rule uses. Returns {ci, use, tag, b} or null.
function findEmClose(parts, oi, kLen, yLen) {
  const opener = parts[oi];
  const ch = opener.c;
  const isDel = ch === '~';
  // Strikethrough runs must be length 1 or 2.
  if (isDel && kLen > 2) return null;
  let m = kLen; // open count
  let f = 0; // delimiters skipped by the odd-match rule
  const y = yLen;
  const lk = opener.lk || 0;
  const skipIdx = isDel ? -1 : findSkippedRun(parts, oi, ch, lk);
  // Marked's R flag: the opener is preceded by a non-whitespace character
  // and (the character after it is punctuation, or it is a `*` opener not
  // preceded by punctuation). When set, pure closers are also subject to
  // the odd-match rule.
  const p = opener.pb ?? '';
  const d = opener.pa !== undefined && isPunctChar(opener.pa) && opener.pa !== '~';
  const h = p === '*' || p === '_' || isPunctChar(p);
  const R = p.trim() !== '' && (d || (ch === '*' && !h));
  for (let k = oi + 1; k < parts.length; k++) {
    if (k === skipIdx) continue;
    const r = parts[k];
    if (r.t !== 'd' || r.c !== ch || r.n === 0) continue;
    if (r.masked) continue;
    // A delimiter inside a link cannot match one outside it (and vice versa):
    // marked masks link text when searching for closers.
    if ((r.lk || 0) !== lk) continue;
    const cls = rdelimClass(ch, r.pb, r.pa);
    if (cls === null) continue;
    if (isDel) {
      // Strikethrough: only runs of the same length count; no odd-match rule.
      if (r.n !== kLen) continue;
      if (cls === 'add') { m += r.n; continue; }
      m -= r.n;
      if (m > 0) continue;
      return { ci: k, use: kLen, tag: 'del', b: kLen };
    }
    if (cls === 'add') { m += r.n; continue; }
    // Both-runs (and pure closers when R is set) are subject to the
    // odd-match rule: skip this run when the lengths sum to a multiple of
    // three (and not both are multiples of three).
    if ((cls === 'both' || R) && y % 3 !== 0 && (y + r.n) % 3 === 0) {
      f += r.n;
      continue;
    }
    m -= r.n;
    if (m > 0) continue;
    // This run closes the span. The use count follows marked: the closer
    // length adjusted by the leftover count and skipped delimiters, then
    // em (use 1) when the min is odd, strong (use 2) when even.
    const b = Math.min(r.n, r.n + m + f);
    const use = Math.min(kLen, b) % 2 === 1 ? 1 : 2;
    return { ci: k, use, tag: use === 2 ? 'strong' : 'em', b };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = markdown.replace(/\r\n?/g, '\n');
  const links = new Map();
  docInLink = false;
  const lines = src.split('\n');
  // A trailing empty element (from a final newline) is not a real line; drop it and
  // remember that the last real line was newline-terminated.
  const lastTerminated = src.length > 0 && src[src.length - 1] === '\n';
  if (lastTerminated) lines.pop();
  const tokens = blockTokens(lines, links, lastTerminated, false, true).tokens;
  return renderBlocks(tokens, links);
}
