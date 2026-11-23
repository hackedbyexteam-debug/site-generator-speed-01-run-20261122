// solve.js — a fast, dependency-free drop-in for makefun-site 1.0.0.
//
// Written from makefun-site's README/spec and its reference behaviour: for every
// case's input it returns exactly the output tree makefun-site 1.0.0's build
// returns, byte for byte. It is an original implementation, not a copy of the
// reference: single-pass line scanning, batched HTML escaping, cached slugs and
// templates compiled once per case into plain string-building functions (the
// generated code only ever pushes strings; it is built from the parsed template
// tree, with every literal JSON-escaped).
//
// Nothing is cached from one case to the next: every cache below is created
// fresh inside run().

// ---------------------------------------------------------------- text

const ESC_RE = /[&<>"']/g;
const ESC_ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. Fast path returns the string untouched. */
function esc(text) {
  const first = text.search(ESC_RE);
  if (first === -1) return text;
  let out = text.slice(0, first);
  let start = first;
  const n = text.length;
  for (let i = first; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (start < i) out += text.slice(start, i);
      out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
      start = i + 1;
    }
  }
  return out + text.slice(start);
}

/** One character escaped (used for a backslash-escaped character). */
function esc1(ch) {
  return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch === "'" ? '&#39;' : ch;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * Results are cached per build (tag names and headings repeat constantly).
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (!/[^\x00-\x7F]/.test(text)) {
    // ASCII: NFKD is the identity and there are no combining marks.
    out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** Whitespace (JavaScript \s) as a code-unit table: 1 where the unit is whitespace. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
        mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
        d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1)
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length >= 1 && raw.length <= 64;
      let prevDash = false;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw[i];
        if (c === '-') {
          if (i === 0 || prevDash) ok = false;
          prevDash = true;
        } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) prevDash = false;
        else ok = false;
      }
      if (ok && prevDash) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Scanned by line index, so the
 * body is one slice, never split and re-joined.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  const data = {};
  let lineNo = 1; // the opening --- is line 1
  let pos = 4; // just past "---\n"
  if (text === '---') return { error: 'the front matter is not closed' };
  let closeAt = -1;
  let closeEnd = -1;
  while (true) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    lineNo++;
    if (line === '---') {
      closeAt = lineNo;
      closeEnd = nl === -1 ? text.length : nl + 1;
      break;
    }
    // blank (spaces and tabs only) or a comment: skip
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      const colon = line.indexOf(':');
      let key = null;
      if (colon > 0) {
        let okKey = true;
        for (let i = 0; i < colon; i++) {
          const c = line[i];
          if (!((c >= 'a' && c <= 'z') || c === '_')) {
            okKey = false;
            break;
          }
        }
        if (okKey) key = line.slice(0, colon);
      }
      if (key === null) return { error: `line ${lineNo} is not "key: value"` };
      let raw;
      if (line.length === colon + 1) raw = '';
      else if (line.charCodeAt(colon + 1) === 32) raw = line.slice(colon + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      // trailing spaces and tabs dropped
      let rEnd = raw.length;
      while (rEnd > 0) {
        const c = raw.charCodeAt(rEnd - 1);
        if (c !== 32 && c !== 9) break;
        rEnd--;
      }
      if (rEnd !== raw.length) raw = raw.slice(0, rEnd);
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = fmValueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    pos = nl + 1;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd >= text.length ? '' : text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

const INLINE_SPECIAL = /[\\`*[]/;
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnesc(s, what, from) {
  let j = from;
  for (;;) {
    const nw = s.indexOf(what, j);
    if (nw === -1) return -1;
    const nb = s.indexOf('\\', j);
    if (nb !== -1 && nb < nw) j = nb + 1 < s.length && ESCAPABLE.has(s[nb + 1]) ? nb + 2 : nb + 1;
    else return nw;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const ns = s.indexOf('*', j);
    if (ns === -1) return -1;
    const nb = s.indexOf('\\', j);
    if (nb !== -1 && nb < ns) j = nb + 1 < s.length && ESCAPABLE.has(s[nb + 1]) ? nb + 2 : nb + 1;
    else if (s[ns + 1] === '*') j = ns + 2;
    else return ns;
  }
}

/**
 * `s` rendered inline; `link(target)` is a link's href. One regex pass finds
 * the next character that needs attention — a markdown mark or an HTML
 * special — so plain runs are emitted without a second escaping scan, and
 * the next mark is found with indexOf jumps instead of a character-at-a-time
 * scan. A plain run between two marks holds no HTML special: any that was
 * there was already emitted as its entity while the scan passed it.
 */
function inline(s, link) {
  if (!INLINE_SPECIAL.test(s)) return esc(s);
  let out = '';
  const n = s.length;
  let last = 0;
  const RE = /[\\`*[\\[&<>"']/g;
  for (;;) {
    const m = RE.exec(s);
    if (m === null) break;
    const j = m.index;
    const ch = s[j];
    if (ch === '&') {
      if (last < j) out += s.slice(last, j);
      out += '&amp;';
      last = j + 1;
      continue;
    }
    if (ch === '<') {
      if (last < j) out += s.slice(last, j);
      out += '&lt;';
      last = j + 1;
      continue;
    }
    if (ch === '>') {
      if (last < j) out += s.slice(last, j);
      out += '&gt;';
      last = j + 1;
      continue;
    }
    if (ch === '"') {
      if (last < j) out += s.slice(last, j);
      out += '&quot;';
      last = j + 1;
      continue;
    }
    if (ch === "'") {
      if (last < j) out += s.slice(last, j);
      out += '&#39;';
      last = j + 1;
      continue;
    }
    if (ch === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        if (last < j) out += s.slice(last, j);
        out += esc1(s[j + 1]);
        last = j + 2;
        RE.lastIndex = last;
      }
      continue;
    }
    if (ch === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (last < j) out += s.slice(last, j);
        out += `<code>${esc(s.slice(j + 1, k))}</code>`;
        last = k + 1;
        RE.lastIndex = last;
      }
      continue;
    }
    if (ch === '*') {
      if (s[j + 1] === '*') {
        const k = findUnesc(s, '**', j + 2);
        if (k > j + 2) {
          if (last < j) out += s.slice(last, j);
          out += `<strong>${inline(s.slice(j + 2, k), link)}</strong>`;
          last = k + 2;
          RE.lastIndex = last;
        } else RE.lastIndex = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (last < j) out += s.slice(last, j);
        out += `<em>${inline(s.slice(j + 1, k), link)}</em>`;
        last = k + 1;
        RE.lastIndex = last;
      }
      continue;
    }
    const k = findUnesc(s, ']', j + 1);
    const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !/\s/.test(target)) {
      if (last < j) out += s.slice(last, j);
      out += `<a href="${esc(link(target))}">${inline(s.slice(j + 1, k), link)}</a>`;
      last = mm + 1;
      RE.lastIndex = last;
    }
  }
  if (last < n) out += s.slice(last);
  return out;
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-open line's language, or null (not a fence). */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (text never empty, at most 6 #). */
function headingOf(line) {
  let hashes = 0;
  while (hashes < line.length && line.charCodeAt(hashes) === 35) hashes++;
  if (hashes === 0 || hashes > 6) return null;
  // one or more spaces or tabs separate the #s from the text
  let pos = hashes;
  while (pos < line.length && (line.charCodeAt(pos) === 32 || line.charCodeAt(pos) === 9)) pos++;
  if (pos === hashes || pos >= line.length) return null;
  let end = line.length;
  while (end > pos && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  const text = line.slice(pos, end);
  if (text === '') return null;
  return { depth: hashes, text };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether char code `c` is JavaScript whitespace (\s). */
function isWS(c) {
  return (
    c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let spaces = 0;
  while (spaces < line.length && line.charCodeAt(spaces) === 32) spaces++;
  return spaces >= 2 && spaces < line.length && !isWS(line.charCodeAt(spaces));
}
function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceLang(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents (every level 2 and 3 heading) and its
 * excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link, slugCache) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const code = body.length === 0 ? '' : `${esc(body.join('\n'))}\n`;
      blocks.push(lang === '' ? `<pre><code>${code}</code></pre>` : `<pre><code class="language-${esc(lang)}">${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text, slugCache), ids);
      const html = inline(heading.text, link);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        l = trimLine(l);
        if (l !== '') body.push(l);
      }
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(body.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    // list?
    let bullet = false;
    let ordered = false;
    let startNum = 1;
    if (line.length >= 2 && (line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42) && line.charCodeAt(1) === 32) bullet = true;
    else {
      let d = 0;
      while (d < 9 && d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
      if (d >= 1 && d < line.length && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
        ordered = true;
        startNum = Number(line.slice(0, d));
      }
    }
    if (bullet || ordered) {
      const items = [];
      while (i < n) {
        const l = lines[i];
        let itemText = null;
        if (ordered) {
          let d = 0;
          while (d < 9 && d < l.length && l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57) d++;
          if (d >= 1 && d < l.length && l.charCodeAt(d) === 46 && l.charCodeAt(d + 1) === 32) itemText = l.slice(d + 2);
        } else if (l.length >= 2 && (l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          itemText = l.slice(2);
        }
        if (itemText !== null) {
          items.push([trimLine(itemText)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      let listHtml = `${open}\n`;
      for (let k = 0; k < items.length; k++) listHtml += `<li>${inline(items[k].join('\n'), link)}</li>\n`;
      blocks.push(`${listHtml}</${tag}>`);
      continue;
    }
    // paragraph
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  const html = blocks.length === 0 ? '' : `${blocks.join('\n')}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function txt(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i !== 0) s += ', ';
      s += txt(v[i]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `txt(v)` escaped: one call for the common `{{ path }}` case. */
function esctxt(v) {
  return typeof v === 'string' ? esc(v) : esc(txt(v));
}

/** `txt(v)` unescaped: one call for the common `{{{ path }}}` case. */
function rawtext(v) {
  return typeof v === 'string' ? v : txt(v);
}

// --- template compiler ------------------------------------------------------
// Each parsed template compiles, once per case, to a function fn(R, O, esc, txt,
// truthy) that pushes the rendered text into O. Includes are inlined at compile
// time (depth-bounded at 8, exactly as the reference renders them), so an
// included template sees the same loop bindings as its includer: loop variables
// become real locals, and a path's first name resolves at compile time to the
// innermost binding or to the root vars object R.

function makeCompiler(parsed) {
  const cache = new Map();
  const tmp = { n: 0, max: 0 };
  const tmpName = () => {
    const name = `_t${tmp.n++}`;
    if (tmp.n > tmp.max) tmp.max = tmp.n;
    return name;
  };

  /** The JS expression for `path` in scope `env` (name -> local expression). */
  function pathExpr(path, env) {
    let expr = env[path[0]] !== undefined ? env[path[0]] : `R.${path[0]}`;
    for (let k = 1; k < path.length; k++) {
      const t = tmpName();
      expr = `((${t}=${expr})==null||typeof ${t}!=="object"?undefined:${t}.${path[k]})`;
    }
    return expr;
  }

  /** The JS source for `nodes` in scope `env`, rendered at include depth `depth`. */
  function genNodes(nodes, env, depth) {
    let src = '';
    for (const n of nodes) {
      if (n.kind === 'text') src += `O+=${JSON.stringify(n.text)};`;
      else if (n.kind === 'var') src += `O+=esctxt(${pathExpr(n.path, env)});`;
      else if (n.kind === 'raw') src += `O+=rawtext(${pathExpr(n.path, env)});`;
      else if (n.kind === 'if') {
        src += `if(truthy(${pathExpr(n.path, env)})!==${n.not}){${genNodes(n.then, env, depth)}`;
        if (n.else !== null) src += `}else{${genNodes(n.else, env, depth)}}`;
        else src += '}';
      } else if (n.kind === 'for') {
        const a = tmpName();
        const ln = tmpName();
        const kk = tmpName();
        const v = tmpName();
        const lp = tmpName();
        const env2 = Object.create(env);
        env2[n.name] = v;
        env2['loop'] = lp;
        src += `{const ${a}=${pathExpr(n.path, env)};if(Array.isArray(${a})){const ${ln}=${a}.length;for(let ${kk}=0;${kk}<${ln};${kk}++){const ${v}=${a}[${kk}];const ${lp}={index:${kk}+1,first:${kk}===0,last:${kk}===${ln}-1,length:${ln}};${genNodes(n.body, env2, depth)}}}}`;
      } else if (n.kind === 'include') {
        if (depth < INCLUDE_DEPTH && parsed.has(n.name)) src += genNodes(parsed.get(n.name), env, depth + 1);
      }
    }
    return src;
  }

  function compile(name) {
    let fn = cache.get(name);
    if (fn === undefined) {
      tmp.n = 0;
      tmp.max = 0;
      const body = genNodes(parsed.get(name), Object.create(null), 0);
      let decls = '';
      if (tmp.max > 0) {
        const names = [];
        for (let i = 0; i < tmp.max; i++) names.push(`_t${i}`);
        decls = `let ${names.join(',')};`;
      }
      fn = new Function('R', 'esc', 'txt', 'truthy', 'esctxt', 'rawtext', `${decls}let O='';${body}return O;`);
      cache.set(name, fn);
    }
    return fn;
  }

  /** Render template `name` with root vars `R`, or null when it is missing. */
  function render(name, R) {
    if (!parsed.has(name)) return null;
    return compile(name)(R, esc, txt, truthy, esctxt, rawtext);
  }

  return { render };
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const linkCache = new Map();
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const compiler = makeCompiler(templates);
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (let d = 1; d < RESERVED.length; d++) {
      if (s.path.startsWith(`${RESERVED[d]}/`)) {
        own = RESERVED[d];
        break;
      }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  const brokenKeys = new Set();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = dirOf(s.path);
    const link = (target) => {
      const key = `${dir}\n${target}`;
      let href = linkCache.get(key);
      if (href !== undefined) {
        if (brokenKeys.has(key)) broken.add(`broken-link ${s.path} -> ${target}`);
        return href;
      }
      const c0 = target.charCodeAt(0);
      let isScheme = false;
      if (target.indexOf(':') !== -1 && ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) {
        for (let k = 1; k < target.length; k++) {
          const c = target.charCodeAt(k);
          if (c === 58) {
            isScheme = true;
            break;
          }
          if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46)) break;
        }
      }
      if (isScheme || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) {
        linkCache.set(key, target);
        return target;
      }
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
      else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
      else {
        broken.add(`broken-link ${s.path} -> ${target}`);
        brokenKeys.add(key);
        href = target;
      }
      linkCache.set(key, href);
      return href;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].post) posts.push(kept[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const seen = new Set();
    const tagRefs = [];
    const names = p.data.tags ?? [];
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      tagRefs.push(tag);
    }
    p.tagRefs = tagRefs;
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const seen = new Set();
    const tagRefs = [];
    const names = s.data.tags ?? [];
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
    s.tagRefs = tagRefs;
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, links and pages as templates read them.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs,
  });
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const pageOf = (s) => {
    const card = s.card ?? cardOf(s);
    return {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };
  for (let i = 0; i < posts.length; i++) posts[i].card = cardOf(posts[i]);

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    output[`${s.outDir}/index.html`] = compiler.render(s.layout, { site, tags: allTags, recent, page: pageOf(s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = compiler.render('index', {
      site,
      tags: allTags,
      recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const html = compiler.render('tag', {
      site,
      tags: allTags,
      recent,
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = compiler.render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
