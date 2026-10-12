'use strict';
/* =====================================================================
   Engineering Document & Note Manager
   ===================================================================== */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STATUSES = ['DRAFT', 'PRELIMINARY', 'FOR REVIEW', 'APPROVED', 'RELEASED', 'OBSOLETE'];
const state = { md: '', format: 'visual', mode: 'view', toc: [], meta: null, db: null, dbOK: true,
  dir: null, files: [], filePath: null, fileHandle: null, lastMod: 0, dirty: false, needsReconnect: false, pendingFile: null,
  parentDir: null, diskText: '', conflictPaused: 0, hLines: [], eol: '\n' };

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), isErr ? 5000 : 2200);
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* =====================================================================
   IndexedDB – zero-dependency Promise wrapper
   ===================================================================== */
const DB = {
  open() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB not supported'));
      const req = indexedDB.open('EngineeringDocDB', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
    });
  },
  tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      let out;
      const tx = db.transaction('documents', mode);
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      const r = fn(tx.objectStore('documents'));
      if (r) r.onsuccess = () => (out = r.result);
    });
  },
  get: (db, id) => DB.tx(db, 'readonly', (s) => s.get(id)),
  put: (db, rec) => DB.tx(db, 'readwrite', (s) => s.put(rec)),
};

let lastSaveKind = 'saved';
function setSaveStatus(kind) {
  const el = $('#saveStatus');
  lastSaveKind = kind;
  el.className = kind === 'saving' ? 'saving' : kind === 'error' ? 'error' : '';
  const disk = !!(state.fileHandle && !state.needsReconnect);
  el.querySelector('span').textContent = kind === 'saving' ? 'Saving…' : kind === 'error' ? 'Not saved' : disk ? 'Saved to disk' : 'Draft in browser only';
  if (typeof renderTabs === 'function') renderTabs();
  el.title = kind === 'error' ? 'The last save failed' : disk ? 'Changes are saved automatically to the file in your folder' : 'No file in a folder is linked, so changes are saved automatically in this browser only';
}

/* Line endings: the editor always works in LF, so a file that arrived with CRLF (Windows) is written back with CRLF. */
const lf = (t) => t.replace(/\r\n/g, '\n');
const withEol = (t) => (state.eol === '\r\n' ? lf(t).replace(/\n/g, '\r\n') : t);
const eolOf = (t) => (/\r\n/.test(t) ? '\r\n' : '\n');

/* Writes the editor text to IndexedDB (always) and to the linked file in the open folder (when edited). */
async function writeFile(fh, text) {
  const w = await fh.createWritable();
  try { await w.write(text); } finally { await w.close(); }
  state.lastMod = (await fh.getFile()).lastModified;
}
async function doPersist() {
  const snap = state.md;
  let failed = false;
  if (state.db) {
    try {
      const parsed = parseDoc(snap);
      await DB.put(state.db, { id: 'active_document', markdown: snap, meta: parsed.meta || null, updated: Date.now() });
    } catch (e) {
      failed = true;
      console.error('IndexedDB write failed', e);
      toast('Autosave failed: ' + (e && e.message ? e.message : e) + ' (storage quota?)', true);
    }
  }
  if (state.fileHandle && state.dirty) {
    try {
      if (await resolveConflict(snap)) { const out = withEol(snap); await writeFile(state.fileHandle, out); state.diskText = out; if (state.md === snap) state.dirty = false; }
      else if (state.dirty) failed = true;
    }
    catch (e) { failed = true; console.error('File write failed', e); toast('Could not write ' + state.filePath + ': ' + (e && e.message ? e.message : e), true); }
  }
  setSaveStatus(failed || (!state.db && !state.fileHandle) ? 'error' : 'saved');
}
let saveChain = Promise.resolve();      // serialise saves so two writes never overlap
function persistNow() { saveChain = saveChain.then(doPersist).catch((e) => console.error(e)); return saveChain; }
const persistDebounced = debounce(persistNow, 400);

/* =====================================================================
   Frontmatter parsing + validation
   ===================================================================== */
function splitFrontmatter(text) {
  const m = text.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { yamlText: null, body: text };
  return { yamlText: m[1], body: text.slice(m[0].length) };
}

function validateMeta(m) {
  const w = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['Frontmatter is missing or is not a YAML mapping.'];
  const str = (k) => { if (typeof m[k] !== 'string' || !m[k].trim()) w.push(`"${k}" is missing or not a string.`); };
  str('doc_number'); str('title');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(m.date || ''))) w.push('"date" must be YYYY-MM-DD.');
  if (!STATUSES.includes(m.status)) w.push(`"status" must be one of: ${STATUSES.join(', ')}.`);
  for (const k of ['author', 'approver']) {
    const o = m[k];
    if (!o || typeof o !== 'object' || !o.name || !o.title) w.push(`"${k}" needs both "name" and "title".`);
  }
  if (!Array.isArray(m.compliance)) w.push('"compliance" must be a list of standards.');
  if (!Array.isArray(m.revisions) || !m.revisions.length) w.push('"revisions" must be a non-empty list.');
  else m.revisions.forEach((r, i) => {
    if (!r || typeof r !== 'object') return w.push(`revisions[${i}] is not an object.`);
    if (r.rev === undefined || r.rev === null || r.rev === '') w.push(`revisions[${i}].rev is missing.`);
    else if (typeof r.rev !== 'string') w.push(`revisions[${i}].rev should be quoted (e.g. "1.0"); unquoted 1.0 is read as the number 1.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date || ''))) w.push(`revisions[${i}].date must be YYYY-MM-DD.`);
    for (const k of ['author', 'approver', 'description']) if (!r[k]) w.push(`revisions[${i}].${k} is missing.`);
  });
  // Light guardrails: consistency checks that warn but never block
  const nm = (o) => (o && typeof o === 'object' && typeof o.name === 'string' ? o.name.trim().toLowerCase() : '');
  const last = Array.isArray(m.revisions) && m.revisions.length ? m.revisions[m.revisions.length - 1] : null;
  if (['APPROVED', 'RELEASED'].includes(m.status) && nm(m.author) && nm(m.author) === nm(m.approver)) w.push(`Status is ${m.status} but the author and approver are the same person (${m.author.name}).`);
  if (last && typeof last === 'object') {
    const chk = (label, top, rv) => { if (nm(top) && typeof rv === 'string' && rv.trim() && rv.trim().toLowerCase() !== nm(top)) w.push(`The active revision's ${label} ("${rv}") differs from the document ${label} ("${top.name}").`); };
    chk('author', m.author, last.author); chk('approver', m.approver, last.approver);
  }
  return w;
}

/* Returns { meta (normalised or null), warnings[], body } */
function parseDoc(text) {
  const { yamlText, body } = splitFrontmatter(text);
  if (yamlText === null) return { meta: null, warnings: [], note: true, body };   // plain note: no frontmatter, no issues
  let meta;
  try {
    // CORE_SCHEMA keeps YYYY-MM-DD as a string instead of a Date object
    meta = jsyaml.load(yamlText, { schema: jsyaml.CORE_SCHEMA });
  } catch (e) {
    return { meta: null, warnings: ['YAML error: ' + (e.reason || e.message)], body, yamlError: true };
  }
  const CONTROLLED = ['doc_number', 'status', 'revisions', 'author', 'approver', 'compliance', 'classification'];
  if (meta === null || meta === undefined || (typeof meta === 'object' && !Array.isArray(meta) && !CONTROLLED.some((k) => k in meta))) {
    const m = meta || {}, w = [];
    if ('title' in m && typeof m.title !== 'string') w.push('"title" should be text.');
    if ('date' in m) { m.date = String(m.date); if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date)) w.push('"date" should be YYYY-MM-DD.'); }
    return { meta: m, warnings: w, note: true, body };
  }
  const warnings = validateMeta(meta);
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    if (Array.isArray(meta.revisions)) meta.revisions = meta.revisions.filter((r) => r && typeof r === 'object').map((r) => ({ ...r, rev: String(r.rev ?? ''), date: String(r.date ?? '') }));
    meta.date = String(meta.date ?? '');
    return { meta, warnings, body };
  }
  return { meta: null, warnings, body };
}
const activeRev = (meta) => (meta && Array.isArray(meta.revisions) && meta.revisions.length ? meta.revisions[meta.revisions.length - 1] : null);
const statusClass = (s) => 'st-' + (STATUSES.includes(s) ? s.replace(' ', '-') : 'UNKNOWN');

/* =====================================================================
   Prism: IEC 61131-3 Structured Text + language aliases
   ===================================================================== */
try {
  Prism.languages.iecst = {
    comment: [{ pattern: /\(\*[\s\S]*?\*\)/, greedy: true }, { pattern: /\/\/.*/, greedy: true }],
    string: { pattern: /'(?:\$.|[^'$\r\n])*'|"(?:\$.|[^"$\r\n])*"/, greedy: true },
    number: [/\b(?:L?TIME|T|LT|D|DT|TOD|DATE)#[\w:.\-]+/i, /\b(?:16|8|2)#[0-9a-f_]+\b/i, /\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b/i],
    'class-name': /\b(?:BOOL|BYTE|WORD|DWORD|LWORD|SINT|INT|DINT|LINT|USINT|UINT|UDINT|ULINT|REAL|LREAL|TIME|LTIME|DATE|TOD|DT|STRING|WSTRING|CHAR|WCHAR|ANY\w*|POINTER|REFERENCE|ARRAY|STRUCT)\b/i,
    function: /\b(?:TON|TOF|TP|CTU|CTD|CTUD|R_TRIG|F_TRIG|RS|SR|ABS|SQRT|LN|LOG|EXP|SIN|COS|TAN|ASIN|ACOS|ATAN|MIN|MAX|LIMIT|SEL|MUX|SHL|SHR|ROL|ROR|TRUNC|[A-Z]+_TO_[A-Z]+|LEN|LEFT|RIGHT|MID|CONCAT|INSERT|DELETE|REPLACE|FIND)(?=\s*\()/i,
    keyword: /\b(?:PROGRAM|END_PROGRAM|FUNCTION_BLOCK|END_FUNCTION_BLOCK|FUNCTION|END_FUNCTION|METHOD|END_METHOD|ACTION|END_ACTION|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|VAR_EXTERNAL|VAR_CONFIG|VAR|END_VAR|CONSTANT|RETAIN|PERSISTENT|AT|IF|THEN|ELSIF|ELSE|END_IF|CASE|OF|END_CASE|FOR|TO|BY|DO|END_FOR|WHILE|END_WHILE|REPEAT|UNTIL|END_REPEAT|EXIT|CONTINUE|RETURN|TYPE|END_TYPE|END_STRUCT|CONFIGURATION|END_CONFIGURATION|RESOURCE|END_RESOURCE|TASK|STEP|END_STEP|TRANSITION|END_TRANSITION)\b/i,
    boolean: /\b(?:TRUE|FALSE)\b/i,
    operator: /:=|=>|<>|<=|>=|\*\*|[-+*\/<>=&]|\b(?:AND|OR|XOR|NOT|MOD)\b/i,
    punctuation: /[;:,.()\[\]]/,
  };
} catch (e) { console.warn('Could not define IEC ST grammar for Prism:', e); }

const LANG_ALIAS = { python: 'python', py: 'python', c: 'c', cpp: 'cpp', cxx: 'cpp', 'c++': 'cpp', arduino: 'cpp', ino: 'cpp', iecst: 'iecst', st: 'iecst', scl: 'iecst', plc: 'iecst' };

function highlightCode(code, lang) {
  const key = LANG_ALIAS[(lang || '').toLowerCase()];
  try {
    if (key && window.Prism && Prism.languages[key]) return Prism.highlight(code, Prism.languages[key], key);
  } catch (e) { console.warn('Prism tokenisation failed for', lang, e); }
  return esc(code);
}

/* =====================================================================
   Markdown pipeline: protect code → protect math → marked → restore math
   ===================================================================== */
function protect(src) {
  const codes = [], maths = [];
  let s = src;
  // 1. fenced code, 2. inline code (so math regexes never run inside code)
  s = s.replace(/^(```|~~~)[^\n]*\n[\s\S]*?\n\1[^\n]*$/gm, (m) => { codes.push(m); return `ZZCODE${codes.length - 1}ZZ`; });
  s = s.replace(/(`+)(?!`)[^\n]*?[^`\n]\1(?!`)/g, (m) => { codes.push(m); return `ZZCODE${codes.length - 1}ZZ`; });
  // 3. math (display first, then inline)
  const stash = (tex, display) => { maths.push({ tex: tex.trim(), display }); return `ZZMATH${maths.length - 1}ZZ`; };
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m, t) => stash(t, true));
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (m, t) => stash(t, true));
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (m, t) => stash(t, false));
  s = s.replace(/(?<![\\$])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\d$])/g, (m, t) => stash(t, false));
  // restore code before marked sees the text
  s = s.replace(/ZZCODE(\d+)ZZ/g, (m, i) => codes[+i]);
  return { text: s, maths };
}

/* Token ranges of a code block for the in-place editor (same Prism grammars as the preview and PDF) */
function codeTokens(code, lang) {
  const key = LANG_ALIAS[(lang || '').toLowerCase()];
  if (!key || !window.Prism || !Prism.languages[key]) return [];
  const out = []; let pos = 0;
  const walk = (t) => {
    if (typeof t === 'string') { pos += t.length; return; }
    const start = pos, c = t.content;
    if (Array.isArray(c)) c.forEach(walk); else if (typeof c === 'string') pos += c.length; else if (c) walk(c);
    const al = t.alias ? ' ' + [].concat(t.alias).join(' ') : '';
    out.push({ from: start, to: pos, cls: 'token ' + t.type + al });
  };
  try { Prism.tokenize(code, Prism.languages[key]).forEach(walk); } catch (e) { console.warn('Prism tokenisation failed for', lang, e); return []; }
  return out;
}

function renderMath(m) {
  if (typeof katex === 'undefined') return `<span class="math-err">${esc(m.tex)}</span>`;
  try {
    const html = katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false, errorColor: '#dc2626', strict: 'ignore', output: 'htmlAndMathml' });
    return m.display ? `<span class="math-block">${html}</span>` : html;
  } catch (e) {
    console.warn('KaTeX error', e);
    return `<span class="math-err" title="${esc(e.message)}">${esc(m.tex)}</span>`;
  }
}

function safeUrl(u) { return /^\s*(javascript|vbscript):/i.test(u || '') ? '#' : u; }

/* opts: prefix (heading id prefix), light (skip KaTeX/Prism/images – used for TOC only), interactive (enable checkboxes) */
function renderBody(src, opts = {}) {
  const { prefix = 'sec-', light = false, interactive = false, numbered = true } = opts;
  const { text, maths } = protect(src);
  const toc = [], cnt = [0, 0, 0, 0];
  let hIdx = 0, taskIdx = 0, imgIdx = 0;

  const plain = (raw) => String(raw).replace(/ZZMATH(\d+)ZZ/g, (m, i) => maths[+i].tex).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  const renderer = {
    heading(t, level, raw) {
      const i = hIdx++;
      let num = '';
      if (level <= 4) {
        cnt[level - 1]++;
        for (let k = level; k < 4; k++) cnt[k] = 0;
        num = level === 1 ? `${cnt[0]}.0` : cnt.slice(0, level).join('.');
        if (!numbered) num = '';
        toc.push({ id: prefix + i, level, num, title: plain(raw) });
      }
      return `<h${level} id="${prefix}${i}">${num ? `<span class="hnum">${num}</span>` : ''}${t}</h${level}>\n`;
    },
    code(code, infostring) {
      const lang = ((infostring || '').match(/^\S*/) || [''])[0];
      if (light) return '<pre><code></code></pre>';
      const clean = code.replace(/\n$/, '');
      const rows = clean.split('\n').map((_, k) => k + 1).join('\n');
      return `<div class="codeblock"><span class="lang">${esc(lang)}</span><button type="button" class="copy-btn">Copy</button><pre class="language-${esc(lang || 'text')}"><span class="ln">${rows}</span><code>${highlightCode(clean, lang)}</code></pre></div>\n`;
    },
    image(href, title, alt) {
      if (light) return '';
      const imgN = imgIdx++;
      let a = alt || '', style = '';
      const p = a.lastIndexOf('|');
      if (p >= 0) {
        const size = a.slice(p + 1).trim();
        if (/^\d+(?:\.\d+)?(?:px|%)?$/.test(size)) { a = a.slice(0, p).trim(); style = `width:${/\D$/.test(size) ? size : size + 'px'};`; }
      }
      if (!/^(data:|https?:|blob:|\/\/)/i.test(href || '')) return `<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-asset="${esc(href)}" data-img="${imgN}" alt="${esc(a)}"${title ? ` title="${esc(title)}"` : ''} style="${style}max-width:100%;height:auto">`;
      return `<img data-img="${imgN}" src="${esc(safeUrl(href))}" alt="${esc(a)}"${title ? ` title="${esc(title)}"` : ''} style="${style}max-width:100%;height:auto">`;
    },
    tablecell(content, flags) {
      const tag = flags.header ? 'th' : 'td', al = flags.align ? ` align="${flags.align}"` : '';
      const m = !flags.header && /^\s*\[([ xX])\]\s*$/.exec(content);
      return `<${tag}${al}>${m ? `<input type="checkbox" class="cellcb"${m[1] === ' ' ? '' : ' checked'}>` : content}</${tag}>\n`;
    },
    checkbox(checked) {
      const n = taskIdx++;
      return `<input type="checkbox" class="task" data-i="${n}"${checked ? ' checked' : ''}${interactive ? '' : ' disabled'}> `;
    },
  };

  let html;
  try {
    html = new marked.Marked({ gfm: true, breaks: false, renderer }).parse(text);
  } catch (e) {
    console.error('Markdown parse failed', e);
    html = `<pre class="math-err">${esc(e.message)}</pre>`;
  }
  html = html.replace(/ZZMATH(\d+)ZZ/g, (m, i) => (light ? '' : renderMath(maths[+i])));
  if (!light) html = sanitize(html);
  return { html, toc };
}

const stripData = (s) => s.replace(/\(data:[^)\s]*\)/g, '(data:)');

/* =====================================================================
   Document card (screen) and rendering
   ===================================================================== */
function docCardHTML(meta, warnings, canFix, note) {
  if (note) {
    const bar = !meta && canFix ? '<div class="notebar">Plain note (no document header). It prints as a simple page. <button type="button" class="fix-fm">Make controlled document</button></div>' : '';
    const warn = warnings.length ? `<div class="warnbox"><b>Frontmatter issues</b><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';
    return bar + warn;
  }
  const fix = canFix ? '<button type="button" class="fix-fm">Fill missing fields with defaults</button>' : '';
  if (!meta) return warnings.length ? `<div class="doccard"><div class="warnbox"><b>Frontmatter problem</b><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>${fix}</div></div>` : '';
  const r = activeRev(meta);
  return `<div class="doccard">
    <div class="t">${esc(meta.title || 'Untitled')}</div>
    <div class="m"><span><b>${esc(meta.doc_number || '—')}</b></span>
      <span class="badge ${statusClass(meta.status)}">${esc(meta.status || 'NO STATUS')}</span>
      <span>Rev <b>${esc(r ? r.rev : '—')}</b>${r ? ' · ' + esc(r.date) : ''}</span>
      <span>Author: ${esc(meta.author && meta.author.name)}</span><span>Approver: ${esc(meta.approver && meta.approver.name)}</span></div>
    ${Array.isArray(meta.compliance) && meta.compliance.length ? `<div class="m">Standards: ${meta.compliance.map(esc).join(' · ')}</div>` : ''}
    ${warnings.length ? `<div class="warnbox"><b>Frontmatter issues</b><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>${fix}</div>` : ''}
  </div>`;
}

const previewVisible = () => state.format === 'visual' && state.mode === 'view';   // the rendered page exists only in View-Only; editing is in the one editor

function refresh() {
  const parsed = parseDoc(state.md);
  state.meta = parsed.meta;
  const badge = $('#issuesBadge');
  if (parsed.warnings.length) { badge.style.display = ''; badge.textContent = `⚠ ${parsed.warnings.length} frontmatter issue${parsed.warnings.length > 1 ? 's' : ''}`; badge.title = parsed.warnings.join('\n'); }
  else badge.style.display = 'none';
  badge.onclick = () => toast(parsed.warnings.join('  |  '), true);

  let res;
  try {
    if (previewVisible()) {
      res = renderBody(parsed.body, { interactive: true, numbered: !parsed.note });
      const p = $('#preview');
      const keep = p.scrollTop;
      p.innerHTML = `<div class="page doc">${docCardHTML(parsed.note && !parsed.meta ? null : parsed.meta, parsed.warnings, parsed.note ? state.mode === 'edit' : !parsed.yamlError, parsed.note)}${res.html}</div>`;
      p.scrollTop = keep;
      applyAssets(p).catch((e) => console.warn(e));
      decoratePreview();
    } else {
      res = renderBody(stripData(parsed.body), { light: true, numbered: !parsed.note });
    }
  } catch (e) {
    console.error('Render failed', e);
    toast('Render error: ' + e.message, true);
    return;
  }
  state.toc = res.toc;
  renderTOC();
  state.hLines = headingLines(parsed.body);
  updateActiveToc();
  updateStats();
  document.title = (parsed.meta && parsed.meta.doc_number ? parsed.meta.doc_number + ' – ' : '') + 'Engineering Document & Note Manager';
}
let rdTimer = null;
const refreshDebounced = () => { clearTimeout(rdTimer); rdTimer = setTimeout(() => (cellEdit ? refreshDebounced() : refresh()), 150); };
refreshDebounced.cancel = () => clearTimeout(rdTimer);

function renderTOC() {
  const nav = $('#tocList');
  $('#tocEmpty').style.display = state.toc.length ? 'none' : 'block';
  nav.innerHTML = state.toc.map((t) => `<a href="#${t.id}" class="l${t.level}" data-id="${t.id}"><span class="num">${t.num}</span>${esc(t.title)}</a>`).join('');
}

function scrollToHeading(id) {
  if (previewVisible()) {
    const el = document.getElementById(id);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  }
  // Raw view: jump the editor to the heading's source line
  const n = parseInt(id.replace(/^\D+/, ''), 10), ln = (state.hLines || [])[n];
  if (ln) editor.gotoLine(ln);
}

/* =====================================================================
   Layout / toggles
   ===================================================================== */
function applyLayout() {
  const layout = state.format === 'raw' ? 'raw' : state.mode === 'edit' ? 'visual-edit' : 'visual-view';
  $('#content').dataset.layout = layout;
  const editing = state.mode === 'edit';
  editor.setReadOnly(!editing);
  $('#segFormat').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.format));
  $('#segMode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.mode));
  $('#formatBar').style.display = editing ? 'flex' : 'none';
  try { editor.setLive(state.format === 'visual'); } catch (e) { console.error('Visual layout', e); }   // Visual = formatted in place, Raw = plain Markdown
  if (editing && typeof updateFormatBar === 'function') updateFormatBar();
  refresh();
  if (editing) setTimeout(() => editor.focus(), 0);
}
$('#segFormat').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.format = b.dataset.v; applyLayout(); } });
$('#segMode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.mode = b.dataset.v; applyLayout(); } });
const mqMobile = window.matchMedia('(max-width: 760px)');
function isMobile() { return mqMobile.matches; }
function setDrawer(open) { document.body.classList.toggle('drawer-open', open); $('#btnSide').setAttribute('aria-expanded', String(open)); }
$('#btnSide').addEventListener('click', () => { if (isMobile()) setDrawer(!document.body.classList.contains('drawer-open')); else document.body.classList.toggle('no-side'); });
$('#sideBackdrop').addEventListener('click', () => setDrawer(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('drawer-open') && ctxEl.hidden && !document.querySelector('dialog[open]')) setDrawer(false); });
mqMobile.addEventListener('change', () => setDrawer(false));
function setTocOpen(open, remember = true) {
  $('#tocSec').classList.toggle('collapsed', !open); document.body.classList.toggle('toc-collapsed', !open);
  $('#tocHead').setAttribute('aria-expanded', String(open));
  if (remember) { sideCfg.tocOpen = open; saveSideCfg(); }
}
$('#tocList').addEventListener('click', (e) => { const a = e.target.closest('a'); if (a) { e.preventDefault(); scrollToHeading(a.dataset.id); if (isMobile()) setDrawer(false); } });

