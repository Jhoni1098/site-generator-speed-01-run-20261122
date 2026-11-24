// Fast drop-in for makefun-site 1.0.0 — written from scratch in this session.
// Same output byte-for-byte; optimisations: single-pass inline rendering with
// bulk escaping, direct block rendering (no token objects), cached slug/date,
// per-case template compile to flat nodes rendered into an array, minimal
// allocation in the hot paths.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const ESC_RE = /[&<>"']/g;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

// ---------- slug / dates (cached per run) ----------
let slugCache, dateCache;
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out;
  // ASCII fast path: NFKD is identity, no combining marks.
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) { ascii = false; break; }
  if (ascii) {
    let s = '', gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = 0;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === 0) { gap = s.length > 0; continue; }
      if (gap) s += '-';
      gap = false;
      s += String.fromCharCode(keep);
    }
    out = s.slice(0, 64).replace(/-+$/, '');
    if (out === '') out = 'untitled';
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let s = '', gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = s.length > 0; continue; }
      if (gap) s += '-';
      gap = false;
      s += keep;
    }
    out = s.slice(0, 64).replace(/-+$/, '');
    if (out === '') out = 'untitled';
  }
  slugCache.set(text, out);
  return out;
}
function longDate(date) {
  const hit = dateCache.get(date);
  if (hit !== undefined) return hit;
  const out = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  dateCache.set(date, out);
  return out;
}

// unique slug: taken Set per dir + next-number cache per (dir, slug)
function uniqueSlug(slug, taken, nextMap) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = nextMap.get(slug) || 2;
  let out = slug + '-' + n;
  while (taken.has(out)) { n++; out = slug + '-' + n; }
  taken.add(out);
  nextMap.set(slug, n + 1);
  return out;
}

// word count: runs of non-whitespace (baseline: text.match(/\S+/g).length)
const WS_RE = /\S+/g;
function wordsOf(text) {
  const m = text.match(WS_RE);
  return m === null ? 0 : m.length;
}

// ---------- front matter ----------
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    // fast path: no backslash and no stray quote inside
    const bs = raw.indexOf('\\', 1);
    const q = raw.indexOf('"', 1);
    if (bs === -1 && q === raw.length - 1) return { value: raw.slice(1, -1) };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n; i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}
function valueOf(key, raw) {
  switch (key) {
    case 'title': case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      // ^(\d{4})-(\d{2})-(\d{2})$ + range check
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
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
      if (ok) for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) { ok = false; break; }
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      if (ok) {
        // ^[a-z0-9]+(?:-[a-z0-9]+)*$
        let prevDash = true; // start must be alnum
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          if (c === 45) { if (prevDash) { ok = false; break; } prevDash = true; }
          else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
          else { ok = false; break; }
        }
        if (prevDash) ok = false; // trailing '-'
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

// Parse front matter without splitting the whole body. Returns {data, body} or {error}.
function parseFrontMatter(text) {
  // first line must be '---'
  let nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  // find closing '---' line
  let pos = nl === -1 ? text.length : nl + 1;
  let closeLine = -1, closeEnd = -1, lineNo = 1;
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos) : text.slice(pos, e);
    lineNo++;
    if (line === '---') { closeLine = lineNo; closeEnd = e; break; }
    pos = e === -1 ? text.length + 1 : e + 1;
    if (e === -1) break;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // iterate lines 2..closeLine-1
  pos = nl + 1;
  for (let i = 2; i < closeLine; i++) {
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos) : text.slice(pos, e);
    pos = e === -1 ? text.length + 1 : e + 1;
    if (line.length === 0) continue;
    let blank = true;
    for (let j = 0; j < line.length; j++) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) { blank = false; break; } }
    if (blank || line.charCodeAt(0) === 35) continue; // '#' comment
    // LINE: /^([a-z_]+):(?: (.*))?$/
    let k = 0;
    while (k < line.length) { const c = line.charCodeAt(k); if ((c >= 97 && c <= 122) || c === 95) k++; else break; }
    if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) return { error: `line ${i} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i} is not "key: value"` };
    // trailing spaces/tabs dropped
    let rlen = raw.length;
    while (rlen > 0) { const c = raw.charCodeAt(rlen - 1); if (c === 32 || c === 9) rlen--; else break; }
    if (rlen !== raw.length) raw = raw.slice(0, rlen);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === -1 ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

