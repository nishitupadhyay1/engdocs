'use strict';
/* Document preprocessing, shared by the EngDocs web app and the VS Code extension so both read a document identically.
   Runs on the Markdown body BEFORE it is rendered. Pure functions: no DOM and no file access (the caller supplies a reader for includes).

   Syntax (all plain text, nothing to learn beyond a few {{ }} words):
     {{doc_number}} {{title}} {{rev}} {{author.name}} {{today}} ...   frontmatter values; \{{x}} prints the braces as written
     {{if status == 'DRAFT'}} ... {{else}} ... {{endif}}              conditional content ({{elif ...}}, !=, not, and, or)
     {{include: sections/loads.md}}                                    another Markdown file, its own frontmatter ignored, links re-based
     <!-- pagebreak -->                                               start a new page
     <!-- keep --> ... <!-- /keep -->                                  keep this block on one page where it fits
   Code blocks and inline code are never touched. */
const EngLayout = (() => {
  const MAX_DEPTH = 6;

  /* ---------- masking: code is hidden while we work so nothing inside it is changed ---------- */
  function mask(text) {
    const saved = [];
    const stash = (m) => { saved.push(m); return `\u0001${saved.length - 1}\u0002`; };
    let s = String(text).replace(/^(```|~~~)[^\n]*\n[\s\S]*?\n\1[^\n]*$/gm, stash);
    s = s.replace(/(`+)(?!`)[^\n]*?[^`\n]\1(?!`)/g, stash);
    return { text: s, restore: (t) => t.replace(/\u0001(\d+)\u0002/g, (m, i) => saved[+i]) };
  }

  /* ---------- paths (lexical, forward slashes) ---------- */
  const dirOf = (p) => (p && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  function resolve(baseDir, rel) {
    const parts = baseDir ? baseDir.split('/') : [];
    for (const seg of rel.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
    }
    return parts.join('/');
  }
  function relPath(fromDir, to) {
    const a = fromDir ? fromDir.split('/').filter(Boolean) : [], b = to ? to.split('/').filter(Boolean) : [];
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return '../'.repeat(a.length - i) + b.slice(i).join('/');
  }
  const isRel = (p) => !!p && !/^([a-z][a-z0-9+.-]*:|\/|\\|#|\{\{)/i.test(p);

  /* Links and images inside an included file are written relative to THAT file; make them relative to the including file. */
  function rebase(text, fromDir, toDir) {
    if (fromDir === toDir) return text;
    const m = mask(text);
    const fix = (p) => {
      if (!isRel(p)) return p;
      const q = p.search(/[?#]/), path = q < 0 ? p : p.slice(0, q), tail = q < 0 ? '' : p.slice(q);
      const abs = resolve(fromDir, path); if (abs == null) return p;
      return relPath(toDir, abs) + tail;
    };
    let s = m.text.replace(/(!?\[[^\]\n]*\]\(\s*)(<?)([^)\s>]+)(>?)/g, (all, a, lt, p, gt) => a + lt + fix(p) + gt);
    s = s.replace(/(\b(?:src|href)\s*=\s*")([^"]+)(")/gi, (all, a, p, c) => a + fix(p) + c);
    return m.restore(s);
  }

  function stripFrontmatter(t) {
    const m = /^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(t);
    return m ? t.slice(m[0].length) : t;
  }

  /* ---------- includes ---------- */
  const INCLUDE = /^[ \t]*\{\{\s*include\s*:\s*(.+?)\s*\}\}[ \t]*$/gm;
  function scanIncludes(text) {                       // [raw path, ...] (used by the app to know what to load)
    const m = mask(String(text).replace(/\r\n?/g, '\n')), out = [];
    m.text.replace(INCLUDE, (all, raw) => { out.push(raw.replace(/^["']|["']$/g, '')); return all; });
    return out;
  }
  function expandIncludes(text, o) {
    const m = mask(text);
    const s = m.text.replace(INCLUDE, (all, rawIn) => {
      const raw = rawIn.replace(/^["']|["']$/g, '');
      if (!o.readInclude) { o.issues.push({ type: 'include', path: raw, msg: `Include not available here: ${raw}` }); return `\n\n> ⚠ **Include not available:** \`${raw}\`\n\n`; }
      const r = o.readInclude(raw, o.fromPath);
      if (!r || typeof r.text !== 'string') { o.issues.push({ type: 'include', path: raw, msg: `Include not found: ${raw}` }); return `\n\n> ⚠ **Include not found:** \`${raw}\`\n\n`; }
      if (o.stack.includes(r.path) || o.stack.length > MAX_DEPTH) { o.issues.push({ type: 'include-loop', path: raw, msg: `Include loop or too deep: ${raw}` }); return `\n\n> ⚠ **Include loop:** \`${raw}\`\n\n`; }
      o.used.add(r.path);
      let body = stripFrontmatter(String(r.text).replace(/\r\n?/g, '\n'));
      body = expandIncludes(body, { ...o, fromPath: r.path, stack: [...o.stack, r.path] });   // nested first: its links become relative to this file
      body = rebase(body, dirOf(r.path), dirOf(o.fromPath));                                   // then everything relative to the including file
      return `\n\n${body.replace(/^\n+|\s+$/g, '')}\n\n`;
    });
    return m.restore(s);
  }

  /* ---------- variables ---------- */
  function varsFromMeta(meta) {
    const v = {}, m = meta && typeof meta === 'object' ? meta : {};
    const put = (k, val) => { if (val == null || typeof val === 'object') return; v[k] = val; };
    for (const [k, val] of Object.entries(m)) {
      if (k === 'page_setup') continue;
      if (Array.isArray(val)) continue;
      if (val && typeof val === 'object') { for (const [k2, v2] of Object.entries(val)) put(k + '.' + k2, v2); if (val.name != null) put(k, val.name); }
      else put(k, val);
    }
    return v;
  }
  const truthy = (x) => !(x == null || x === false || x === 0 || String(x).trim() === '' || /^(false|no|off|0)$/i.test(String(x).trim()));
  const NAME = '[A-Za-z_][\\w.\\-]*';

  /* ---------- conditionals ---------- */
  function atom(expr, vars) {
    let e = expr.trim(), neg = false;
    const nm = /^not\s+(.+)$/i.exec(e); if (nm) { neg = true; e = nm[1].trim(); }
    let r;
    const c = new RegExp(`^(${NAME})\\s*(==|!=)\\s*(?:"([^"]*)"|'([^']*)'|(.+))$`).exec(e);
    if (c) {
      const left = String(vars[c[1]] == null ? '' : vars[c[1]]).trim().toLowerCase();
      const right = String(c[3] != null ? c[3] : c[4] != null ? c[4] : c[5]).trim().toLowerCase();
      r = c[2] === '==' ? left === right : left !== right;
    } else if (new RegExp(`^${NAME}$`).test(e)) r = truthy(vars[e]);
    else return null;
    return neg ? !r : r;
  }
  function evalCond(expr, vars) {                       // and binds tighter than or; null = could not understand
    const ors = expr.split(/\s+or\s+/i);
    let any = false;
    for (const o of ors) {
      let all = true;
      for (const a of o.split(/\s+and\s+/i)) { const v = atom(a, vars); if (v == null) return null; if (!v) all = false; }
      if (all) any = true;
    }
    return any;
  }
  function conditionals(text, vars, issues) {
    // 1. one-line form: {{if x}}a{{else}}b{{endif}}
    const inline = /\{\{\s*if\s+([^}]*?)\s*\}\}(.*?)(?:\{\{\s*else\s*\}\}(.*?))?\{\{\s*endif\s*\}\}/g;
    let s = text.split('\n').map((line) => line.replace(inline, (all, cond, a, b) => {
      const v = evalCond(cond, vars); if (v == null) { issues.push({ type: 'if', msg: `Could not read condition: ${cond}` }); return all; }
      return v ? a : (b || '');
    })).join('\n');
    // 2. block form, one directive per line
    const out = [], stack = [];
    const active = () => stack.every((f) => f.on);
    const D = /^[ \t]*\{\{\s*(if|elif|else|endif)\b\s*(.*?)\s*\}\}[ \t]*$/;
    for (const line of s.split('\n')) {
      const d = D.exec(line);
      if (!d) { if (active()) out.push(line); continue; }
      const [, kind, rest] = d;
      if (kind === 'if') {
        let v = evalCond(rest, vars); if (v == null) { issues.push({ type: 'if', msg: `Could not read condition: ${rest}` }); v = true; }
        stack.push({ on: v, taken: v, parent: active() });
      } else if (kind === 'elif') {
        const f = stack[stack.length - 1]; if (!f) { issues.push({ type: 'if', msg: '{{elif}} without {{if}}' }); continue; }
        if (f.taken) f.on = false; else { let v = evalCond(rest, vars); if (v == null) { issues.push({ type: 'if', msg: `Could not read condition: ${rest}` }); v = false; } f.on = v; f.taken = v; }
      } else if (kind === 'else') {
        const f = stack[stack.length - 1]; if (!f) { issues.push({ type: 'if', msg: '{{else}} without {{if}}' }); continue; }
        f.on = !f.taken; f.taken = true;
      } else { if (!stack.pop()) issues.push({ type: 'if', msg: '{{endif}} without {{if}}' }); }
    }
    if (stack.length) issues.push({ type: 'if', msg: `${stack.length} {{if}} block${stack.length > 1 ? 's are' : ' is'} not closed with {{endif}}` });
    return out.join('\n');
  }

  /* ---------- {{name}} ---------- */
  const NOT_BODY = new Set(['page', 'pages']);        // page numbers exist only in headers and footers
  function substitute(text, vars, issues) {
    const seen = new Set();
    return text.replace(new RegExp(`(\\\\)?\\{\\{\\s*(${NAME})\\s*\\}\\}`, 'g'), (all, esc, name) => {
      if (esc) return all.slice(1);
      if (Object.prototype.hasOwnProperty.call(vars, name)) return String(vars[name]);
      if (!NOT_BODY.has(name) && !seen.has(name)) { seen.add(name); issues.push({ type: 'var', name, msg: `No value for {{${name}}} in the frontmatter` }); }
      return all;
    });
  }

  /* ---------- page-break and keep-together markers ---------- */
  function markers(text) {
    return text
      .replace(/^[ \t]*(?:<!--\s*(?:pagebreak|page-break|newpage)\s*-->|\\(?:pagebreak|newpage))[ \t]*$/gim, '\n<div class="pagebreak"></div>\n')
      .replace(/^[ \t]*<!--\s*keep\s*-->[ \t]*$/gim, '\n<div class="keep">\n')
      .replace(/^[ \t]*<!--\s*\/keep\s*-->[ \t]*$/gim, '\n</div>\n');
  }

  /* ---------- references and abbreviations from the frontmatter ---------- */
  const oneLine = (x) => String(x == null ? '' : x).replace(/\s*\n\s*/g, ' ').trim();
  function referencesMd(meta) {
    const a = meta && Array.isArray(meta.references) ? meta.references : null;
    if (!a || !a.length) return null;
    const used = new Set();
    return a.map((it, i) => {
      const o = it && typeof it === 'object' ? it : { text: it };
      let id = oneLine(o.id).replace(/[^\w:.\-]/g, '') || `ref${i + 1}`; while (used.has(id)) id += '_'; used.add(id);
      return `${i + 1}. <span class="refid" data-ref="${id}"></span>${oneLine(o.text != null ? o.text : o.title)}`;
    }).join('\n');
  }
  function abbreviationsMd(meta) {
    const a = meta && meta.abbreviations;
    let rows = [];
    if (Array.isArray(a)) rows = a.filter((x) => x && typeof x === 'object').map((x) => [x.term || x.abbreviation || x.name, x.meaning || x.definition || x.text]);
    else if (a && typeof a === 'object') rows = Object.entries(a);
    rows = rows.filter(([k]) => k != null && String(k).trim()).map(([k, v]) => [oneLine(k), oneLine(v)]);
    if (!rows.length) return null;
    rows.sort((x, y) => x[0].localeCompare(y[0], undefined, { sensitivity: 'base', numeric: true }));
    const cell = (x) => x.replace(/\|/g, '\\|');
    return '| Abbreviation | Meaning |\n|---|---|\n' + rows.map(([k, v]) => `| ${cell(k)} | ${cell(v)} |`).join('\n');
  }

  /* o: { meta, vars, fromPath, readInclude(raw, fromPath) -> { path, text } | null }
     returns { text, issues:[{type,msg,...}], used:[paths of included files] } */
  function preprocess(text, o = {}) {
    const issues = [], used = new Set();
    let t = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const fromPath = o.fromPath || '';
    t = expandIncludes(t, { readInclude: o.readInclude, fromPath, issues, used, stack: [fromPath] });
    const vars = Object.assign(varsFromMeta(o.meta), o.vars || {});
    const refs = referencesMd(o.meta), abbr = abbreviationsMd(o.meta);
    if (refs) vars.references = refs;
    if (abbr) vars.abbreviations = abbr;
    const m = mask(t);
    const placed = (name) => new RegExp(`^[ \\t]*\\{\\{\\s*${name}\\s*\\}\\}[ \\t]*$`, 'm').test(m.text);
    const wantsRefs = !!refs && !placed('references'), wantsAbbr = !!abbr && !placed('abbreviations');
    let s = conditionals(m.text, vars, issues);
    s = substitute(s, vars, issues);
    s = markers(s);
    s = m.restore(s);
    if (wantsAbbr) s = s.replace(/\s*$/, '') + `\n\n# Abbreviations\n\n${abbr}\n`;     // not placed by hand: added at the end
    if (wantsRefs) s = s.replace(/\s*$/, '') + `\n\n# References\n\n${refs}\n`;
    return { text: s, issues, used: [...used] };
  }

  return { preprocess, referencesMd, abbreviationsMd, expandIncludes, scanIncludes, varsFromMeta, evalCond, rebase, stripFrontmatter, mask, resolve, relPath, dirOf };
})();
if (typeof module !== 'undefined') module.exports = EngLayout;