/* Resizable divider */
(() => {
  const d = $('#divider');
  d.addEventListener('pointerdown', (e) => {
    d.setPointerCapture(e.pointerId); d.classList.add('drag');
    const move = (ev) => document.documentElement.style.setProperty('--side-w', Math.min(Math.max(ev.clientX, 160), window.innerWidth * 0.6) + 'px');
    const up = () => { d.classList.remove('drag'); d.removeEventListener('pointermove', move); d.removeEventListener('pointerup', up); };
    d.addEventListener('pointermove', move); d.addEventListener('pointerup', up);
  });
})();

/* Editor (CodeMirror 6, vendored) */
function onEditorChange() {
  state.md = editor.getValue();
  state.dirty = true;
  setSaveStatus('saving');
  persistDebounced();
  refreshDebounced();
}
let editor;
try {
  editor = EngEditor.createEditor($('#editorHost'), {
    readOnly: true,
    onChange: onEditorChange,
    onSelection: (c) => { updateCursorStatus(c); updateFormatBar(); },
    onLink: () => openLinkDialog(),
    live: true,                                    // Visual draws the document in place; applyLayout() switches it off for Raw Markdown
    assets: (root) => applyAssets(root),            // live-preview images reuse the preview's asset loader
    renderInline: (md) => renderCellInline(md),     // live-preview table cells
    tableTools: () => ({ scan: scanTables, format: formatTable }),
    frontCard: (text) => frontCardHTML(text),       // Visual: frontmatter shown as a compact document card
    headingNumbers: (md) => !parseDoc(md).note,
    mathHTML: (tex, display) => renderMath({ tex, display }),
    codeTokens: (code, lang) => codeTokens(code, lang),
    toast: (m, bad) => toast(m, bad),
    onScroll: () => onEditorScroll(),
    onImageFiles: (files) => insertImageFiles(files),
    onCommand: (c) => { if (c === 'image') $('#fileImage').click(); },
    onWrap: (w) => { $('#btnWrap').textContent = w ? 'Wrap: on' : 'Wrap: off'; },
  });
} catch (e) {
  console.error('Editor failed to load', e);
  $('#editorHost').textContent = 'The editor failed to load: ' + e.message;
  editor = new Proxy({}, { get: (_, k) => (k === 'getValue' ? () => state.md : () => {}) });
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); setSaveStatus('saving'); persistNow(); }
});

/* Copy buttons + interactive task list */
document.addEventListener('click', async (e) => {
  const cb = e.target.closest('.copy-btn');
  if (cb) {
    const code = cb.closest('.codeblock').querySelector('code').textContent;
    try { await navigator.clipboard.writeText(code); }
    catch { const ta = document.createElement('textarea'); ta.value = code; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch {} ta.remove(); }
    cb.textContent = 'Copied'; setTimeout(() => (cb.textContent = 'Copy'), 1200);
  }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (!t.classList || !t.classList.contains('task')) return;
  toggleTask(+t.dataset.i);
});
function toggleTask(n) {
  const fm = splitFrontmatter(state.md);
  const head = state.md.slice(0, state.md.length - fm.body.length);
  const lines = fm.body.split('\n');
  let fence = false, c = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    const m = lines[i].match(/^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/);
    if (m && ++c === n) { lines[i] = lines[i].replace(m[0], m[1] + (m[2] === ' ' ? 'x' : ' ') + m[3]); break; }
  }
  setMarkdown(head + lines.join('\n'), { fromUser: true });
}

function setMarkdown(text, { fromUser = false, seed = false } = {}) {
  state.md = text;
  state.dirty = !seed;
  if (seed || !fromUser) editor.setValue(text); else editor.replaceAll(text);   // replaceAll = one undoable change
  if (!seed) { setSaveStatus('saving'); persistDebounced(); }
  fromUser ? refreshDebounced() : refresh();
}

/* =====================================================================
   Image ingestion & client-side compression
   (stored as files in assets/ when a folder is open, otherwise embedded as base64)
   ===================================================================== */
const blobToDataURL = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
const canvasBlob = (canvas, type, q) => new Promise((res) => canvas.toBlob(res, type, q));
const EXT = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/gif': 'gif' };

async function compressImage(file) {
  if (file.type === 'image/svg+xml' || file.type === 'image/gif') return { blob: file, ext: EXT[file.type] };   // vector / animated: keep as is
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not decode image')); i.src = url; });
    let w = img.naturalWidth, h = img.naturalHeight;
    const MAX = 1600;
    if (Math.max(w, h) > MAX) { const k = MAX / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k); }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    let blob = await canvasBlob(canvas, 'image/webp', 0.80);
    if (!blob || blob.type !== 'image/webp') {                           // browser cannot encode WebP
      let alpha = false;
      if (file.type !== 'image/jpeg') { const d = ctx.getImageData(0, 0, w, h).data; for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { alpha = true; break; } }
      blob = alpha ? await canvasBlob(canvas, 'image/png') : await canvasBlob(canvas, 'image/jpeg', 0.82);
    }
    return { blob, ext: EXT[blob.type] || 'png' };
  } finally { URL.revokeObjectURL(url); }
}

async function insertImageFile(file) {
  if (state.mode !== 'edit') { toast('Switch to Edit mode to insert images.', true); return; }
  try {
    toast('Processing image…');
    const img = await compressImage(file);
    let alt = (file.name || '').replace(/\.[^.]+$/, '').replace(/[\[\]|]/g, ' ').trim();
    if (!alt || /^(image|screenshot|clipboard|unnamed|untitled|pasted)/i.test(alt)) alt = 'Figure';
    let src, note = '';
    if (state.fileHandle && state.parentDir && !state.needsReconnect) src = await saveAsset(img);
    else { src = await blobToDataURL(img.blob); note = ' – open a folder to store images as files instead'; }
    editor.insertText(`![${alt}|450px](${src})`);
    toast(src.startsWith('data:') ? 'Image embedded (' + Math.round(src.length / 1024) + ' KB)' + note : 'Image saved to ' + src);
  } catch (err) { console.error(err); toast('Image failed: ' + err.message, true); }
}
async function insertImageFiles(files) { for (const f of files) await insertImageFile(f); }
$('#fileImage').addEventListener('change', async (e) => { await insertImageFiles([...e.target.files]); e.target.value = ''; });

/* =====================================================================
   File portability
   ===================================================================== */
$('#btnDownload').addEventListener('click', async () => {
  try {
    let text = state.md;
    if (state.dir && /!\[[^\]]*\]\((?!data:|https?:|blob:)[^)\s]+\)/i.test(text)
        && confirm('This document links to image files in your folder.\n\nOK = embed them in the downloaded copy so it works anywhere\nCancel = keep the relative links')) text = await embedAssets(text);
    const name = (state.meta && state.meta.doc_number ? state.meta.doc_number : 'document').replace(/[^\w.\-]+/g, '_');
    const rev = activeRev(state.meta);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([withEol(text)], { type: 'text/markdown;charset=utf-8' }));
    a.download = `${name}${rev ? '_Rev' + String(rev.rev).replace(/[^\w.\-]+/g, '') : ''}.md`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (e) { console.error(e); toast('Download failed: ' + e.message, true); }
});
$('#btnOpen').addEventListener('click', () => $('#fileOpen').click());
$('#fileOpen').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const text = await f.text();
    if (state.dirty) await persistNow();
    state.fileHandle = null; state.filePath = null; state.parentDir = null; updateFileLabel(); renderFiles();   // imported file is not linked to the folder
    setMarkdown(text);
    await persistNow();
    toast('Opened ' + f.name);
  } catch (err) { toast('Could not open file: ' + err.message, true); }
});

/* =====================================================================
   PDF export (strict A4 via CSS paged media)
   ===================================================================== */
const cssStr = (s) => '"' + String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ') + '"';

function buildNotePrint(parsed) {
  const base = effectivePage(parsed.meta);
  const hasPs = parsed.meta && parsed.meta.page_setup && typeof parsed.meta.page_setup === 'object';
  const pg = hasPs ? base : { ...base, header_left: '{title}', header_centre: '', header_right: (parsed.meta && parsed.meta.date) ? '{date}' : '{today}', footer_left: '', footer_centre: '', footer_right: 'Page {page} of {pages}' };
  const meta = parsed.meta || {};
  const vals = printVals({ title: meta.title || guessTitle(parsed.body), date: meta.date || '' });
  const res = renderBody(parsed.body, { prefix: 'p-', numbered: false });
  $('#printRoot').innerHTML = `<section class="doc body">${res.html}</section>`;
  applyAssets($('#printRoot')).catch((e) => console.warn(e));
  const rule = '0.4pt solid #94a3b8';
  const box = `font: ${pg.font_size}pt Arial, Helvetica, sans-serif; color: #334155; white-space: nowrap;`;
  const mb = (pos, tpl) => { const edge = pos.startsWith('top') ? 'bottom' : 'top'; return `@${pos} { content: ${tplToCss(tpl, vals)}; ${box} ${pg.rule ? `border-${edge}: ${rule}; padding-${edge}: 2mm;` : ''} }`; };
  $('#printPageStyle').textContent = `@media print { @page { size: A4; ${['top-left','top-center','top-right','bottom-left','bottom-center','bottom-right'].map((p, i) => mb(p, [pg.header_left, pg.header_centre, pg.header_right, pg.footer_left, pg.footer_centre, pg.footer_right][i])).join('\n')} } }`;
}