// ---------- markdown ----------
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INLINE_SPECIAL = /[\\`*[]/;

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

// link resolver set per source (closure over dir/bySource/staticPaths/broken)
let linkFn;
function inline(s, env) {
  if (!INLINE_SPECIAL.test(s)) return escapeHtml(s);
  const out = [];
  let i = 0, plain = 0;
  const flush = (to) => { if (to > plain) out.push(escapeHtml(s.slice(plain, to))); };
  while (i < s.length) {
    // jump to next special char (native indexOf scans)
    let nxt = s.length;
    let k = s.indexOf('\\', i); if (k !== -1 && k < nxt) nxt = k;
    k = s.indexOf('`', i); if (k !== -1 && k < nxt) nxt = k;
    k = s.indexOf('*', i); if (k !== -1 && k < nxt) nxt = k;
    k = s.indexOf('[', i); if (k !== -1 && k < nxt) nxt = k;
    i = nxt;
    if (i >= s.length) break;
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
      flush(i); out.push(s[i + 1]); i += 2; plain = i; continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i); out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1; plain = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          flush(i); out.push('<strong>', inline(s.slice(i + 2, j), env), '</strong>');
          i = j + 2; plain = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        flush(i); out.push('<em>', inline(s.slice(i + 1, j), env), '</em>');
        i = j + 1; plain = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        out.push('<a href="', escapeHtml(linkFn(target)), '">', inline(s.slice(i + 1, k), env), '</a>');
        i = m + 1; plain = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flush(s.length);
  return out.join('');
}

function isBlank(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9) return false;
  for (let i = 1; i < line.length; i++) { const d = line.charCodeAt(i); if (d !== 32 && d !== 9) return false; }
  return true;
}
function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b) { const c = line.charCodeAt(a); if (c === 32 || c === 9) a++; else break; }
  while (b > a) { const c = line.charCodeAt(b - 1); if (c === 32 || c === 9) b--; else break; }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}
// fence open: ``` + lang chars, then spaces/tabs only. Returns lang or null.
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3, lang = '';
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) { lang += line[i]; i++; }
    else break;
  }
  while (i < line.length) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return null; i++; }
  return lang;
}
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
// heading: 1-6 '#', space/tab, text (trailing spaces/tabs dropped, non-empty). Returns [depth, text] or null.
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n > 6 || n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let b = line.length;
  while (b > n) { const d = line.charCodeAt(b - 1); if (d === 32 || d === 9) b--; else break; }
  const text = line.slice(n, b).replace(/^[ \t]+/, '');
  // text above: after the mandatory space/tab, leading spaces are part of (.*?) — baseline regex (.*?) after [ \t]+
  // consumes at least one space/tab, rest is text; leading extra spaces remain in text. trimLine is NOT applied.
  // Our slice(n,b) starts at first space; need to drop exactly the [ \t]+ run? No: HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/
  // [ \t]+ is greedy but backtracks so (.*?) gets the rest; effectively text = rest after ALL leading spaces/tabs?
  // (.*?) is lazy, but trailing [ \t]*$ forces trailing trim; leading: [ \t]+ matches as many as possible while
  // still allowing a match — since (.*?) can be empty, [ \t]+ takes all consecutive spaces/tabs. So text has no
  // leading spaces/tabs. The replace above removes them. Good.
  if (text === '') return null;
  return [n, text];
}
function isHR(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0), b = line.charCodeAt(1), d = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && d === 45) || (a === 42 && b === 42 && d === 42))) return false;
  for (let i = 3; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHR(line);
}

function renderMarkdown(src, env) {
  linkFn = env.link;
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  const ids = new Set();
  const idNext = new Map();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const parts = ['<pre><code'];
      if (lang !== '') { parts.push(' class="language-', escapeHtml(lang), '"'); }
      parts.push('>');
      i++;
      while (i < n && !isFenceClose(lines[i])) { parts.push(escapeHtml(lines[i]), '\n'); i++; }
      i++;
      parts.push('</code></pre>');
      blocks.push(parts.join(''));
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd[1]), ids, idNext);
      const html = inline(hd[1], env);
      blocks.push(`<h${hd[0]} id="${id}">${html}</h${hd[0]}>`);
      if (hd[0] === 2 || hd[0] === 3) toc.push({ level: hd[0], id, html });
      i++;
      continue;
    }
    if (isHR(line)) { blocks.push('<hr>'); i++; continue; }
    if (line.charCodeAt(0) === 62) { // '>'
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        body.push(l); i++;
      }
      const kept = [];
      for (let j = 0; j < body.length; j++) { const t = trimLine(body[j]); if (t !== '') kept.push(t); }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    // list?
    let isOrd = false, startNum = 1, mOrd = null;
    const c0 = line.charCodeAt(0);
    let bullet = (c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32;
    if (!bullet && c0 >= 48 && c0 <= 57) {
      // /^(\d{1,9})\. (.*)$/
      let j = 0;
      while (j < line.length && j < 9 && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
      if (j > 0 && j < line.length && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) { isOrd = true; startNum = Number(line.slice(0, j)); mOrd = j; }
    }
    if (bullet || isOrd) {
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (isOrd) {
          let j = 0;
          while (j < l.length && j < 9 && l.charCodeAt(j) >= 48 && l.charCodeAt(j) <= 57) j++;
          if (j > 0 && l.charCodeAt(j) === 46 && l.charCodeAt(j + 1) === 32) { items.push([trimLine(l.slice(j + 2))]); i++; continue; }
        } else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          items.push([trimLine(l.slice(2))]); i++; continue;
        }
        // continued: /^ {2,}\S/
        if (l.length >= 3 && l.charCodeAt(0) === 32 && l.charCodeAt(1) === 32 && l.charCodeAt(2) !== 32) {
          // need at least 2 spaces then a non-space char (any char except space? \S = non-whitespace; charCode 2 could be tab)
          const ch = l.charCodeAt(2);
          if (!(ch === 32 || ch === 9 || ch === 10 || ch === 11 || ch === 12 || ch === 13)) { items[items.length - 1].push(trimLine(l)); i++; continue; }
        } else if (l.length >= 4 && l.charCodeAt(0) === 32 && l.charCodeAt(1) === 32) {
          // 2+ spaces then first non-space must be non-whitespace: check char at 2: if space, scan further
          let j = 2;
          while (j < l.length && l.charCodeAt(j) === 32) j++;
          if (j < l.length) { const ch = l.charCodeAt(j); if (!(ch === 9 || ch === 10 || ch === 11 || ch === 12 || ch === 13)) { items[items.length - 1].push(trimLine(l)); i++; continue; } }
        }
        break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      const open = isOrd && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      const parts = [open, '\n'];
      for (let j = 0; j < items.length; j++) parts.push('<li>', inline(items[j].join('\n'), env), '</li>\n');
      parts.push(`</${tag}>`);
      blocks.push(parts.join(''));
      continue;
    }
    // paragraph
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  linkFn = null;
  return { html: blocks.length === 0 ? '' : blocks.map((b) => b + '\n').join(''), toc, excerpt: excerpt ?? '' };
}