function buildPrint() {
  const parsed = parseDoc(state.md);
  if (parsed.note) return buildNotePrint(parsed);
  const m = parsed.meta || {};
  const r = activeRev(parsed.meta) || { rev: '—', date: '' };
  const status = m.status || 'NO STATUS';
  const cls = m.classification || settings.defaults.classification;
  const pg = effectivePage(parsed.meta);
  const vals = printVals(parsed.meta);
  const res = renderBody(parsed.body, { prefix: 'p-' });
  const watermark = pg.watermark && (status === 'DRAFT' || status === 'FOR REVIEW');
  const signed = status === 'APPROVED' || status === 'RELEASED';

  const person = (label, p, date, sign) => `<div class="cv-box"><h3>${label}</h3><div class="nm">${esc(p && p.name)}</div><div>${esc(p && p.title)}</div>
    <div class="sg">Signature &nbsp;·&nbsp; Date: ${date ? esc(date) : '____ / ____ / ________'}</div></div>`;

  const cover = `<section class="cover">
    <div class="cv-co">ENGINEERING DOCUMENT</div>
    <h1 class="cv-title">${esc(m.title || 'Untitled')}</h1>
    <div class="cv-docno">${esc(m.doc_number || '—')}</div>
    <span class="badge ${statusClass(status)}">${esc(status)}</span>
    <div class="cv-grid">
      <div class="cv-box"><h3>Current revision</h3><div class="nm">Rev ${esc(r.rev)}</div><div>${esc(r.date)}</div></div>
      <div class="cv-box"><h3>Document date / classification</h3><div class="nm">${esc(m.date || '')}</div><div>${esc(cls)}</div></div>
      ${person('Author', m.author, r.date)}
      ${person('Approver', m.approver, signed ? r.date : '')}
      <div class="cv-box cv-wide"><h3>Applicable compliance standards</h3>
        ${Array.isArray(m.compliance) && m.compliance.length ? `<ul>${m.compliance.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '<div>None listed.</div>'}</div>
    </div></section>`;

  const revRows = (Array.isArray(m.revisions) ? m.revisions : []).map((x) => `<tr><td>${esc(x.rev)}</td><td>${esc(x.date)}</td><td>${esc(x.description)}</td><td>${esc(x.ecn || '—')}</td><td>${esc(x.author)}</td><td>${esc(x.approver)}</td></tr>`).join('');
  const tocItems = res.toc.map((t) => `<li class="l${t.level}"><span class="n">${t.num}</span><a href="#${t.id}">${esc(t.title)}</a><span class="dots"></span></li>`).join('');
  const control = `<section class="docctl doc">
    <h2 class="ctl">Revision History</h2>
    <table class="revtbl"><colgroup><col style="width:9%"><col style="width:15%"><col><col style="width:14%"><col style="width:15%"><col style="width:15%"></colgroup><thead><tr><th>Rev</th><th>Date</th><th>Description</th><th>ECN / Ref</th><th>Prepared By</th><th>Approved By</th></tr></thead><tbody>${revRows || '<tr><td colspan="6">No revisions recorded.</td></tr>'}</tbody></table>
    <h2 class="ctl second">Table of Contents</h2><ul class="tocp">${tocItems || '<li>No headings.</li>'}</ul></section>`;

  const body = `<section class="doc body">${res.html}</section>`;
  const wm = watermark ? `<div class="wm${status.length > 6 ? ' long' : ''}">${esc(status)}</div>` : '';
  $('#printRoot').innerHTML = wm + cover + control + body;
  applyAssets($('#printRoot')).catch((e) => console.warn(e));   // cached images resolve immediately; the rest are awaited by the export button

  // Running headers/footers are page-margin boxes (Chromium 131+). Literal strings are injected here because
  // margin boxes cannot read document text. Cover page ("cover" named page) suppresses all four.
  const rule = '0.4pt solid #94a3b8';
  const box = `font: ${pg.font_size}pt Arial, Helvetica, sans-serif; color: #334155; white-space: nowrap;`;
  const mb = (pos, tpl) => {
    const edge = pos.startsWith('top') ? 'bottom' : 'top';
    return `@${pos} { content: ${tplToCss(tpl, vals)}; ${box} ${pg.rule ? `border-${edge}: ${rule}; padding-${edge}: 2mm;` : ''} }`;
  };
  const noCover = pg.on_cover ? '' : `@page cover { @top-left{content:' ';border:0} @top-center{content:' ';border:0} @top-right{content:' ';border:0}
                  @bottom-left{content:' ';border:0} @bottom-center{content:' ';border:0} @bottom-right{content:' ';border:0} }`;
  $('#printPageStyle').textContent = `@media print {
    @page { size: A4;
      ${mb('top-left', pg.header_left)}
      ${mb('top-center', pg.header_centre)}
      ${mb('top-right', pg.header_right)}
      ${mb('bottom-left', pg.footer_left)}
      ${mb('bottom-center', pg.footer_centre)}
      ${mb('bottom-right', pg.footer_right)}
    }
    ${noCover}
  }`;
}

$('#btnPdf').addEventListener('click', async () => {
  try {
    buildPrint();
    toast('In the print dialog, untick “Headers and footers” (More settings) so Chrome does not add its own.');
    await applyAssets($('#printRoot'));
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await new Promise((r) => setTimeout(r, 150));
    window.print();
  } catch (e) { console.error(e); toast('PDF export failed: ' + e.message, true); }
});
window.addEventListener('beforeprint', () => { try { buildPrint(); } catch (e) { console.error(e); } });   // also covers Ctrl+P
window.addEventListener('afterprint', () => { $('#printRoot').innerHTML = ''; $('#printPageStyle').textContent = ''; });

/* =====================================================================
   PWA: install prompt + service worker
   ===================================================================== */
let deferredPrompt = null;
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; if (!standalone()) $('#btnInstall').style.display = ''; });
window.addEventListener('appinstalled', () => { deferredPrompt = null; $('#btnInstall').style.display = 'none'; });
$('#btnInstall').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  try { deferredPrompt.prompt(); await deferredPrompt.userChoice; } catch (e) { console.warn(e); }
  deferredPrompt = null; $('#btnInstall').style.display = 'none';
});
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (nw) nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdate(reg); });
      });
      setInterval(() => reg.update().catch(() => {}), 3600000);
    }).catch((e) => console.warn('Service worker registration failed:', e));
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!hadController) { hadController = true; return; } location.reload(); });
  });
}

/* =====================================================================
   Seed + boot
   ===================================================================== */
/* =====================================================================
   Settings: header/footer + new-document defaults
   ===================================================================== */
const SETTINGS_KEY = 'engdocs.settings.v1';
const DEFAULT_SETTINGS = {
  page: {
    header_left: '{doc_number}  ·  {title}', header_centre: '', header_right: 'Rev {rev}',
    footer_left: '{status}  ·  {classification}', footer_centre: '', footer_right: 'Page {page} of {pages}',
    font_size: 8.5, rule: true, on_cover: false, watermark: true,
  },
  defaults: {
    authorName: 'Author Name', authorTitle: 'Engineer', approverName: 'Approver Name', approverTitle: 'Engineering Manager',
    classification: 'Uncontrolled when printed', compliance: ['ISO 9001:2015'],
  },
};
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { page: { ...DEFAULT_SETTINGS.page, ...s.page }, defaults: { ...DEFAULT_SETTINGS.defaults, ...s.defaults } };
  } catch { return { page: { ...DEFAULT_SETTINGS.page }, defaults: { ...DEFAULT_SETTINGS.defaults } }; }
}
let settings = loadSettings();
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { toast('Could not store settings: ' + e.message, true); } }

/* A document's own page_setup (frontmatter) overrides the browser-wide setting */
function effectivePage(meta) {
  const o = meta && meta.page_setup && typeof meta.page_setup === 'object' && !Array.isArray(meta.page_setup) ? meta.page_setup : {};
  const pg = { ...settings.page, ...o };
  pg.font_size = Math.min(14, Math.max(6, parseFloat(pg.font_size) || 8.5));
  return pg;
}
function printVals(meta) {
  const m = meta || {}, r = activeRev(m);
  return {
    doc_number: m.doc_number || '', title: m.title || '', rev: r ? r.rev : '—', status: m.status || '',
    classification: m.classification || settings.defaults.classification, date: m.date || '',
    author: (m.author && m.author.name) || '', approver: (m.approver && m.approver.name) || '', today: today(),
  };
}
/* "Page {page} of {pages}" → `"Page " counter(page) " of " counter(pages)` for @page margin boxes */
function tplToCss(tpl, vals) {
  const parts = [];
  const lit = (s) => { if (s) parts.push(cssStr(s)); };
  const re = /\{(\w+)\}/g;
  let last = 0, m;
  tpl = String(tpl ?? '');
  while ((m = re.exec(tpl))) {
    lit(tpl.slice(last, m.index));
    const k = m[1];
    if (k === 'page') parts.push('counter(page)');
    else if (k === 'pages') parts.push('counter(pages)');
    else if (k in vals) lit(String(vals[k] ?? ''));
    else lit(m[0]);
    last = re.lastIndex;
  }
  lit(tpl.slice(last));
  return parts.length ? parts.join(' ') : '""';
}

/* =====================================================================
   New-document template + "fill missing frontmatter"
   ===================================================================== */
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const dumpYaml = (o) => jsyaml.dump(o, { schema: jsyaml.CORE_SCHEMA, lineWidth: -1, noRefs: true });
const titleFromName = (p) => p.split('/').pop().replace(/\.(md|markdown)$/i, '').replace(/[-_]+/g, ' ').trim() || 'Untitled Document';
const nextDocNo = () => `DOC-ENG-${new Date().getFullYear()}-${String(state.files.length + 1).padStart(3, '0')}`;

function defaultMeta({ title = 'Untitled Document', docNo } = {}) {
  const d = settings.defaults, t = today();
  return {
    doc_number: docNo || nextDocNo(), title, date: t, status: 'DRAFT', classification: d.classification,
    author: { name: d.authorName, title: d.authorTitle },
    approver: { name: d.approverName, title: d.approverTitle },
    compliance: d.compliance.slice(),
    revisions: [{ rev: 'A', date: t, author: d.authorName, approver: d.approverName, ecn: '', description: 'Initial issue.' }],
  };
}
function newDocTemplate(title, docNo) {
  return `---\n${dumpYaml(defaultMeta({ title, docNo }))}---\n\n# Introduction\n\nStart writing here. Edit the frontmatter above (document number, author, standards, revisions) first.\n`;
}
function guessTitle(body) {
  const m = body.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  return state.filePath ? titleFromName(state.filePath) : 'Untitled Document';
}

/* Keeps everything the user already typed; only adds what is missing */
function completeFrontmatter() {
  if (state.mode !== 'edit') { toast('Switch to Edit mode to fill in the frontmatter.', true); return; }
  const p = parseDoc(state.md);
  if (p.yamlError) { toast('Fix the YAML syntax error first.', true); return; }
  const fm = splitFrontmatter(state.md);
  const base = p.meta && typeof p.meta === 'object' ? p.meta : {};
  const def = defaultMeta({ title: guessTitle(p.body) });
  const out = {};
  for (const k of ['doc_number', 'title', 'date', 'status', 'classification', 'author', 'approver', 'compliance', 'revisions']) {
    let v = base[k];
    if (k === 'author' || k === 'approver') {
      const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      v = { ...o, name: o.name || def[k].name, title: o.title || def[k].title };
    } else if (k === 'compliance') {
      v = Array.isArray(v) && v.length ? v : def.compliance;
    } else if (k === 'revisions') {
      v = Array.isArray(v) && v.length
        ? v.map((r) => ({ ...r, rev: r.rev || 'A', date: r.date || def.date, author: r.author || out.author.name, approver: r.approver || out.approver.name, description: r.description || 'Revision entry.' }))
        : [{ ...def.revisions[0], author: out.author.name, approver: out.approver.name }];   // use this document's own people
    } else if (v === undefined || v === null || v === '') v = def[k];
    out[k] = v;
  }
  for (const k of Object.keys(base)) if (!(k in out)) out[k] = base[k];
  const head = `---\n${dumpYaml(out)}---\n`;
  setMarkdown(head + (fm.yamlText === null ? '\n' + state.md : fm.body), { fromUser: true });
  toast('Missing fields filled with defaults – review and edit them.');
}
document.addEventListener('click', (e) => { if (e.target.closest('.fix-fm')) completeFrontmatter(); });

/* =====================================================================
   Local folder workspace (File System Access API – Chromium browsers)
   ===================================================================== */
const FS_OK = typeof window.showDirectoryPicker === 'function';

function updateFileLabel() {
  if (typeof setSaveStatus === 'function' && lastSaveKind === 'saved') setSaveStatus('saved');
  if (typeof renderTabs === 'function') renderTabs();
  $('#fileLabel').textContent = state.filePath ? '📄 ' + state.filePath : state.dir ? 'Not linked to a file' : 'Browser storage';
}
/* Side panel: Files (collapsible) stacked above Contents (always visible). */
const SIDE_KEY = 'engdocs.side.v1';
const sideCfg = (() => { try { return JSON.parse(localStorage.getItem(SIDE_KEY)) || {}; } catch (e) { return {}; } })();
const saveSideCfg = () => { try { localStorage.setItem(SIDE_KEY, JSON.stringify(sideCfg)); } catch (e) { /* storage blocked: layout just won't be remembered */ } };
function setFilesOpen(open, remember = true) {
  $('#filesSec').classList.toggle('collapsed', !open);
  $('#filesHead').setAttribute('aria-expanded', String(open));
  if (remember) { sideCfg.filesOpen = open; saveSideCfg(); }
}
function showPane(name) { if (name === 'files') setFilesOpen(true, false); }      // Contents is always visible
(() => {
  if (typeof sideCfg.filesH === 'number') $('#filesSec').style.setProperty('--files-h', sideCfg.filesH + 'px');
  setFilesOpen(sideCfg.filesOpen !== false, false);
  $('#filesHead').addEventListener('click', () => setFilesOpen($('#filesSec').classList.contains('collapsed')));
  const sp = $('#sideSplit'), sec = $('#filesSec'), side = $('#sidebar');
  sp.addEventListener('pointerdown', (e) => {
    sp.setPointerCapture(e.pointerId); sp.classList.add('drag');
    const top = side.getBoundingClientRect().top, max = () => side.clientHeight - 130;
    const move = (ev) => { const h = Math.round(Math.min(Math.max(ev.clientY - top, 70), Math.max(120, max()))); sec.style.setProperty('--files-h', h + 'px'); sideCfg.filesH = h; };
    const up = () => { sp.classList.remove('drag'); sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); saveSideCfg(); };
    sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up);
  });
})();
setTocOpen(sideCfg.tocOpen !== false, false);
$('#tocHead').addEventListener('click', () => { if (isMobile()) setTocOpen($('#tocSec').classList.contains('collapsed')); });
async function saveFolderRecord() {
  if (!state.db || !state.dir) return;
  try { await DB.put(state.db, { id: 'folder_handle', handle: state.dir, lastFile: state.filePath || null }); }
  catch (e) { console.warn('Could not remember folder', e); }
}
/* ---------- File tree (nested, collapsible) ---------- */
const TREE_KEY = 'engdocs.tree.v1';
const readTreeCfg = () => { try { return JSON.parse(localStorage.getItem(TREE_KEY)) || {}; } catch (e) { return {}; } };
function loadOpenDirs() {
  const cfg = readTreeCfg();
  state.openDirs = new Set((state.dir && cfg[state.dir.name]) || []);
}
function saveOpenDirs() {
  if (!state.dir) return;
  try { const cfg = readTreeCfg(); cfg[state.dir.name] = [...state.openDirs]; localStorage.setItem(TREE_KEY, JSON.stringify(cfg)); } catch (e) { /* storage blocked: folders just won't be remembered */ }
}
function expandTo(path) {
  const parts = path.split('/'); parts.pop();
  let p = '', changed = false;
  for (const s of parts) { p = p ? p + '/' + s : s; if (!state.openDirs.has(p)) { state.openDirs.add(p); changed = true; } }
  if (changed) saveOpenDirs();
}
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const joinPath = (d, n) => (d ? d + '/' + n : n);
const nodeAt = (path) => (state.nodeByPath && state.nodeByPath.get(path)) || null;

async function scanFolder() {
  const files = [], byPath = new Map();
  const root = { kind: 'dir', name: state.dir.name, path: '', handle: state.dir, parent: null, children: [] };
  byPath.set('', root);
  const order = (a, b) => (a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  async function walk(node, depth) {
    const kids = [], subs = [];       // sub-folders are read in parallel: each read is a slow round trip on a phone
    for await (const [name, handle] of node.handle.entries()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const path = joinPath(node.path, name);
      if (handle.kind === 'directory') {
        const d = { kind: 'dir', name, path, handle, parent: node.handle, children: [] };
        byPath.set(path, d); kids.push(d);
        if (depth < 8) subs.push(walk(d, depth + 1));
      } else if (/\.(md|markdown)$/i.test(name)) {
        const f = { kind: 'file', name, path, handle, parent: node.handle };
        byPath.set(path, f); files.push(f); kids.push(f);
      }
    }
    await Promise.all(subs);
    kids.sort(order); node.children = kids;
  }
  try { await walk(root, 0); }
  catch (e) { console.error(e); toast('Could not read folder: ' + e.message, true); }
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  state.files = files; state.tree = root; state.nodeByPath = byPath;
  if (!state.openDirs) loadOpenDirs();
  if (state.filePath) expandTo(state.filePath);
  if (state.sel && !byPath.has(state.sel)) state.sel = null;
  if (state.clip && !byPath.has(state.clip.path)) state.clip = null;
  renderFiles();
}
function treeRows(node, depth) {
  let h = '';
  for (const c of node.children) {
    const cls = (state.sel === c.path ? ' sel' : '') + (state.clip && state.clip.mode === 'cut' && state.clip.path === c.path ? ' cut' : '');
    const pad = 8 + depth * 14;
    if (c.kind === 'dir') {
      const open = state.openDirs.has(c.path);
      h += `<div class="fp-dir${cls}" role="treeitem" aria-expanded="${open}" data-kind="dir" data-path="${esc(c.path)}" title="${esc(c.path)}" style="padding-left:${pad}px"><i class="chev">${open ? '▾' : '▸'}</i>📁 ${esc(c.name)}<button type="button" class="fp-more" data-more aria-label="Actions for ${esc(c.name)}">⋮</button></div>`;
      if (open) h += c.children.length ? treeRows(c, depth + 1) : `<div class="fp-empty" style="padding-left:${pad + 28}px">empty</div>`;
    } else {
      h += `<a href="#" role="treeitem" data-kind="file" data-path="${esc(c.path)}" class="fp-file${c.path === state.filePath ? ' on' : ''}${cls}" title="${esc(c.path)}" style="padding-left:${pad + 14}px">${esc(c.name)}<button type="button" class="fp-more" data-more aria-label="Actions for ${esc(c.name)}">⋮</button></a>`;
    }
  }
  return h;
}
function renderFiles() {
  const el = $('#filesPane');
  const hadFocus = el.contains(document.activeElement);
  if (!FS_OK) { el.innerHTML = '<div class="fp-msg">Folder access needs Chrome, Edge or Brave. Documents are still saved in this browser.</div>'; return; }
  if (!state.dir) { el.innerHTML = '<div class="fp-msg">No folder open. Open a folder and your documents are saved there as .md files.<br><button class="btn2" data-act="open">Open Folder</button></div>'; return; }
  if (state.needsReconnect) { el.innerHTML = `<div class="fp-msg">Folder “${esc(state.dir.name)}” needs permission again after the browser restarted.<br><button class="btn2" data-act="reconnect">Reconnect</button> <button class="btn2" data-act="open" style="background:#64748b">Other folder</button></div>`; return; }
  let html = `<div class="fp-head"><span title="${esc(state.dir.name)}">📁 ${esc(state.dir.name)}</span><span><button data-act="new" title="New document from a template">＋</button><button data-act="refresh" title="Rescan folder">⟳</button><button data-act="open" title="Open a different folder">…</button></span></div>`;
  html += state.tree ? treeRows(state.tree, 0) : '';
  if (!state.files.length && !(state.tree && state.tree.children.length)) html += '<div class="fp-msg">No .md files yet. Use ＋ to create one, or right-click here.</div>';
  el.innerHTML = html;
  if (hadFocus) el.focus({ preventScroll: true });
}
async function createDocFile(raw, content) {
  const segs = raw.replace(/\\/g, '/').split('/').map((s) => s.trim()).filter(Boolean);
  if (!segs.length || segs.some((s) => s === '.' || s === '..' || /[<>:"|?*\x00-\x1f]/.test(s))) throw new Error('Invalid file name.');
  let last = segs.pop();
  if (!/\.(md|markdown)$/i.test(last)) last += '.md';
  let dir = state.dir;
  for (const s of segs) dir = await dir.getDirectoryHandle(s, { create: true });
  try { await dir.getFileHandle(last); throw new Error('A file with that name already exists.'); }
  catch (e) { if (e.name !== 'NotFoundError') throw e; }
  const fh = await dir.getFileHandle(last, { create: true });
  await writeFile(fh, content);
  await scanFolder();
  return state.files.find((f) => f.path === [...segs, last].join('/'));
}
async function openFolder() {
  if (!FS_OK) { toast('Folder access needs Chrome, Edge or Brave.', true); return; }
  try {
    const h = await window.showDirectoryPicker({ id: 'engdocs', mode: 'readwrite' });
    const prevMd = state.md, hadUnlinked = !state.fileHandle && prevMd.trim();
    if (state.dirty) await persistNow();
    state.dir = h; state.needsReconnect = false; state.pendingFile = null; state.fileHandle = null; state.filePath = null;
    state.openDirs = null; state.sel = null; state.clip = null;
    detachTabs();
    await scanFolder(); showPane('files'); updateFileLabel(); await saveFolderRecord();
    if (hadUnlinked && confirm(`Save the document currently in the editor into “${h.name}” as a new file?`)) {
      const pm = parseDoc(prevMd).meta;
      const name = prompt('File name:', ((pm && pm.doc_number) || 'document').replace(/[^\w.\-]+/g, '_'));
      if (name && name.trim()) { const ent = await createDocFile(name, prevMd); if (activeTab) activeTab.seedMd = state.md; await openFileEntry(ent); }
    }
  } catch (e) { if (e.name !== 'AbortError') { console.error(e); toast('Could not open folder: ' + e.message, true); } }
}
async function activateFolder() {
  state.needsReconnect = false;
  await scanFolder(); showPane('files');
  let saved = null;
  if (state.db) { try { saved = await DB.get(state.db, 'tabs_state'); } catch (e) { /* ignore */ } }   // read before opening a file overwrites it
  if (state.pendingFile) {
    const f = state.files.find((x) => x.path === state.pendingFile);
    state.pendingFile = null;
    if (f) await openFileEntry(f);
  }
  await restoreTabs(saved);
  updateFileLabel();
}
async function restoreFolder() {
  if (!FS_OK || !state.db) return;
  try {
    const rec = await DB.get(state.db, 'folder_handle');
    if (!rec || !rec.handle) return;
    state.dir = rec.handle; state.pendingFile = rec.lastFile || null;
    if ((await rec.handle.queryPermission({ mode: 'readwrite' })) === 'granted') await activateFolder();
    else { state.needsReconnect = true; renderFiles(); showPane('files'); updateFileLabel(); }
  } catch (e) { console.warn('Could not restore folder', e); }
}
$('#btnFolder').addEventListener('click', openFolder);
$('#btnFolder').disabled = !FS_OK;
if (!FS_OK) $('#btnFolder').title = 'Needs Chrome, Edge or Brave (File System Access API)';
$('#btnNew').addEventListener('click', newDocument);
/* ---------- Tree operations (right-click menu) ---------- */
function askName({ title, label, value, check, stemOnly }) {
  return new Promise((resolve) => {
    const dlg = $('#dlgName'), inp = $('#nameInput'), ok = $('#nameOk'), err = $('#nameErr');
    $('#nameTitle').textContent = title; $('#nameLabel').textContent = label;
    inp.value = value || '';
    let done = false;
    const validate = () => {
      const v = inp.value.trim(), m = v ? check(v) : '';
      err.textContent = m || ''; ok.disabled = !v || !!m; return !!v && !m;
    };
    const cleanup = () => {
      inp.removeEventListener('input', validate); ok.removeEventListener('click', onOk);
      $('#nameCancel').removeEventListener('click', onCancel); dlg.removeEventListener('keydown', onKey); dlg.removeEventListener('close', onCancel);
    };
    const finish = (v) => { if (done) return; done = true; cleanup(); if (dlg.open) dlg.close(); resolve(v); };
    function onOk() { if (validate()) finish(inp.value.trim()); }
    function onCancel() { finish(null); }
    function onKey(e) { if (e.key === 'Enter') { e.preventDefault(); onOk(); } }
    inp.addEventListener('input', validate); ok.addEventListener('click', onOk);
    $('#nameCancel').addEventListener('click', onCancel); dlg.addEventListener('keydown', onKey); dlg.addEventListener('close', onCancel);
    dlg.showModal(); inp.focus();
    if (stemOnly) { const i = inp.value.lastIndexOf('.'); inp.setSelectionRange(0, i > 0 ? i : inp.value.length); } else inp.select();
    validate();
  });
}
const withMdExt = (n) => (/\.(md|markdown)$/i.test(n) ? n : n + '.md');
function nameProblem(name, taken, selfLower) {
  if (/[\\/:*?"<>|\x00-\x1f]/.test(name)) return 'A name cannot contain \\ / : * ? " < > |';
  if (/^\s|[\s.]$/.test(name)) return 'A name cannot start with a space or end with a space or a dot.';
  if (name.startsWith('.')) return 'Names starting with a dot are hidden, so they would not show in the tree.';
  if (name === 'node_modules') return 'That folder name is hidden from the tree.';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) return 'Windows reserves that name.';
  const l = name.toLowerCase();
  if (taken.has(l) && l !== selfLower) return 'Something with that name already exists here.';
  return '';
}
async function namesIn(dirHandle) { const s = new Set(); for await (const [n] of dirHandle.entries()) s.add(n.toLowerCase()); return s; }
async function uniqueName(dirHandle, name, isFile) {
  const taken = await namesIn(dirHandle);
  if (!taken.has(name.toLowerCase())) return name;
  const m = isFile ? name.match(/^(.*?)(\.[^.]*)?$/) : [name, name, ''];
  const stem = m[1], ext = m[2] || '';
  for (let i = 1; i < 1000; i++) {
    const cand = `${stem} copy${i > 1 ? ' ' + i : ''}${ext}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  throw new Error('Could not find a free name.');
}
async function copyInto(src, dstDir, name) {
  if (src.kind === 'file') {
    const file = await src.getFile();
    const fh = await dstDir.getFileHandle(name, { create: true });
    const w = await fh.createWritable(); await w.write(file); await w.close();
    if ((await fh.getFile()).size !== file.size) throw new Error(`The copy of “${name}” did not verify (size differs).`);
    return;
  }
  const d = await dstDir.getDirectoryHandle(name, { create: true });
  for await (const [n, h] of src.entries()) await copyInto(h, d, n);
}
async function copyTree(src, dstDir, name) {
  try { await copyInto(src, dstDir, name); }
  catch (e) { try { await dstDir.removeEntry(name, { recursive: true }); } catch (e2) { /* nothing more to clean up */ } throw e; }
}
async function countTree(h) {
  const c = { md: 0, other: 0 };
  for await (const [n, x] of h.entries()) {
    if (x.kind === 'directory') { const s = await countTree(x); c.md += s.md; c.other += s.other; }
    else if (/\.(md|markdown)$/i.test(n)) c.md++; else c.other++;
  }
  return c;
}
/* Rename/move: the browser's own move() when it works, otherwise copy -> verify -> delete the original. */
async function moveNode(node, destHandle, newName) {
  if (typeof node.handle.move === 'function') {
    try { await node.handle.move(destHandle, newName); return; } catch (e) { /* not supported for this folder: fall back */ }
  }
  if (node.parent && destHandle === node.parent && newName.toLowerCase() === node.name.toLowerCase())
    throw new Error('This browser cannot change only the upper/lower case of a name. Rename it to something different first.');
  await copyTree(node.handle, destHandle, newName);
  await node.parent.removeEntry(node.name, { recursive: true });
}
const inside = (path, ancestor) => path === ancestor || path.startsWith(ancestor + '/');
async function relinkOpenFile(oldBase, newBase) {
  for (const t of docTabs.slice()) {
    if (t === activeTab || !t.path || !inside(t.path, oldBase)) continue;
    const np = newBase + t.path.slice(oldBase.length), e = state.files.find((f) => f.path === np);
    if (!e) { dropTab(t); continue; }
    t.handle = e.handle; t.path = e.path; t.parent = e.parent;
    try { const f = await e.handle.getFile(); t.lastMod = f.lastModified; t.diskText = await f.text(); } catch (err) { /* keep old values */ }
  }
  renderTabs(); renderRef();
  if (!state.filePath || !inside(state.filePath, oldBase)) return;
  const np = newBase + state.filePath.slice(oldBase.length);
  const e = state.files.find((f) => f.path === np);
  if (!e) { unlinkOpenFile(); return; }
  state.fileHandle = e.handle; state.filePath = e.path; state.parentDir = e.parent;
  try { const f = await e.handle.getFile(); state.lastMod = f.lastModified; state.diskText = await f.text(); } catch (err) { /* keep old values */ }
  clearAssetCache(); expandTo(e.path); updateFileLabel(); saveFolderRecord(); renderFiles();
}
function unlinkOpenFile() {
  state.fileHandle = null; state.filePath = null; state.parentDir = null; state.diskText = null;
  clearAssetCache(); updateFileLabel(); saveFolderRecord(); renderFiles();
  persistNow();
}
const parentOf = (n) => (n.kind === 'dir' ? n : nodeAt(dirName(n.path)) || state.tree);
async function treeNewFile(dirNode) {
  const taken = await namesIn(dirNode.handle);
  const raw = await askName({ title: 'New file', label: 'File name' + (dirNode.path ? ' in ' + dirNode.path : ''), value: '', check: (v) => nameProblem(withMdExt(v), taken, '') });
  if (!raw) return;
  const name = withMdExt(raw);
  if (state.dirty) await persistNow();
  const fh = await dirNode.handle.getFileHandle(name, { create: true });
  await writeFile(fh, TEMPLATES.find((t) => t.id === 'blank').build(titleFromName(name)));
  state.openDirs.add(dirNode.path); if (dirNode.path) saveOpenDirs();
  await scanFolder();
  const entry = state.files.find((f) => f.path === joinPath(dirNode.path, name));
  if (entry) { state.sel = entry.path; await openFileEntry(entry); state.mode = 'edit'; applyLayout(); }
  toast('Created ' + joinPath(dirNode.path, name));
}
async function treeNewFolder(dirNode) {
  const taken = await namesIn(dirNode.handle);
  const name = await askName({ title: 'New folder', label: 'Folder name' + (dirNode.path ? ' in ' + dirNode.path : ''), value: '', check: (v) => nameProblem(v, taken, '') });
  if (!name) return;
  await dirNode.handle.getDirectoryHandle(name, { create: true });
  if (dirNode.path) state.openDirs.add(dirNode.path);
  state.openDirs.add(joinPath(dirNode.path, name)); saveOpenDirs();
  state.sel = joinPath(dirNode.path, name);
  await scanFolder();
}
async function treeRename(node) {
  const parentHandle = node.parent, taken = await namesIn(parentHandle), self = node.name.toLowerCase();
  const fin = (v) => (node.kind === 'file' ? withMdExt(v) : v);
  const raw = await askName({ title: 'Rename', label: 'New name', value: node.name, stemOnly: node.kind === 'file', check: (v) => nameProblem(fin(v), taken, self) });
  if (!raw) return;
  const name = fin(raw);
  if (name === node.name) return;
  if (state.dirty) await persistNow();
  const oldPath = node.path, newPath = joinPath(dirName(oldPath), name);
  await moveNode(node, parentHandle, name);
  if (state.sel === oldPath) state.sel = newPath;
  const wasOpen = state.openDirs.has(oldPath);
  if (node.kind === 'dir') { for (const p of [...state.openDirs]) if (inside(p, oldPath)) { state.openDirs.delete(p); state.openDirs.add(newPath + p.slice(oldPath.length)); } saveOpenDirs(); }
  await scanFolder();
  await relinkOpenFile(oldPath, newPath);
  toast(`Renamed to ${name}. Links in other notes that point to the old name are not updated.`);
}
async function treeDelete(node) {
  let msg;
  if (node.kind === 'dir') {
    const c = await countTree(node.handle);
    msg = `Permanently delete the folder “${node.path}” and everything in it (${c.md} Markdown file${c.md === 1 ? '' : 's'}, ${c.other} other file${c.other === 1 ? '' : 's'})?\n\nThis cannot be undone and it does not go to the Recycle Bin.`;
  } else msg = `Permanently delete “${node.path}”?\n\nThis cannot be undone and it does not go to the Recycle Bin.`;
  if (!confirm(msg)) return;
  if (state.dirty) await persistNow();
  const hitOpen = state.filePath && inside(state.filePath, node.path);
  await node.parent.removeEntry(node.name, { recursive: true });
  for (const p of [...state.openDirs]) if (inside(p, node.path)) state.openDirs.delete(p);
  saveOpenDirs();
  if (state.sel && inside(state.sel, node.path)) state.sel = null;
  if (state.clip && inside(state.clip.path, node.path)) state.clip = null;
  await scanFolder();
  for (const t of docTabs.slice()) if (t !== activeTab && t.path && inside(t.path, node.path)) dropTab(t);
  renderTabs();
  if (hitOpen) { unlinkOpenFile(); toast('The open document was deleted from disk. Its text is still in the editor as a draft kept in this browser.', true); }
  else toast('Deleted ' + node.name);
}
async function treeDuplicate(node) {
  const name = await uniqueName(node.parent, node.name, node.kind === 'file');
  await copyTree(node.handle, node.parent, name);
  state.sel = joinPath(dirName(node.path), name);
  await scanFolder(); toast('Created ' + name);
}
async function treePaste(destNode) {
  const clip = state.clip, src = clip && nodeAt(clip.path);
  if (!src) { state.clip = null; renderFiles(); toast('The item you copied no longer exists.', true); return; }
  if (src.kind === 'dir' && inside(destNode.path, src.path)) { toast('A folder cannot be pasted into itself.', true); return; }
  if (state.dirty) await persistNow();
  let name;
  if (clip.mode === 'cut') {
    if (dirName(src.path) === destNode.path) { state.clip = null; renderFiles(); return; }
    if ((await namesIn(destNode.handle)).has(src.name.toLowerCase())) { toast(`“${src.name}” already exists in that folder.`, true); return; }
    name = src.name;
    const oldPath = src.path, newPath = joinPath(destNode.path, name);
    await moveNode(src, destNode.handle, name);
    state.clip = null; state.sel = newPath;
    if (src.kind === 'dir') { for (const p of [...state.openDirs]) if (inside(p, oldPath)) { state.openDirs.delete(p); state.openDirs.add(newPath + p.slice(oldPath.length)); } }
    if (destNode.path) state.openDirs.add(destNode.path); saveOpenDirs();
    await scanFolder(); await relinkOpenFile(oldPath, newPath);
    toast(`Moved ${name}. Relative image and link paths inside it are not rewritten.`);
  } else {
    name = await uniqueName(destNode.handle, src.name, src.kind === 'file');
    await copyTree(src.handle, destNode.handle, name);
    if (destNode.path) { state.openDirs.add(destNode.path); saveOpenDirs(); }
    state.sel = joinPath(destNode.path, name);
    await scanFolder(); toast('Pasted ' + name);
  }
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Copied ' + t); }
  catch (e) { toast('Could not reach the clipboard. The path is ' + t, true); }
}
async function treeAction(act, node) {
  try {
    const dir = parentOf(node);
    switch (act) {
      case 'open': if (node.kind === 'file') await openFileEntry(node); break;
      case 'side': if (node.kind === 'file') await openFileEntry(node, { side: true }); break;
      case 'newfile': await treeNewFile(dir); break;
      case 'newfolder': await treeNewFolder(dir); break;
      case 'template': openTemplatePicker(dir.path); break;
      case 'rename': await treeRename(node); break;
      case 'delete': await treeDelete(node); break;
      case 'duplicate': await treeDuplicate(node); break;
      case 'cut': case 'copy': state.clip = { mode: act, path: node.path }; renderFiles(); toast((act === 'cut' ? 'Cut ' : 'Copied ') + node.name + ' – right-click a folder and choose Paste.'); break;
      case 'paste': await treePaste(dir); break;
      case 'relpath': await copyText(node.path); break;
      case 'refresh': await scanFolder(); break;
    }
  } catch (err) { console.error(err); toast(err.message || String(err), true); try { await scanFolder(); } catch (e2) { /* ignore */ } }
}

/* ---------- Context menu ---------- */
const ctxEl = $('#ctxMenu');
let ctxNode = null, ctxAt = 0, ctxPick = null;
function closeCtx() { if (!ctxEl.hidden) { ctxEl.hidden = true; ctxEl.innerHTML = ''; ctxNode = null; ctxPick = null; } }
function openCtx(node, x, y) {
  const isRoot = node === state.tree, isFile = node.kind === 'file', canPaste = !!(state.clip && nodeAt(state.clip.path));
  const items = [];
  if (isFile) items.push(['open', 'Open'], ['side', 'Open to the Side']);
  if (!isFile) items.push(['newfile', 'New File…'], ['template', 'New from Template…'], ['newfolder', 'New Folder…'], '-');
  if (!isRoot) items.push(['cut', 'Cut', 'Ctrl+X'], ['copy', 'Copy', 'Ctrl+C']);
  items.push(['paste', 'Paste', 'Ctrl+V', !canPaste]);
  if (isFile) items.push(['duplicate', 'Duplicate']);
  if (!isRoot) items.push('-', ['relpath', 'Copy Relative Path'], '-', ['rename', 'Rename…', 'F2'], ['delete', 'Delete', 'Del']);
  if (!isFile) items.push('-', ['refresh', 'Refresh']);
  ctxNode = node; ctxPick = null;
  showMenu(items, x, y);
}
function showMenu(items, x, y) {
  ctxAt = Date.now();
  ctxEl.innerHTML = items.map((it) => (it === '-' ? '<hr>' : `<button type="button" role="menuitem" data-ctx="${it[0]}"${it[3] ? ' disabled' : ''}><span>${it[1]}</span>${it[2] ? `<kbd>${it[2]}</kbd>` : ''}</button>`)).join('');
  ctxEl.hidden = false;
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  ctxEl.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
  const first = ctxEl.querySelector('button:not(:disabled)'); if (first) first.focus();
}
ctxEl.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-ctx]'); if (!b || b.disabled) return;
  const node = ctxNode, act = b.dataset.ctx, pick = ctxPick; closeCtx();
  if (pick) pick(act); else if (node) treeAction(act, node);
});
ctxEl.addEventListener('keydown', (e) => {
  const bs = [...ctxEl.querySelectorAll('button:not(:disabled)')], i = bs.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeCtx(); $('#filesPane').focus(); }
  else if (e.key === 'Tab') { e.preventDefault(); closeCtx(); }
});
document.addEventListener('mousedown', (e) => { if (!ctxEl.hidden && !e.target.closest('#ctxMenu')) closeCtx(); }, true);
window.addEventListener('blur', closeCtx);
window.addEventListener('resize', closeCtx);
$('#filesPane').addEventListener('scroll', () => { if (Date.now() - ctxAt > 300) closeCtx(); });

const rowNode = (t) => { const r = t.closest && t.closest('[data-path]'); return r && !r.dataset.act ? nodeAt(r.dataset.path) : null; };
$('#filesPane').addEventListener('contextmenu', (e) => {
  if (!state.dir || state.needsReconnect || !state.tree) return;
  e.preventDefault();
  const node = rowNode(e.target) || state.tree;
  if (node !== state.tree) { state.sel = node.path; renderFiles(); }
  openCtx(node, e.clientX, e.clientY);
});
$('#filesPane').addEventListener('click', async (e) => {
  e.preventDefault();
  const act = e.target.closest('[data-act]'), row = act ? null : rowNode(e.target);
  try {
    if (row && e.target.closest('[data-more]')) {
      state.sel = row.path; renderFiles();
      const r = $('#filesPane').querySelector(`[data-path="${CSS.escape(row.path)}"] .fp-more`).getBoundingClientRect();
      openCtx(row, r.left - 200, r.bottom);
      return;
    }
    if (act) {
      const k = act.dataset.act;
      if (k === 'open') await openFolder();
      else if (k === 'new') await newDocument();
      else if (k === 'refresh') await scanFolder();
      else if (k === 'reconnect') { if ((await state.dir.requestPermission({ mode: 'readwrite' })) === 'granted') await activateFolder(); else toast('Permission was not granted.', true); }
    } else if (row) {
      state.sel = row.path;
      if (row.kind === 'dir') {
        if (state.openDirs.has(row.path)) state.openDirs.delete(row.path); else state.openDirs.add(row.path);
        saveOpenDirs(); renderFiles();
      } else {
        renderFiles();
        if (row.path !== state.filePath) await openFileEntry(row);
        if (isMobile()) setDrawer(false);
      }
      $('#filesPane').focus({ preventScroll: true });
    }
  } catch (err) { console.error(err); toast(err.message, true); }
});
$('#filesPane').addEventListener('keydown', (e) => {
  if (!state.tree || e.target.closest('input,textarea')) return;
  const node = (state.sel && nodeAt(state.sel)) || null;
  const rows = [...$('#filesPane').querySelectorAll('[data-path]')].filter((r) => !r.closest('.fp-head'));
  const idx = node ? rows.findIndex((r) => r.dataset.path === node.path) : -1;
  const go = (n) => { if (n >= 0 && n < rows.length) { state.sel = rows[n].dataset.path; renderFiles(); const r = $('#filesPane').querySelector(`[data-path="${CSS.escape(state.sel)}"]`); if (r) r.scrollIntoView({ block: 'nearest' }); } };
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'ArrowDown') { e.preventDefault(); go(idx + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); go(idx < 0 ? 0 : idx - 1); }
  else if (e.key === 'ArrowRight' && node && node.kind === 'dir') { e.preventDefault(); if (!state.openDirs.has(node.path)) { state.openDirs.add(node.path); saveOpenDirs(); renderFiles(); } else go(idx + 1); }
  else if (e.key === 'ArrowLeft' && node) {
    e.preventDefault();
    if (node.kind === 'dir' && state.openDirs.has(node.path)) { state.openDirs.delete(node.path); saveOpenDirs(); renderFiles(); }
    else { const p = dirName(node.path); if (p) { state.sel = p; renderFiles(); } }
  }
  else if (e.key === 'Enter' && node) { e.preventDefault(); if (node.kind === 'dir') { if (state.openDirs.has(node.path)) state.openDirs.delete(node.path); else state.openDirs.add(node.path); saveOpenDirs(); renderFiles(); } else treeAction('open', node); }
  else if (e.key === 'F2' && node) { e.preventDefault(); treeAction('rename', node); }
  else if (e.key === 'Delete' && node) { e.preventDefault(); treeAction('delete', node); }
  else if (mod && /^[cx]$/i.test(e.key) && node) { e.preventDefault(); treeAction(e.key.toLowerCase() === 'x' ? 'cut' : 'copy', node); }
  else if (mod && /^v$/i.test(e.key) && state.clip) { e.preventDefault(); treeAction('paste', node || state.tree); }
  else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault();
    const r = node && $('#filesPane').querySelector(`[data-path="${CSS.escape(node.path)}"]`), b = (r || $('#filesPane')).getBoundingClientRect();
    openCtx(node || state.tree, b.left + 20, b.bottom);
  }
});
/* Pick up files added or removed by other programs while this window was in the background */
let lastTreeScan = 0;
window.addEventListener('focus', () => {
  if (!state.dir || state.needsReconnect || !ctxEl.hidden || $('#dlgName').open || Date.now() - lastTreeScan < 2000) return;
  if (window.matchMedia('(pointer: coarse)').matches) return;     // phones: switching apps would rescan a slow folder every time; use the refresh button
  lastTreeScan = Date.now(); scanFolder().catch(() => {});
});
/* Pick up edits made to the file by other programs while this window was in the background */
window.addEventListener('focus', async () => {
  if (!state.fileHandle || state.dirty) return;
  try {
    const f = await state.fileHandle.getFile();
    if (f.lastModified > state.lastMod) {
      state.lastMod = f.lastModified;
      const text = await f.text();
      state.diskText = text; state.eol = eolOf(text);
      if (lf(text) !== lf(state.md)) { setMarkdown(text, { seed: true }); toast('Reloaded – the file changed on disk.'); }
    }
  } catch (e) { console.warn(e); }
});

/* =====================================================================
   Page Setup dialog
   ===================================================================== */
const SETUP_FIELDS = { header_left: '#sHL', header_centre: '#sHC', header_right: '#sHR', footer_left: '#sFL', footer_centre: '#sFC', footer_right: '#sFR' };
function fillSetup(pg) {
  for (const [k, sel] of Object.entries(SETUP_FIELDS)) $(sel).value = pg[k] ?? '';
  $('#sSize').value = pg.font_size; $('#sRule').checked = !!pg.rule; $('#sCover').checked = !!pg.on_cover; $('#sWm').checked = !!pg.watermark;
}
function readSetup() {
  const pg = {};
  for (const [k, sel] of Object.entries(SETUP_FIELDS)) pg[k] = $(sel).value;
  pg.font_size = Math.min(14, Math.max(6, parseFloat($('#sSize').value) || 8.5));
  pg.rule = $('#sRule').checked; pg.on_cover = $('#sCover').checked; pg.watermark = $('#sWm').checked;
  return pg;
}
function updateSetupPreview() {
  const pg = readSetup(), v = { ...printVals(state.meta), page: '3', pages: '7' };
  const sub = (s) => String(s).replace(/\{(\w+)\}/g, (x, k) => (k in v ? v[k] : x));
  const row = (a, b, c, edge) => `<div class="pv-row" style="font-size:${pg.font_size}pt;${pg.rule ? `border-${edge}:1px solid #94a3b8;` : ''}"><span>${esc(sub(a))}</span><span>${esc(sub(b))}</span><span>${esc(sub(c))}</span></div>`;
  $('#setupPreview').innerHTML = row(pg.header_left, pg.header_centre, pg.header_right, 'bottom') + '<div class="pv-body">page content</div>' + row(pg.footer_left, pg.footer_centre, pg.footer_right, 'top');
}
function openSetup() {
  fillSetup(effectivePage(state.meta));
  const d = settings.defaults;
  $('#dAuthN').value = d.authorName; $('#dAuthT').value = d.authorTitle; $('#dAppN').value = d.approverName; $('#dAppT').value = d.approverTitle;
  $('#dClass').value = d.classification; $('#dComp').value = d.compliance.join('\n');
  const hasMeta = !!state.meta;
  $('#sScopeDoc').disabled = !hasMeta;
  (hasMeta ? $('#sScopeDoc') : $('#sScopeGlobal')).checked = true;
  updateSetupPreview();
  $('#dlgSetup').showModal();
}
function saveSetup() {
  const pg = readSetup();
  const scope = document.querySelector('input[name=sScope]:checked').value;
  const dflt = {
    authorName: $('#dAuthN').value.trim() || DEFAULT_SETTINGS.defaults.authorName, authorTitle: $('#dAuthT').value.trim() || DEFAULT_SETTINGS.defaults.authorTitle,
    approverName: $('#dAppN').value.trim() || DEFAULT_SETTINGS.defaults.approverName, approverTitle: $('#dAppT').value.trim() || DEFAULT_SETTINGS.defaults.approverTitle,
    classification: $('#dClass').value.trim() || DEFAULT_SETTINGS.defaults.classification,
    compliance: $('#dComp').value.split('\n').map((s) => s.trim()).filter(Boolean),
  };
  if (scope === 'doc') {
    if (state.mode !== 'edit') { toast('Switch to Edit mode to store the page setup in this document.', true); return; }
    const p = parseDoc(state.md);
    if (p.yamlError || !p.meta) { toast('This document needs valid frontmatter first (use “Fill missing fields”).', true); return; }
    const fm = splitFrontmatter(state.md);
    p.meta.page_setup = pg;
    setMarkdown(`---\n${dumpYaml(p.meta)}---\n${fm.body}`, { fromUser: true });
  } else {
    settings.page = pg;
    if (state.meta && state.meta.page_setup) toast('Saved – note this document has its own page setup, which takes priority.');
    else toast('Settings saved.');
  }
  settings.defaults = dflt;
  saveSettings();
  $('#dlgSetup').close();
}
$('#btnSetup').addEventListener('click', openSetup);
$('#setupSave').addEventListener('click', saveSetup);
$('#setupCancel').addEventListener('click', () => $('#dlgSetup').close());
$('#setupReset').addEventListener('click', () => { fillSetup(DEFAULT_SETTINGS.page); updateSetupPreview(); });
$('#setupForm').addEventListener('input', updateSetupPreview);
$('#setupForm').addEventListener('submit', (e) => e.preventDefault());

/* =====================================================================
   Sanitising (DOMPurify) – all rendered markdown goes through this
   ===================================================================== */
let inlineMd = null;
/* Visual editor: the YAML frontmatter shown as a compact card (click it to edit the YAML) */
function frontCardHTML(text) {
  const p = parseDoc(text);
  let card;
  if (p.note && p.meta && typeof p.meta === 'object') {
    const m = p.meta;
    card = `<div class="doccard note"><div class="t">${esc(m.title ? String(m.title) : 'Note')}</div>${m.date ? `<div class="m"><span>${esc(String(m.date))}</span></div>` : ''}${p.warnings.length ? `<div class="warnbox"><ul>${p.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}</div>`;
  } else card = docCardHTML(p.meta, p.warnings, !p.yamlError && state.mode === 'edit', false);
  return card ? sanitize(card).replace(/<\/div>$/, '<div class="fmhint">Click to edit the document information</div></div>') : '';
}
function renderCellInline(md) {          // inline Markdown of one table cell → sanitised HTML (used by the live-preview table)
  try { inlineMd = inlineMd || new marked.Marked({ gfm: true, breaks: false }); return sanitize(inlineMd.parseInline(md)); }
  catch (e) { return esc(md); }
}
function sanitize(html) {
  if (!window.DOMPurify) throw new Error('DOMPurify failed to load – refusing to render unsanitised HTML.');
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true, svg: true, mathMl: true }, FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed'], FORBID_ATTR: ['srcset'] });
}

/* =====================================================================
   Images stored as files (assets/ next to the document)
   ===================================================================== */
const assetCache = new Map();      // normalised path from folder root → { url, file }
function clearAssetCache() { for (const r of assetCache.values()) { try { URL.revokeObjectURL(r.url); } catch {} } assetCache.clear(); }

function assetKey(src, basePath = state.filePath) {
  try {
    const rel = decodeURI(src.split('#')[0].split('?')[0]);
    const parts = basePath ? basePath.split('/').slice(0, -1) : [];
    for (const seg of rel.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
    }
    return parts.length ? parts.join('/') : null;
  } catch { return null; }
}
async function loadAsset(key) {
  if (assetCache.has(key)) return assetCache.get(key);
  if (!state.dir || state.needsReconnect) return null;
  try {
    const segs = key.split('/');
    let d = state.dir;
    for (const s of segs.slice(0, -1)) d = await d.getDirectoryHandle(s);
    const file = await (await d.getFileHandle(segs[segs.length - 1])).getFile();
    const rec = { url: URL.createObjectURL(file), file };
    assetCache.set(key, rec);
    return rec;
  } catch { return null; }
}
function markMissing(img, src) { img.classList.add('img-missing'); img.alt = (img.alt || 'image') + ' – not found: ' + src; }
/* Swaps data-asset placeholders for blob URLs. Cached images resolve synchronously (no flicker on re-render). */
function applyAssets(root, basePath = state.filePath) {
  const pending = [];
  for (const img of root.querySelectorAll('img[data-asset]')) {
    const src = img.getAttribute('data-asset');
    const key = assetKey(src, basePath);
    if (!key) { markMissing(img, src); continue; }
    const hit = assetCache.get(key);
    if (hit) img.src = hit.url;
    else pending.push(loadAsset(key).then((rec) => { if (rec) img.src = rec.url; else markMissing(img, src); }));
  }
  return Promise.all(pending);
}
async function embedAssets(md) {
  const re = /(!\[[^\]]*\]\()([^)\s]+)(\))/g;
  let out = '', last = 0;
  for (const m of md.matchAll(re)) {
    if (/^(data:|https?:|blob:)/i.test(m[2])) continue;
    const key = assetKey(m[2]); const rec = key && await loadAsset(key);
    if (!rec) continue;
    out += md.slice(last, m.index) + m[1] + await blobToDataURL(rec.file) + m[3];
    last = m.index + m[0].length;
  }
  return out + md.slice(last);
}
async function saveAsset(img) {
  const assets = await state.parentDir.getDirectoryHandle('assets', { create: true });
  const slug = (state.filePath.split('/').pop().replace(/\.(md|markdown)$/i, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'doc').toLowerCase();
  const re = new RegExp('^' + slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-fig-(\\d+)\\.', 'i');
  let max = 0;
  for await (const [name] of assets.entries()) { const m = re.exec(name); if (m) max = Math.max(max, +m[1]); }
  const name = `${slug}-fig-${String(max + 1).padStart(2, '0')}.${img.ext}`;
  const w = await (await assets.getFileHandle(name, { create: true })).createWritable();
  try { await w.write(img.blob); } finally { await w.close(); }
  const base = state.filePath.split('/').slice(0, -1);
  assetCache.set([...base, 'assets', name].join('/'), { url: URL.createObjectURL(img.blob), file: img.blob });
  return `assets/${name}`;
}
async function migrateImages() {
  if (!state.fileHandle || !state.parentDir) { toast('Open a folder and a document first – images are stored next to the document.', true); return; }
  if (state.mode !== 'edit') { toast('Switch to Edit mode first.', true); return; }
  const found = [...state.md.matchAll(/\]\((data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+))\)/g)];
  if (!found.length) { toast('No embedded images found in this document.'); return; }
  if (!confirm(`Move ${found.length} embedded image${found.length > 1 ? 's' : ''} into the “assets” folder next to this document?`)) return;
  try {
    let out = '', last = 0;
    for (const m of found) {
      const mime = 'image/' + m[2], bin = atob(m[3]), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const src = await saveAsset({ blob: new Blob([bytes], { type: mime }), ext: EXT[mime] || m[2].replace(/\+.*$/, '') });
      out += state.md.slice(last, m.index) + `](${src})`;
      last = m.index + m[0].length;
    }
    editor.replaceAll(out + state.md.slice(last));
    toast(`Moved ${found.length} image${found.length > 1 ? 's' : ''} to assets/. (Ctrl+Z undoes the text change.)`);
  } catch (e) { console.error(e); toast('Could not move images: ' + e.message, true); }
}
$('#btnMigrate').addEventListener('click', migrateImages);

/* =====================================================================
   Format bar, File menu, status bar
   ===================================================================== */
const FB = {
  bold: () => editor.bold(), italic: () => editor.italic(), strike: () => editor.strike(), code: () => editor.code(),
  h1: () => editor.heading(1), h2: () => editor.heading(2), h3: () => editor.heading(3),
  bullet: () => editor.bullet(), number: () => editor.number(), task: () => editor.task(), quote: () => editor.quote(),
  link: () => editor.link(),
  indent: () => editor.indent(), outdent: () => editor.outdent(),
  table: () => {},   // opened from the Table menu (grid picker); see below
  aligntables: () => alignTables(),
  eq: () => editor.insertTemplate('$$\n§\n$$\n'),
  codeblock: () => editor.insertTemplate('```\n§\n```\n'),
  image: () => $('#fileImage').click(),
};
$('#formatBar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });   // keep the caret in the editor
$('#formatBar').addEventListener('click', (e) => {
  const mb = e.target.closest('button[data-menu]');
  if (mb) { toggleFbMenu(mb.dataset.menu); return; }
  const h = e.target.closest('button[data-h]');
  if (h) { editor.setHeading(+h.dataset.h); closeFbMenus(); editor.focus(); updateFormatBar(); return; }
  const b = e.target.closest('button[data-cmd]');
  if (b && FB[b.dataset.cmd]) { closeFbMenus(); FB[b.dataset.cmd](); if (!$('#dlgLink').open) editor.focus(); updateFormatBar(); }
});

/* ---- Drop-down menus (paragraph style, lists, table) ---- */
function closeFbMenus() {
  document.querySelectorAll('#formatBar .fbmenu.open').forEach((m) => { m.classList.remove('open'); m.querySelector('[data-menu]').setAttribute('aria-expanded', 'false'); });
}
function toggleFbMenu(id) {
  const m = document.getElementById(id), was = m.classList.contains('open');
  closeFbMenus();
  if (!was) { m.classList.add('open'); m.querySelector('[data-menu]').setAttribute('aria-expanded', 'true'); if (id === 'mnuTable') resetTableGrid(); }
}
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#formatBar .fbmenu')) closeFbMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFbMenus(); });

/* ---- Pressed/active state follows the caret ---- */
let fbRaf = 0;
function updateFormatBar() {
  if (fbRaf) return;
  fbRaf = requestAnimationFrame(() => {
    fbRaf = 0;
    let f; try { f = editor.formatState && editor.formatState(); } catch (_) { f = null; }
    if (!f) return;
    const on = (sel, v) => { const el = $(sel); if (el) { el.classList.toggle('on', !!v); el.setAttribute('aria-pressed', v ? 'true' : 'false'); } };
    on('#formatBar [data-cmd="bold"]', f.bold); on('#formatBar [data-cmd="italic"]', f.italic);
    on('#formatBar [data-cmd="strike"]', f.strike); on('#formatBar [data-cmd="code"]', f.code);
    on('#formatBar [data-cmd="quote"]', f.quote);
    $('#fbHeading').textContent = (f.heading ? 'Heading ' + f.heading : 'Body text') + ' ▾';
    $('#fbHeading').classList.toggle('on', f.heading > 0);
    $('#fbList').classList.toggle('on', !!f.list);
    document.querySelectorAll('#mnuHeading [data-h]').forEach((b) => b.classList.toggle('on', +b.dataset.h === f.heading));
    ['bullet', 'number', 'task'].forEach((k) => $('#mnuList [data-cmd="' + k + '"]').classList.toggle('on', f.list === k));
  });
}

/* ---- Table: grid picker (columns across, rows down) with a custom-size dialog ---- */
const T_COLS = 8, T_ROWS = 8;
(function buildTableGrid() {
  const g = $('#tGrid');
  for (let r = 1; r <= T_ROWS; r++) for (let c = 1; c <= T_COLS; c++) { const i = document.createElement('i'); i.dataset.c = c; i.dataset.r = r; g.appendChild(i); }
})();
function resetTableGrid() { document.querySelectorAll('#tGrid i.hot').forEach((i) => i.classList.remove('hot')); $('#tLabel').textContent = 'Insert table'; }
$('#tGrid').addEventListener('mouseover', (e) => {
  const t = e.target.closest('i'); if (!t) return;
  const c = +t.dataset.c, r = +t.dataset.r;
  document.querySelectorAll('#tGrid i').forEach((i) => i.classList.toggle('hot', +i.dataset.c <= c && +i.dataset.r <= r));
  $('#tLabel').textContent = `${c} column${c > 1 ? 's' : ''} × ${r} row${r > 1 ? 's' : ''} + header`;
});
$('#tGrid').addEventListener('click', (e) => { const t = e.target.closest('i'); if (t) { insertTable(+t.dataset.c, +t.dataset.r); closeFbMenus(); } });
function insertTable(cols, rows) { editor.insertText('\n' + makeTableMd(cols, rows) + '\n'); editor.focus(); }
$('#tCustom').addEventListener('click', () => { closeFbMenus(); $('#dlgTable').showModal(); $('#tblCols').select(); });
$('#tblCancel').addEventListener('click', () => { $('#dlgTable').close(); editor.focus(); });
$('#tblOk').addEventListener('click', () => {
  const c = Math.round(+$('#tblCols').value), r = Math.round(+$('#tblRows').value);
  if (!(c >= 1 && c <= 20 && r >= 1 && r <= 100)) { toast('Use 1–20 columns and 1–100 rows.', true); return; }
  $('#dlgTable').close(); insertTable(c, r);
});
$('#dlgTable').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#tblOk').click(); } });

/* ---- Link dialog ---- */
const BAD_URL = /^\s*(javascript|data|vbscript):/i;
function linkValid() { const u = $('#lnkUrl').value.trim(); return !!u && !BAD_URL.test(u); }
function openLinkDialog() {
  closeFbMenus();
  $('#lnkText').value = (editor.selectedText && editor.selectedText()) || '';
  $('#lnkUrl').value = '';
  $('#lnkOk').disabled = true;
  $('#dlgLink').showModal();
  ($('#lnkText').value ? $('#lnkUrl') : $('#lnkText')).focus();
}
$('#lnkUrl').addEventListener('input', () => { $('#lnkOk').disabled = !linkValid(); });
$('#lnkCancel').addEventListener('click', () => { $('#dlgLink').close(); editor.focus(); });
$('#lnkOk').addEventListener('click', () => {
  if (!linkValid()) return;
  const text = $('#lnkText').value.trim(), url = $('#lnkUrl').value.trim();
  $('#dlgLink').close(); editor.linkTo(text, url);
});
$('#dlgLink').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (linkValid()) $('#lnkOk').click(); } });

const fileMenu = $('#fileMenu');
$('#btnFile').addEventListener('click', (e) => { e.stopPropagation(); fileMenu.classList.toggle('open'); });
document.addEventListener('click', (e) => { if (!e.target.closest('#fileMenu') || e.target.closest('.menu-pop button')) fileMenu.classList.remove('open'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fileMenu.classList.remove('open'); });
$('#btnWrap').addEventListener('click', () => editor.setWrap(!editor.isWrapping()));

function updateCursorStatus(c) { $('#stCursor').textContent = `Ln ${c.line}, Col ${c.col}`; }
function wordCount(md) {
  const body = splitFrontmatter(md).body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/```[\s\S]*?```/g, ' ').replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/[#>*_`|~\[\]()-]+/g, ' ');
  return (body.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
}
const updateStats = debounce(() => {
  const w = wordCount(state.md);
  $('#stWords').textContent = `${w.toLocaleString('en-AU')} words · ${Math.max(1, Math.ceil(w / 220))} min read`;
}, 300);

/* =====================================================================
   Scroll sync (editor → preview) and active-section highlight in the Contents list
   ===================================================================== */
function headingLines(body) {
  const fm = splitFrontmatter(state.md);
  const off = fm.yamlText === null ? 0 : state.md.slice(0, state.md.length - fm.body.length).split('\n').length - 1;
  const out = [];
  let fence = false;
  body.split('\n').forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
    if (!fence && /^ {0,3}#{1,6}\s+\S/.test(l)) out.push(off + i + 1);
  });
  return out;
}
function headingY(i) {
  const el = document.getElementById('sec-' + i), p = $('#preview');
  return el ? el.getBoundingClientRect().top - p.getBoundingClientRect().top + p.scrollTop : null;
}
function syncPreviewToEditor() {
  const hl = state.hLines || [];
  if (!hl.length) return;
  const p = $('#preview'), L = editor.topLine(), total = editor.cursor().lines;
  let i = -1;
  for (let k = 0; k < hl.length; k++) { if (hl[k] <= L) i = k; else break; }
  let y0, l0, y1, l1;
  if (i < 0) { y0 = 0; l0 = 1; y1 = headingY(0); l1 = hl[0]; }
  else {
    y0 = headingY(i); l0 = hl[i];
    if (i + 1 < hl.length) { y1 = headingY(i + 1); l1 = hl[i + 1]; } else { y1 = Math.max(y0, p.scrollHeight - p.clientHeight); l1 = Math.max(total, l0 + 1); }
  }
  if (y0 == null || y1 == null) return;
  p.scrollTop = y0 + (l1 > l0 ? Math.min(1, Math.max(0, (L - l0) / (l1 - l0))) : 0) * (y1 - y0);
}
function updateActiveToc() {
  const toc = state.toc, hl = state.hLines || [];
  if (!toc.length) return;
  const layout = $('#content').dataset.layout;
  let idx = -1;
  toc.forEach((t, k) => {
    const n = +t.id.replace(/^\D+/, '');
    const passed = layout !== 'visual-view' ? hl[n] != null && hl[n] <= editor.topLine() + 1 : (headingY(n) ?? Infinity) <= $('#preview').scrollTop + 70;
    if (passed) idx = k;
  });
  const nav = $('#tocList');
  nav.querySelectorAll('a.on').forEach((a) => a.classList.remove('on'));
  if (idx >= 0) { const a = nav.querySelector(`a[data-id="${toc[idx].id}"]`); if (a) { a.classList.add('on'); a.scrollIntoView({ block: 'nearest' }); } }
}
let scrollRaf = 0;
function onEditorScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateActiveToc(); });
}
$('#preview').addEventListener('scroll', () => { if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateActiveToc(); }); }, { passive: true });