// ---------- templates ----------
class TemplateError extends Error {}
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
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
        body.push(node); stack.push(node); body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node); stack.push(node); body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = []; body = top.else;
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

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}
// scope is an array of vars objects, root at [0], loop frames pushed on top.
function lookup(stack, path) {
  for (let si = stack.length - 1; si >= 0; si--) {
    const vars = stack[si];
    if (Object.hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}
function renderNodes(nodes, stack, templates, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text': out.push(n.text); break;
      case 'var': {
        const v = lookup(stack, n.path);
        out.push(typeof v === 'string' ? escapeHtml(v) : escapeHtml(textOf(v)));
        break;
      }
      case 'raw': out.push(textOf(lookup(stack, n.path))); break;
      case 'if': {
        const v = truthy(lookup(stack, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, stack, templates, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(stack, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = {};
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          stack.push(vars);
          renderNodes(n.body, stack, templates, depth, out);
          stack.pop();
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, stack, templates, depth + 1, out);
        break;
      }
    }
  }
}

// ---------- path resolution ----------
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length === 0) return null; parts.pop(); }
    else parts.push(seg);
  }
  return parts.join('/');
}

// ---------- build ----------
export function run(input) {
  slugCache = new Map();
  dateCache = new Map();
  const base = input.site.base_url.replace(/\/+$/, '');
  const templates = new Map();
  const report = [];
  const tNames = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < tNames.length; i++) {
    const name = tNames[i];
    try { templates.set(name, parseTemplate(name, input.templates[name])); }
    catch (err) { if (!(err instanceof TemplateError)) throw err; report.push(err.message); }
  }

  // sources, sorted by path
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const text = f.path === undefined ? '' : f.content;
      sources.push({ path: f.path, text: text.indexOf('\r') === -1 ? text : text.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // front matter + drops
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data; s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // permalinks
  const takenByDir = new Map();
  const nextByDir = new Map();
  const bySource = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : (s.path.includes('/') ? s.path.slice(0, s.path.lastIndexOf('/')) : '');
    let taken = takenByDir.get(dir);
    if (taken === undefined) { taken = new Set(dir === '' ? ['posts', 'tags', 'page'] : []); takenByDir.set(dir, taken); }
    let nextMap = nextByDir.get(dir);
    if (nextMap === undefined) { nextMap = new Map(); nextByDir.set(dir, nextMap); }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), taken, nextMap);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // markdown
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.path.includes('/') ? s.path.slice(0, s.path.lastIndexOf('/')) : '';
    const dirParts = dir === '' ? [] : dir.split('/');
    const link = (target) => {
      // scheme? /^[A-Za-z][A-Za-z0-9+.-]*:/
      const c0 = target.charCodeAt(0);
      if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
        let j = 1;
        while (j < target.length) {
          const c = target.charCodeAt(j);
          if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) j++;
          else break;
        }
        if (j < target.length && target.charCodeAt(j) === 58) return target;
      }
      if (target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target; // '/' or '#'
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dirParts, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, { link });
    s.html = md.html; s.toc = md.toc; s.excerpt = md.excerpt;
  }

  // collections
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let i = 0; i < tags.length; i++) {
      const name = tags[i];
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names = ownTags(p);
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    const names = ownTags(s);
    s.tagRefs = new Array(names.length);
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugify(name);
      s.tagRefs[j] = bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // cards / pages
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));
  const pageOf = (s) => {
    const card = s.post ? cards.get(s) : cardOf(s);
    return {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };

  // layouts
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    const stack = [{ site, tags: allTags, recent, ...vars }];
    renderNodes(nodes, stack, templates, 0, out);
    return out.join('');
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // report
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