/* =====================================================================
   Conflict handling (file changed on disk while you have unsaved edits)
   ===================================================================== */
function askConflict(name) {
  return new Promise((resolve) => {
    const d = $('#dlgConflict');
    $('#conflictName').textContent = name;
    const done = (c) => { d.removeEventListener('cancel', onCancel); d.close(); resolve(c); };
    const onCancel = (e) => { e.preventDefault(); done('later'); };
    d.addEventListener('cancel', onCancel);
    d.querySelectorAll('[data-choice]').forEach((b) => { b.onclick = () => done(b.dataset.choice); });
    d.showModal();
  });
}
/* Returns true if it is safe to write `snap` to the linked file. */
async function resolveConflict(snap) {
  const f = await state.fileHandle.getFile();
  if (f.lastModified <= state.lastMod || Date.now() < state.conflictPaused) return Date.now() >= state.conflictPaused;
  const disk = await f.text();
  if (disk === state.diskText || lf(disk) === lf(snap)) return true;       // touched but unchanged, or already identical
  const choice = await askConflict(state.filePath);
  if (choice === 'overwrite') return true;
  if (choice === 'later') { state.conflictPaused = Date.now() + 120000; toast('Not saved – the file on disk is different. Resolve it from the next save prompt.', true); return false; }
  if (choice === 'copy') {
    const dirPrefix = state.filePath.includes('/') ? state.filePath.slice(0, state.filePath.lastIndexOf('/') + 1) : '';
    const base = state.filePath.split('/').pop().replace(/\.(md|markdown)$/i, '');
    const d = new Date(), stamp = `${today()} ${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const entry = await createDocFile(`${dirPrefix}${base} (conflict ${stamp}).md`, snap);
    toast(`Your version was saved as “${entry.name}”.`);
  }
  // 'disk' or 'copy': take the version on disk into the editor
  state.lastMod = f.lastModified; state.diskText = disk; state.eol = eolOf(disk); state.dirty = false;
  setMarkdown(disk, { seed: true });
  return false;
}

/* =====================================================================
   Service worker update prompt
   ===================================================================== */
function showUpdate(reg) {
  $('#updateBar').hidden = false;
  $('#btnUpdate').onclick = async () => { await persistNow(); const w = reg.waiting || reg.installing; if (w) w.postMessage({ type: 'SKIP_WAITING' }); else location.reload(); };
  $('#btnUpdateLater').onclick = () => { $('#updateBar').hidden = true; };
}

/* =====================================================================
   Tables: source model, aligned writer, visual editing in the preview
   The Markdown source stays the single source of truth: every visual edit rewrites the
   table's lines in the document (one undoable change), then the preview re-renders.
   ===================================================================== */
const bodyStartLine = (md) => {
  const fm = splitFrontmatter(md);
  const head = md.slice(0, md.length - fm.body.length);
  return head ? head.split(/\r?\n/).length - 1 : 0;
};
const DELIM_ROW = /^\s{0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
function splitRow(line) {
  let s = line.replace(/\r$/, '').trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (/(?<!\\)\|$/.test(s)) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}
/* Finds pipe tables outside fenced code, including tables inside block quotes ("> | a | b |") and inside list items (indented under
   the item). Returns [{start,end (line indexes), rows[][] (row 0 = header), align[], prefix}]. prefix = the quote marks and indentation
   in front of the first row; it is put back in front of every row when the table is rewritten. */
const QUOTE_PFX = /^(?:[ \t]{0,3}>[ \t]?)+/;
const LIST_START = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/;
const DELIM_LOOSE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const qDepth = (q) => (q.match(/>/g) || []).length;
const splitQuote = (line) => { const m = QUOTE_PFX.exec(line), q = m ? m[0] : ''; return { q, rest: line.slice(q.length) }; };
const leadWidth = (t) => /^[ \t]*/.exec(t)[0].replace(/\t/g, '    ').length;
function scanTables(md) {
  const lines = md.split('\n'), out = [];
  let fence = false, lctx = 0;                       // lctx: where the text of the list item we are inside starts (0 = not in a list)
  for (let i = bodyStartLine(md); i < lines.length; i++) {
    const L = lines[i].replace(/\r$/, '');
    if (/^\s{0,3}(```|~~~)/.test(L)) { fence = !fence; continue; }
    if (fence || !L.trim()) continue;
    const { q, rest } = splitQuote(L), lead = leadWidth(rest), lm = LIST_START.exec(rest);
    if (lm) lctx = lm[0].replace(/\t/g, '    ').length;
    else if (lead < lctx) lctx = 0;
    if (lm || !rest.includes('|') || i + 1 >= lines.length) continue;
    if (!(lead <= 3 || (lctx && lead >= lctx && lead - lctx <= 3))) continue;
    const d = splitQuote(lines[i + 1].replace(/\r$/, ''));
    if (qDepth(d.q) !== qDepth(q) || !DELIM_LOOSE.test(d.rest) || !d.rest.includes('-')) continue;
    const head = splitRow(rest), dcells = splitRow(d.rest);
    if (head.length !== dcells.length) continue;
    const align = dcells.map((a) => (a.startsWith(':') && a.endsWith(':') ? 'center' : a.endsWith(':') ? 'right' : a.startsWith(':') ? 'left' : ''));
    const fit = (r) => { const x = r.slice(0, head.length); while (x.length < head.length) x.push(''); return x; };
    const rows = [head];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const R = lines[j].replace(/\r$/, ''), rr = splitQuote(R);
      if (!R.trim() || qDepth(rr.q) !== qDepth(q) || !rr.rest.trim() || !rr.rest.includes('|') || LIST_START.test(rr.rest) || /^\s{0,3}(```|~~~)/.test(rr.rest)) break;
      rows.push(fit(splitRow(rr.rest)));
    }
    out.push({ start: i, end: j - 1, rows, align, prefix: L.slice(0, L.length - rest.trimStart().length) });
    i = j - 1;
  }
  return out;
}
/* Aligned pipes. A column holding a very long cell (>40 chars) is left unpadded, otherwise every row would balloon. */
function formatTable(rows, align) {
  const n = rows[0].length, width = [];
  for (let c = 0; c < n; c++) {
    let w = 3, big = false;
    for (const r of rows) { const l = (r[c] || '').length; if (l > 40) big = true; if (l > w) w = l; }
    width[c] = big ? 0 : w;
  }
  const cell = (s, c) => {
    s = s || '';
    const w = width[c]; if (!w) return s;
    const gap = w - s.length;
    if (align[c] === 'right') return ' '.repeat(gap) + s;
    if (align[c] === 'center') { const l = Math.floor(gap / 2); return ' '.repeat(l) + s + ' '.repeat(gap - l); }
    return s + ' '.repeat(gap);
  };
  const line = (r) => ('| ' + r.map((s, c) => cell(s, c)).join(' | ') + ' |');
  const delim = align.map((a, c) => {
    const w = Math.max(3, width[c] || 3);
    return a === 'center' ? ':' + '-'.repeat(w - 2) + ':' : a === 'right' ? '-'.repeat(w - 1) + ':' : a === 'left' ? ':' + '-'.repeat(w - 1) : '-'.repeat(w);
  });
  return [line(rows[0]), '| ' + delim.join(' | ') + ' |', ...rows.slice(1).map(line)];
}
function writeTable(ti, model) {
  const t = scanTables(state.md)[ti];
  if (!t) return false;
  const crlf = state.md.includes('\r\n');
  const lines = state.md.split('\n');
  lines.splice(t.start, t.end - t.start + 1, ...formatTable(model.rows, model.align).map((l) => t.prefix + l + (crlf ? '\r' : '')));
  setMarkdown(lines.join('\n'), { fromUser: true });
  refreshDebounced.cancel(); refresh();
  return true;
}
function alignTables() {
  const tabs = scanTables(state.md);
  if (!tabs.length) { toast('No tables found in this document.'); return; }
  const crlf = state.md.includes('\r\n');
  const lines = state.md.split('\n');
  for (let k = tabs.length - 1; k >= 0; k--) {
    const t = tabs[k];
    lines.splice(t.start, t.end - t.start + 1, ...formatTable(t.rows, t.align).map((l) => t.prefix + l + (crlf ? '\r' : '')));
  }
  const out = lines.join('\n');
  if (out === state.md) { toast('Tables are already aligned.'); return; }
  setMarkdown(out, { fromUser: true });
  toast(`Aligned ${tabs.length} table${tabs.length > 1 ? 's' : ''} (columns with very long cells are left unpadded).`);
}
function makeTableMd(cols, rows) {
  const head = Array.from({ length: cols }, (_, i) => 'Column ' + String.fromCharCode(65 + (i % 26)));
  const body = Array.from({ length: rows }, () => Array(cols).fill(''));
  return formatTable([head, ...body], Array(cols).fill('')).join('\n') + '\n';
}
document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.altKey && (e.key === 't' || e.key === 'T')) { e.preventDefault(); alignTables(); } });

/* ---- Preview: map rendered tables/images back to source ---- */
const scanImages = (md) => {
  const out = [], lines = md.split('\n'), start = bodyStartLine(md);
  let off = 0, fence = false;
  lines.forEach((line, i) => {
    const lineOff = off; off += line.length + 1;
    if (i < start) return;
    if (/^\s{0,3}(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const masked = line.replace(/(`+)[^`]*?\1/g, (m) => ' '.repeat(m.length));
    const re = /!\[((?:[^\[\]\\]|\\.)*)\]\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(masked))) out.push({ index: lineOff + m.index, length: m[0].length, alt: line.substr(m.index + 2, m[1].length), url: line.substr(m.index + 4 + m[1].length, m[2].length) });
  });
  return out;
};
function setImageWidth(n, w) {
  const im = scanImages(state.md)[n];
  if (!im) return;
  let base = im.alt;
  const p = base.lastIndexOf('|');
  if (p >= 0 && /^\s*\d+(?:\.\d+)?(?:px|%)?\s*$/.test(base.slice(p + 1))) base = base.slice(0, p);
  const repl = `![${base.trimEnd()}|${Math.round(w)}px](${im.url})`;
  setMarkdown(state.md.slice(0, im.index) + repl + state.md.slice(im.index + im.length), { fromUser: true });
  refreshDebounced.cancel(); refresh();
}

let cellEdit = null, selImgIdx = null, selImg = null;
const cellOf = (el) => (el && el.closest ? el.closest('td[data-r],th[data-r]') : null);
const posOf = (cell) => { const t = cell && cell.closest('table'); return t && t.dataset.ti !== undefined ? { ti: +t.dataset.ti, r: +cell.dataset.r, c: +cell.dataset.c } : null; };
function focusCell(pos) {
  const t = $('#preview').querySelector(`table[data-ti="${pos.ti}"]`);
  const cell = t && t.rows[pos.r] && t.rows[pos.r].cells[pos.c];
  if (cell) cell.focus();
}
function decoratePreview() {
  const p = $('#preview');
  const tabs = scanTables(state.md);
  const els = [...p.querySelectorAll('table')];
  const mapped = tabs.length === els.length;
  els.forEach((t, ti) => {
    const m = tabs[ti];
    if (!mapped || !m || t.rows.length !== m.rows.length || [...t.rows].some((tr) => tr.cells.length !== m.rows[0].length)) return;
    t.dataset.ti = ti;
    [...t.rows].forEach((tr, r) => [...tr.cells].forEach((cell, c) => {
      cell.dataset.r = r; cell.dataset.c = c;
      if (state.mode === 'edit' && !cell.querySelector('.cellcb')) cell.contentEditable = 'plaintext-only';
    }));
  });
  p.querySelectorAll('.cellcb').forEach((cb) => { cb.disabled = cb.closest('table').dataset.ti === undefined; });
  state.imgOK = scanImages(state.md).length === p.querySelectorAll('img[data-img]').length;
  hideTblBar();
  selImg = null;
  const again = selImgIdx !== null && state.mode === 'edit' && state.imgOK ? p.querySelector(`img[data-img="${selImgIdx}"]`) : null;
  if (again) selectImage(again); else { selImgIdx = null; placeImgHandle(); }
}

/* ---- Cell editing: a cell shows its rendered form; focusing it swaps in the raw Markdown for that cell ---- */
const cellText = (el) => el.innerText.replace(/ /g, ' ').replace(/\r?\n+/g, '<br>').replace(/(<br>)+$/, '').replace(/(?<!\\)\|/g, '\\|').trim();
function placeCaretEnd(el) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
function commitCell(focusAfter, { addRow = false, force = false } = {}) {
  const ce = cellEdit;
  if (!ce) return;
  cellEdit = null; ce.el.classList.remove('editing');
  const txt = cellText(ce.el);
  const m = scanTables(state.md)[ce.ti];
  if (!m || (txt === ce.raw && !addRow)) { if (ce.el.isConnected) ce.el.innerHTML = ce.html; if (focusAfter && force) focusCell(focusAfter); return; }
  m.rows[ce.r][ce.c] = txt;
  if (addRow) m.rows.push(m.rows[0].map(() => ''));
  writeTable(ce.ti, m);
  if (focusAfter) focusCell(focusAfter);
}
const tblBar = $('#tblBar');
function showTblBar(table) {
  const tr = table.getBoundingClientRect(), pr = $('#preview').getBoundingClientRect();
  tblBar.style.display = 'flex';
  tblBar.style.left = Math.max(pr.left + 4, tr.left) + 'px';
  tblBar.style.top = Math.max(pr.top + 4, tr.top - tblBar.offsetHeight - 4) + 'px';
}
function hideTblBar() { tblBar.style.display = 'none'; }
$('#preview').addEventListener('focusin', (e) => {
  const cell = cellOf(e.target);
  if (!cell || state.mode !== 'edit' || !cell.isContentEditable || (cellEdit && cellEdit.el === cell)) return;
  const pos = posOf(cell);
  if (!pos) return;
  const m = scanTables(state.md)[pos.ti];
  if (!m || m.rows[pos.r] === undefined || m.rows[pos.r][pos.c] === undefined) return;
  cellEdit = { el: cell, html: cell.innerHTML, raw: m.rows[pos.r][pos.c], ...pos };
  cell.textContent = cellEdit.raw; cell.classList.add('editing');
  placeCaretEnd(cell); showTblBar(cell.closest('table'));
});
$('#preview').addEventListener('focusout', (e) => {
  if (!cellEdit || e.target !== cellEdit.el) return;
  const next = cellOf(e.relatedTarget), np = next ? posOf(next) : null;
  if (!next) hideTblBar();
  commitCell(np);
});
$('#preview').addEventListener('keydown', (e) => {
  if (!cellEdit || e.target !== cellEdit.el) return;
  const { ti, r, c, el } = cellEdit;
  const m = scanTables(state.md)[ti];
  if (!m) return;
  const nr = m.rows.length, nc = m.rows[0].length;
  if (e.key === 'Escape') { e.preventDefault(); el.innerHTML = cellEdit.html; el.classList.remove('editing'); cellEdit = null; el.blur(); return; }
  if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); document.execCommand('insertText', false, '<br>'); return; }
  if (e.key === 'Enter') { e.preventDefault(); commitCell(r + 1 < nr ? { ti, r: r + 1, c } : null, { force: true }); if (r + 1 >= nr) el.blur(); return; }
  if (e.key === 'Tab') {
    e.preventDefault();
    let rr = r, cc = c + (e.shiftKey ? -1 : 1), add = false;
    if (cc >= nc) { cc = 0; rr++; } else if (cc < 0) { cc = nc - 1; rr--; }
    if (rr >= nr) { add = true; }
    if (rr < 0) { rr = 0; cc = 0; }
    commitCell({ ti, r: rr, c: cc }, { addRow: add, force: true });
  }
});
$('#preview').addEventListener('scroll', () => { placeImgHandle(); if (cellEdit) showTblBar(cellEdit.el.closest('table')); });
window.addEventListener('resize', placeImgHandle);

function tableOp(op) {
  const ce = cellEdit, cell = ce ? ce.el : cellOf(document.activeElement);
  const pos = posOf(cell);
  if (!pos) return;
  const m = scanTables(state.md)[pos.ti];
  if (!m) return;
  if (ce) { m.rows[pos.r][pos.c] = cellText(ce.el); cellEdit = null; ce.el.classList.remove('editing'); }
  const n = m.rows[0].length, blank = () => Array(n).fill('');
  let { r, c } = pos;
  switch (op) {
    case 'rowAbove': r = Math.max(r, 1); m.rows.splice(r, 0, blank()); break;
    case 'rowBelow': m.rows.splice(r + 1, 0, blank()); r += 1; break;
    case 'rowDel':
      if (r === 0 || m.rows.length <= 2) { toast('The header row and the last body row cannot be deleted.', true); break; }
      m.rows.splice(r, 1); r = Math.min(r, m.rows.length - 1); break;
    case 'colLeft': m.rows.forEach((row) => row.splice(c, 0, '')); m.align.splice(c, 0, ''); break;
    case 'colRight': m.rows.forEach((row) => row.splice(c + 1, 0, '')); m.align.splice(c + 1, 0, ''); c += 1; break;
    case 'colDel':
      if (n <= 1) { toast('A table needs at least one column.', true); break; }
      m.rows.forEach((row) => row.splice(c, 1)); m.align.splice(c, 1); c = Math.min(c, n - 2); break;
    case 'left': case 'center': case 'right': m.align[c] = m.align[c] === op ? '' : op; break;
    case 'tblDel': {
      const lines = state.md.split('\n'); const t = scanTables(state.md)[pos.ti];
      lines.splice(t.start, t.end - t.start + 1);
      setMarkdown(lines.join('\n'), { fromUser: true }); refreshDebounced.cancel(); refresh(); return;
    }
    default: return;
  }
  writeTable(pos.ti, m);
  focusCell({ ti: pos.ti, r, c });
}
tblBar.addEventListener('mousedown', (e) => e.preventDefault());   // keep focus (and the pending cell text) in the table
tblBar.addEventListener('click', (e) => { const b = e.target.closest('button[data-op]'); if (b) tableOp(b.dataset.op); });

/* Checkbox in a table cell: a cell containing only [ ] or [x] */
document.addEventListener('change', (e) => {
  const t = e.target;
  if (!t.classList || !t.classList.contains('cellcb')) return;
  const cell = cellOf(t), pos = posOf(cell);
  if (!pos) { t.checked = !t.checked; return; }
  const m = scanTables(state.md)[pos.ti];
  if (!m) return;
  m.rows[pos.r][pos.c] = t.checked ? '[x]' : '[ ]';
  writeTable(pos.ti, m);
});

/* ---- Image: click to select, drag the corner handle to resize ---- */
const imgHandle = $('#imgHandle');
function selectImage(im) {
  document.querySelectorAll('#preview img.sel').forEach((x) => x.classList.remove('sel'));
  selImg = im; selImgIdx = +im.dataset.img; im.classList.add('sel');
  placeImgHandle();
}
function placeImgHandle() {
  if (!selImg || !selImg.isConnected || state.mode !== 'edit') { imgHandle.style.display = 'none'; return; }
  const r = selImg.getBoundingClientRect(), pr = $('#preview').getBoundingClientRect();
  if (r.bottom < pr.top || r.bottom > pr.bottom + 2 || r.right > pr.right + 2) { imgHandle.style.display = 'none'; return; }
  imgHandle.style.display = 'block';
  imgHandle.style.left = (r.right - 7) + 'px'; imgHandle.style.top = (r.bottom - 7) + 'px';
}
$('#preview').addEventListener('click', (e) => {
  const im = e.target.closest && e.target.closest('img[data-img]');
  if (im && state.mode === 'edit' && state.imgOK) selectImage(im);
  else { document.querySelectorAll('#preview img.sel').forEach((x) => x.classList.remove('sel')); selImg = null; selImgIdx = null; placeImgHandle(); }
});
imgHandle.addEventListener('pointerdown', (e) => {
  if (!selImg) return;
  e.preventDefault(); imgHandle.setPointerCapture(e.pointerId);
  const x0 = e.clientX, w0 = selImg.getBoundingClientRect().width;
  const maxW = Math.max(60, ($('#preview .page') || $('#preview')).clientWidth - 8);
  const img = selImg;
  const move = (ev) => {
    const w = Math.min(maxW, Math.max(40, w0 + (ev.clientX - x0)));
    img.style.width = w + 'px'; imgHandle.dataset.tip = Math.round(w) + ' px'; placeImgHandle();
  };
  const up = () => {
    imgHandle.removeEventListener('pointermove', move); imgHandle.removeEventListener('pointerup', up);
    imgHandle.classList.remove('drag'); delete imgHandle.dataset.tip;
    setImageWidth(+img.dataset.img, img.getBoundingClientRect().width);
  };
  imgHandle.classList.add('drag');
  imgHandle.addEventListener('pointermove', move); imgHandle.addEventListener('pointerup', up);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && selImg && !cellEdit) { selImg.classList.remove('sel'); selImg = null; selImgIdx = null; placeImgHandle(); } });

/* =====================================================================
   Templates (built in, plus any .md file in the folder's _templates/ directory)
   Placeholders: {{date}} {{title}} {{doc_number}} {{weekday}}
   ===================================================================== */
const DAILY_TPL = `---
title: Daily Priority
date: {{date}}
---

# Priorities:
## Meetings:
| Title | Time | Proposed Duration | Actual Duration | Notes |
| --- | --- | --- | --- | --- |
| Daily Stand-up | 8:45 | 0.25 | |  |



---
---
<br>

## Client-facing Issues
| From | Job # | Issue related to | Time Spent | Notes | Completed? |
| --- | :---: | --- | --- | --- | --- |
| | | | | | [ ] |


---
---
<br>

## Manufacturing-related Issues
| From | Job # | Issue related to | Time Spent | Notes | Completed? |
| --- | :---: | --- | --- | --- | --- |
| | | | | | [ ] |


---
---
<br>

## Major PD (70%)

| Project | Milestone | Task | Allocated Time | Time Spent | Notes |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

---
---
<br>

## Minor PD (20%)

| Project | Task | Allocated Time | Time Spent | Notes |
| --- | --- | --- | --- | --- |
| | | | | |

---
---
<br>

## Admin:

| Task | Time spent | Notes |
|---|---|---|
|  |  |  |


---
---
`;
const fillTpl = (text, title) => text
  .replace(/\{\{date\}\}/g, today()).replace(/\{\{title\}\}/g, title || 'Untitled')
  .replace(/\{\{doc_number\}\}/g, nextDocNo())
  .replace(/\{\{weekday\}\}/g, new Date().toLocaleDateString('en-AU', { weekday: 'long' }));
const dailyPath = () => {
  const dirs = state.files.map((f) => f.path).filter((p) => p.includes('/')).map((p) => p.slice(0, p.lastIndexOf('/')));
  const d = dirs.find((x) => /daily/i.test(x));
  return (d ? d + '/' : '') + today();
};
const TEMPLATES = [
  { id: 'eng', group: 'Dynaflow', name: 'Engineering document', desc: 'Cover page, revision history and contents page, then the content',
    defName: () => 'new-document', build: (title) => newDocTemplate(title, nextDocNo()) },
  { id: 'daily', group: 'Dynaflow', name: 'Daily priority', desc: 'Meetings, client and manufacturing issues, Major/Minor PD and Admin tables',
    defName: dailyPath, build: (title) => fillTpl(DAILY_TPL, title) },
  { id: 'personal', group: 'Personal', name: 'Personal note', desc: 'Title and date frontmatter, no cover page',
    defName: () => 'new-note', build: (title) => `---\n${dumpYaml({ title, date: today() })}---\n\n# ${title}\n\n` },
  { id: 'blank', group: 'Swadhyay / anything else', name: 'Blank note', desc: 'No frontmatter at all',
    defName: () => 'new-note', build: (title) => `# ${title}\n\n` },
];
function folderTemplates() {
  return (state.files || []).filter((f) => /^_templates\//i.test(f.path)).map((f) => ({
    id: 'f:' + f.path, group: 'Your templates (_templates folder)', name: titleFromName(f.name), desc: f.path,
    defName: () => 'new-note', build: null, handle: f.handle,
  }));
}
function openTemplatePicker(target = null) {
  state.tplTarget = target;          // folder the new file goes in (set from a folder's right-click menu), or null
  const all = [...TEMPLATES, ...folderTemplates()];
  let html = '', group = '';
  for (const t of all) {
    if (t.group !== group) { group = t.group; html += `<div class="tpl-group">${esc(group)}</div>`; }
    html += `<button type="button" class="tpl-item" data-tpl="${esc(t.id)}"><b>${esc(t.name)}</b><small>${esc(t.desc)}</small></button>`;
  }
  $('#tplList').innerHTML = html;
  $('#btnSaveTpl').disabled = !state.dir || state.needsReconnect;
  $('#dlgTemplates').showModal();
}
async function newFromTemplate(id) {
  const tpl = [...TEMPLATES, ...folderTemplates()].find((t) => t.id === id);
  if (!tpl) return;
  try {
    const build = async (title) => (tpl.build ? tpl.build(title) : fillTpl(await (await tpl.handle.getFile()).text(), title));
    if (!state.dir || state.needsReconnect) {
      if (state.dirty) await persistNow();
      if (!confirm('No folder is open, so the new document replaces the one in the editor. Download the current one first if you need a copy. Continue?')) return;
      state.fileHandle = null; state.filePath = null; state.parentDir = null;
      setMarkdown(await build('Untitled'), { fromUser: true });
      state.mode = 'edit'; updateFileLabel(); renderFiles(); applyLayout();
      return;
    }
    const def = state.tplTarget ? joinPath(state.tplTarget, baseName(tpl.defName())) : tpl.defName();
    const raw = prompt('File name (use folder/name to place it in a subfolder):', def);
    if (!raw || !raw.trim()) return;
    if (state.dirty) await persistNow();
    const lastSeg = raw.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Untitled';
    const entry = await createDocFile(raw, await build(titleFromName(lastSeg)));
    await openFileEntry(entry);
    state.mode = 'edit'; applyLayout();
    toast('Created ' + entry.path);
  } catch (e) { console.error(e); toast('Could not create document: ' + e.message, true); }
}
async function saveAsTemplate() {
  const name = prompt('Template name (saved in the _templates folder; {{date}} {{title}} {{doc_number}} {{weekday}} get filled in when you use it):', 'my-template');
  if (!name || !name.trim()) return;
  try { await createDocFile('_templates/' + name.trim(), state.md); toast('Saved template “' + name.trim() + '”.'); }
  catch (e) { console.error(e); toast('Could not save template: ' + e.message, true); }
}
function newDocument() { openTemplatePicker(); }
$('#tplList').addEventListener('click', (e) => { const b = e.target.closest('[data-tpl]'); if (b) { $('#dlgTemplates').close(); newFromTemplate(b.dataset.tpl); } });
$('#btnTplCancel').addEventListener('click', () => $('#dlgTemplates').close());
$('#btnSaveTpl').addEventListener('click', () => { $('#dlgTemplates').close(); saveAsTemplate(); });
$('#btnPromote').addEventListener('click', () => { if (state.mode !== 'edit') { toast('Switch to Edit mode first.', true); return; } completeFrontmatter(); });

function sampleDiagram() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 220" font-family="Arial" font-size="14">
<rect width="640" height="220" fill="#fff"/>
<g fill="#f1f5f9" stroke="#0f172a" stroke-width="1.5"><rect x="20" y="80" width="110" height="60" rx="6"/><rect x="190" y="80" width="110" height="60" rx="6"/><rect x="360" y="80" width="110" height="60" rx="6"/><rect x="520" y="80" width="100" height="60" rx="6"/></g>
<g fill="#0f172a" text-anchor="middle"><text x="75" y="115">Face velocity</text><text x="245" y="115">PLC (PI loop)</text><text x="415" y="115">VFD</text><text x="570" y="115">Fan motor</text></g>
<g stroke="#0f172a" stroke-width="1.5" fill="none" marker-end="url(#a)"><path d="M130 110H190"/><path d="M300 110H360"/><path d="M470 110H520"/></g>
<defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8z" fill="#0f172a"/></marker></defs>
<text x="320" y="190" text-anchor="middle" fill="#475569">Figure 1 – Speed control signal path (sample)</text></svg>`;
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));   // UTF-8 safe (the sample contains an en dash)
}


/* =====================================================================
   Tabs and side-by-side view
   One editor is shared by all tabs: the open tab is "state"; the others are parked here with their text and
   undo history. A tab that is not being edited is always already saved, so nothing is lost by switching.
   The side pane shows a second tab read-only; "Edit this" swaps it with the tab you are editing.
   ===================================================================== */
var docTabs = [], activeTab = null, refTab = null, tabSeq = 0;
const newTab = (o) => Object.assign({ id: ++tabSeq, path: null, handle: null, parent: null, md: '', seedMd: null, snap: null, diskText: null, eol: '\n', lastMod: 0 }, o);
const isPristine = (t) => !t.path && t.seedMd !== null && (t === activeTab ? state.md : t.md) === t.seedMd;
const tabTitle = (t) => (t.path ? t.path.split('/').pop().replace(/\.(md|markdown)$/i, '') : 'Untitled');
function syncActive() {
  const t = activeTab; if (!t) return;
  t.md = state.md; t.handle = state.fileHandle; t.path = state.filePath; t.parent = state.parentDir;
  t.diskText = state.diskText; t.eol = state.eol; t.lastMod = state.lastMod; t.snap = editor.snapshot();
}
async function tabFromEntry(entry) {
  const file = await entry.handle.getFile(), text = await file.text();
  return newTab({ path: entry.path, handle: entry.handle, parent: entry.parent, md: text, diskText: text, eol: eolOf(text), lastMod: file.lastModified });
}
/* A parked tab may have been changed on disk (OneDrive, another editor). Pick that up before showing it. */
async function freshen(t) {
  if (!t || t === activeTab || !t.handle) return false;
  try {
    const f = await t.handle.getFile();
    if (f.lastModified === t.lastMod) return false;
    const txt = await f.text(); t.lastMod = f.lastModified;
    if (txt === t.diskText) return false;
    t.md = txt; t.diskText = txt; t.eol = eolOf(txt); t.snap = null; return true;
  } catch (e) { return false; }
}
function tabsRec() {
  const d = docTabs.find((t) => !t.path && !isPristine(t));
  return { id: 'tabs_state', paths: docTabs.filter((t) => t.path || !isPristine(t)).map((t) => t.path || null), ref: refTab && refTab.path || null,
    draft: d ? (d === activeTab ? state.md : d.md) : null };
}
function persistTabs() { if (state.db) DB.put(state.db, tabsRec()).catch(() => {}); }
function loadTab(t) {
  state.fileHandle = t.handle; state.filePath = t.path; state.parentDir = t.parent; state.diskText = t.diskText;
  state.eol = t.eol; state.lastMod = t.lastMod; state.conflictPaused = 0; state.dirty = false; state.md = t.md;
  clearAssetCache();
  refreshDebounced.cancel();
  editor.restore(t.snap, t.md);
  if (t.path) { if (state.openDirs) expandTo(t.path); state.sel = t.path; }
  refresh();
  updateFileLabel(); renderFiles(); renderRef();
  setSaveStatus('saved');
  saveFolderRecord(); persistTabs();
  if (state.db) DB.put(state.db, { id: 'active_document', markdown: t.md, meta: state.meta || null, updated: Date.now() }).catch(() => {});
}
async function switchTab(t) {
  if (!t || t === activeTab) return;
  if (state.dirty) await persistNow();
  await freshen(t);
  syncActive();
  const prev = activeTab;
  activeTab = t;
  if (refTab === t) refTab = prev;
  loadTab(t);
}
async function openFileEntry(entry, opts = {}) {
  let t = docTabs.find((x) => x.path === entry.path);
  if (opts.side) {
    if (t === activeTab) { toast('That file is the one you are editing. Open a different file to the side.', true); return; }
    if (!t) { t = await tabFromEntry(entry); docTabs.push(t); } else await freshen(t);
    refTab = t; document.body.classList.add('split');
    renderTabs(); renderRef(); persistTabs();
    return;
  }
  if (t) { await switchTab(t); return; }
  t = await tabFromEntry(entry);
  if (state.dirty) await persistNow();
  syncActive();
  const prev = activeTab;
  docTabs.push(t);
  if (prev && isPristine(prev)) { if (refTab === prev) closeSplit(); docTabs.splice(docTabs.indexOf(prev), 1); }
  activeTab = t;
  if (refTab === t) closeSplit();
  loadTab(t);
}
function dropTab(t) {
  const i = docTabs.indexOf(t); if (i >= 0) docTabs.splice(i, 1);
  if (refTab === t) closeSplit();
}
async function closeTab(t) {
  if (!t) return;
  if (!t.path && !isPristine(t) && (t === activeTab ? state.md : t.md).trim() && !confirm('This draft is not saved to a file. Close it and discard the text?')) return;
  if (t !== activeTab) { dropTab(t); renderTabs(); persistTabs(); return; }
  if (state.dirty) await persistNow();
  const i = docTabs.indexOf(t);
  docTabs.splice(i, 1);
  let next = docTabs[i] || docTabs[i - 1];
  if (!next) { next = newTab({ md: '', seedMd: '' }); docTabs.push(next); }
  if (refTab === t) closeSplit();
  if (refTab === next) closeSplit();
  await freshen(next);
  activeTab = next;
  loadTab(next);
}
function detachTabs() {
  docTabs = docTabs.filter((t) => !t.path || t === activeTab);
  if (activeTab) { if (activeTab.path) activeTab.seedMd = null; activeTab.path = null; activeTab.handle = null; activeTab.parent = null; }
  closeSplit();
}
async function restoreTabs(rec) {
  if (!rec || !state.files) return;
  for (const p of (rec.paths || []).filter(Boolean)) {
    if (docTabs.some((t) => t.path === p)) continue;
    const e = state.files.find((f) => f.path === p);
    if (e) { try { docTabs.push(await tabFromEntry(e)); } catch (err) { /* file gone */ } }
  }
  if (rec.draft && rec.draft.trim() && !docTabs.some((t) => !t.path && !isPristine(t))) {
    const prev = activeTab;
    if (prev && isPristine(prev) && prev.path === null) { /* boot placeholder: the stored draft replaces it */ }
    docTabs.push(newTab({ md: rec.draft, seedMd: null }));
  }
  const order = (rec.paths || []).map((p) => p || '\u0000draft'), rank = (t) => { const i = order.indexOf(t.path || '\u0000draft'); return i < 0 ? 999 : i; };
  docTabs.sort((a, b) => rank(a) - rank(b));
  const r = rec.ref && docTabs.find((t) => t.path === rec.ref && t !== activeTab);
  if (r) { refTab = r; document.body.classList.add('split'); }
  renderTabs(); renderRef();
}
function closeSplit() { refTab = null; document.body.classList.remove('split'); if (typeof renderTabs === 'function') renderTabs(); persistTabs(); }
var tabDrag = null, tabClickBlock = 0;
function renderTabs() {
  const el = document.getElementById('tabs'); if (!el || !activeTab || (tabDrag && tabDrag.on)) return;
  activeTab.path = state.filePath; activeTab.handle = state.fileHandle; activeTab.parent = state.parentDir;
  el.innerHTML = docTabs.map((t) => {
    const on = t === activeTab, ttl = tabTitle(t);
    return `<div class="tab${on ? ' on' : ''}${t === refTab ? ' side' : ''}" role="tab" tabindex="0" aria-selected="${on}" data-tab="${t.id}" title="${esc(t.path || 'Unsaved draft (kept in this browser)')}"><span class="tt">${esc(ttl)}</span>${on && state.dirty ? '<i class="dot" title="Saving…"></i>' : ''}<button type="button" class="x" tabindex="-1" aria-label="Close ${esc(ttl)}">✕</button></div>`;
  }).join('');
  const cur = el.querySelector('.tab.on'); if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const b = document.getElementById('btnSplit'); if (b) { b.classList.toggle('on', !!refTab); b.setAttribute('aria-pressed', String(!!refTab)); }
}
function renderRef() {
  const body = document.getElementById('refBody'); if (!body || !refTab || !document.body.classList.contains('split')) return;
  document.getElementById('refTitle').textContent = refTab.path || 'Unsaved draft';
  const keep = body.scrollTop;
  try {
    const parsed = parseDoc(refTab.md);
    const res = renderBody(parsed.body, { prefix: 'ref-', numbered: !parsed.note });
    body.innerHTML = `<div class="page doc">${docCardHTML(parsed.note && !parsed.meta ? null : parsed.meta, parsed.warnings, false, parsed.note)}${res.html}</div>`;
    body.scrollTop = keep;
    applyAssets(body, refTab.path).catch((e) => console.warn(e));
  } catch (e) { body.innerHTML = '<div class="ref-empty">Could not display this file: ' + esc(e.message) + '</div>'; }
}
function toggleSplit() {
  if (refTab) { closeSplit(); return; }
  const i = docTabs.indexOf(activeTab), other = docTabs[i + 1] || docTabs[i - 1];
  if (!other) { toast('Open a second file first: right-click a file in the list and choose Open to the Side.', true); return; }
  refTab = other; document.body.classList.add('split');
  freshen(other).then(() => renderRef()); renderTabs(); renderRef(); persistTabs();
}
$('#btnSplit').addEventListener('click', toggleSplit);
$('#refClose').addEventListener('click', closeSplit);
$('#refEdit').addEventListener('click', () => { if (refTab) switchTab(refTab); });
$('#refBody').addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]'); if (!a) return;
  e.preventDefault();
  const el = $('#refBody').querySelector('[id="ref-' + CSS.escape(a.getAttribute('href').slice(1)).replace(/\\/g, '') + '"]');
  if (el) el.scrollIntoView({ block: 'start' });
});
function moveTab(t, to) {   // to = index in the list without t
  const from = docTabs.indexOf(t); if (from < 0) return;
  docTabs.splice(from, 1); docTabs.splice(Math.max(0, Math.min(to, docTabs.length)), 0, t);
  renderTabs(); persistTabs();
}
$('#tabs').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.x')) return;
  const el = e.target.closest('.tab'); if (!el) return;
  const d = tabDrag = { id: +el.dataset.tab, el, x0: e.clientX, on: false, to: 0 };
  const strip = $('#tabs');
  const move = (ev) => {
    if (!d.on) { if (Math.abs(ev.clientX - d.x0) < 6) return; d.on = true; d.el.classList.add('dragging'); }
    const others = [...strip.querySelectorAll('.tab')].filter((x) => x !== d.el);
    d.to = others.filter((x) => { const r = x.getBoundingClientRect(); return ev.clientX > r.left + r.width / 2; }).length;
    others.forEach((x) => x.classList.remove('drop-before', 'drop-end'));
    if (d.to < others.length) others[d.to].classList.add('drop-before'); else if (others.length) others[others.length - 1].classList.add('drop-end');
    const sr = strip.getBoundingClientRect();
    if (ev.clientX < sr.left + 28) strip.scrollLeft -= 14; else if (ev.clientX > sr.right - 28) strip.scrollLeft += 14;
  };
  const end = (ev) => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end);
    const was = d.on; tabDrag = null;
    if (was) { tabClickBlock = Date.now(); const t = docTabs.find((x) => x.id === d.id); if (t && ev.type === 'pointerup') moveTab(t, d.to); else renderTabs(); }
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
});
$('#tabs').addEventListener('click', (e) => {
  if (Date.now() - tabClickBlock < 250) return;
  const el = e.target.closest('.tab'); if (!el) return;
  const t = docTabs.find((x) => x.id === +el.dataset.tab); if (!t) return;
  if (e.target.closest('.x')) closeTab(t); else switchTab(t);
});
$('#tabs').addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;
  const el = e.target.closest('.tab'); const t = el && docTabs.find((x) => x.id === +el.dataset.tab);
  if (t) { e.preventDefault(); closeTab(t); }
});
$('#tabs').addEventListener('keydown', (e) => {
  const el = e.target.closest('.tab'); if (!el) return;
  const t = docTabs.find((x) => x.id === +el.dataset.tab); if (!t) return;
  if (e.altKey && e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault(); const i = docTabs.indexOf(t), j = e.key === 'ArrowLeft' ? i - 1 : i + 1;
    if (j >= 0 && j < docTabs.length) { moveTab(t, j); const n = $('#tabs').querySelector(`.tab[data-tab="${t.id}"]`); if (n) n.focus(); }
  }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchTab(t); }
  else if (e.key === 'Delete') { e.preventDefault(); closeTab(t); }
});
$('#tabs').addEventListener('contextmenu', (e) => {
  const el = e.target.closest('.tab'); if (!el) return;
  const t = docTabs.find((x) => x.id === +el.dataset.tab); if (!t) return;
  e.preventDefault();
  ctxNode = null;
  ctxPick = async (act) => {
    if (act === 'close') await closeTab(t);
    else if (act === 'others') { for (const o of docTabs.slice()) if (o !== t) await closeTab(o); }
    else if (act === 'side') { if (t === activeTab) return; refTab = t; document.body.classList.add('split'); renderTabs(); renderRef(); persistTabs(); }
    else if (act === 'relpath' && t.path) copyText(t.path);
  };
  showMenu([...(t !== activeTab ? [['side', 'Open to the Side']] : []), ['close', 'Close'], ['others', 'Close Others', '', docTabs.length < 2], ...(t.path ? [['relpath', 'Copy Relative Path']] : [])], e.clientX, e.clientY);
});
window.addEventListener('focus', () => { if (refTab) freshen(refTab).then((c) => c && renderRef()); });
(() => {
  const sp = $('#refSplit'), pane = $('#refPane'), work = $('#work');
  if (typeof sideCfg.refW === 'number') pane.style.setProperty('--ref-w', sideCfg.refW + 'px');
  sp.addEventListener('pointerdown', (e) => {
    sp.setPointerCapture(e.pointerId); sp.classList.add('drag');
    const move = (ev) => {
      const r = work.getBoundingClientRect(), w = Math.round(Math.min(Math.max(r.right - ev.clientX, 220), r.width * 0.75));
      pane.style.setProperty('--ref-w', w + 'px'); sideCfg.refW = w;
    };
    const up = () => { sp.classList.remove('drag'); sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); saveSideCfg(); };
    sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up);
  });
})();

async function boot() {
  let rec = null;
  try {
    state.db = await DB.open();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch {}
    rec = await DB.get(state.db, 'active_document');
  } catch (e) {
    console.error('IndexedDB unavailable', e);
    state.db = null;
    toast('Local storage unavailable – changes will not be saved.', true);
  }
  if (rec && typeof rec.markdown === 'string') setMarkdown(rec.markdown, { seed: true });
  else {
    setMarkdown($('#seedDoc').textContent.replace(/^\n/, '').replace('{{DIAGRAM}}', sampleDiagram()), { seed: true });
    if (state.db) await persistNow();
  }
  if (!state.db) setSaveStatus('error');
  activeTab = newTab({ md: state.md, seedMd: state.md }); docTabs = [activeTab];
  applyLayout();
  updateFileLabel(); renderFiles(); renderTabs();
  await restoreFolder();
}
boot();
