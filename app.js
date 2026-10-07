'use strict';
/* =====================================================================
   Engineering Document & Note Manager
   ===================================================================== */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STATUSES = ['DRAFT', 'PRELIMINARY', 'FOR REVIEW', 'APPROVED', 'RELEASED', 'OBSOLETE'];
const state = { md: '', format: 'visual', mode: 'view', toc: [], meta: null, db: null, dbOK: true,
  dir: null, files: [], filePath: null, fileHandle: null, lastMod: 0, dirty: false, needsReconnect: false, pendingFile: null,
  parentDir: null, diskText: '', conflictPaused: 0, hLines: [] };

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

function setSaveStatus(kind) {
  const el = $('#saveStatus');
  el.className = kind === 'saving' ? 'saving' : kind === 'error' ? 'error' : '';
  el.querySelector('span').textContent = kind === 'saving' ? 'Saving…' : kind === 'error' ? 'Not saved' : 'Saved';
}

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
      if (await resolveConflict(snap)) { await writeFile(state.fileHandle, snap); state.diskText = snap; if (state.md === snap) state.dirty = false; }
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
  return w;
}

/* Returns { meta (normalised or null), warnings[], body } */
function parseDoc(text) {
  const { yamlText, body } = splitFrontmatter(text);
  if (yamlText === null) return { meta: null, warnings: ['No YAML frontmatter found (document must begin with --- ... ---).'], body };
  let meta;
  try {
    // CORE_SCHEMA keeps YYYY-MM-DD as a string instead of a Date object
    meta = jsyaml.load(yamlText, { schema: jsyaml.CORE_SCHEMA });
  } catch (e) {
    return { meta: null, warnings: ['YAML error: ' + (e.reason || e.message)], body, yamlError: true };
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
  const { prefix = 'sec-', light = false, interactive = false } = opts;
  const { text, maths } = protect(src);
  const toc = [], cnt = [0, 0, 0, 0];
  let hIdx = 0, taskIdx = 0;

  const plain = (raw) => String(raw).replace(/ZZMATH(\d+)ZZ/g, (m, i) => maths[+i].tex).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  const renderer = {
    heading(t, level, raw) {
      const i = hIdx++;
      let num = '';
      if (level <= 4) {
        cnt[level - 1]++;
        for (let k = level; k < 4; k++) cnt[k] = 0;
        num = level === 1 ? `${cnt[0]}.0` : cnt.slice(0, level).join('.');
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
      let a = alt || '', style = '';
      const p = a.lastIndexOf('|');
      if (p >= 0) {
        const size = a.slice(p + 1).trim();
        if (/^\d+(?:\.\d+)?(?:px|%)?$/.test(size)) { a = a.slice(0, p).trim(); style = `width:${/\D$/.test(size) ? size : size + 'px'};`; }
      }
      if (!/^(data:|https?:|blob:|\/\/)/i.test(href || '')) return `<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-asset="${esc(href)}" alt="${esc(a)}"${title ? ` title="${esc(title)}"` : ''} style="${style}max-width:100%;height:auto">`;
      return `<img src="${esc(safeUrl(href))}" alt="${esc(a)}"${title ? ` title="${esc(title)}"` : ''} style="${style}max-width:100%;height:auto">`;
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
function docCardHTML(meta, warnings, canFix) {
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

const previewVisible = () => state.format === 'visual';

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
      res = renderBody(parsed.body, { interactive: state.mode === 'edit' });
      const p = $('#preview');
      const keep = p.scrollTop;
      p.innerHTML = `<div class="page doc">${docCardHTML(parsed.meta, parsed.warnings, !parsed.yamlError)}${res.html}</div>`;
      p.scrollTop = keep;
      applyAssets(p).catch((e) => console.warn(e));
    } else {
      res = renderBody(stripData(parsed.body), { light: true });
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
const refreshDebounced = debounce(refresh, 150);

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
  refresh();
  if (editing) setTimeout(() => editor.focus(), 0);
}
$('#segFormat').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.format = b.dataset.v; applyLayout(); } });
$('#segMode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.mode = b.dataset.v; applyLayout(); } });
$('#btnSide').addEventListener('click', () => document.body.classList.toggle('no-side'));
$('#tocList').addEventListener('click', (e) => { const a = e.target.closest('a'); if (a) { e.preventDefault(); scrollToHeading(a.dataset.id); } });

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
    onSelection: (c) => updateCursorStatus(c),
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
  if (!t.classList || !t.classList.contains('task') || state.mode !== 'edit') return;
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
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
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

function buildPrint() {
  const parsed = parseDoc(state.md);
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
  const noCover = pg.on_cover ? '' : `@page cover { @top-left{content:none;border:0} @top-center{content:none;border:0} @top-right{content:none;border:0}
                  @bottom-left{content:none;border:0} @bottom-center{content:none;border:0} @bottom-right{content:none;border:0} }`;
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
        : def.revisions;
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
  $('#fileLabel').textContent = state.filePath ? '📄 ' + state.filePath : state.dir ? 'Not linked to a file' : 'Browser storage';
}
function showPane(name) {
  $('#filesPane').style.display = name === 'files' ? '' : 'none';
  $('#tocPane').style.display = name === 'toc' ? '' : 'none';
  $('#sidebar .side-tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.pane === name));
}
async function saveFolderRecord() {
  if (!state.db || !state.dir) return;
  try { await DB.put(state.db, { id: 'folder_handle', handle: state.dir, lastFile: state.filePath || null }); }
  catch (e) { console.warn('Could not remember folder', e); }
}
async function scanFolder() {
  const out = [];
  async function walk(dir, prefix, depth) {
    for await (const [name, handle] of dir.entries()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      if (handle.kind === 'directory') { if (depth < 5) await walk(handle, prefix + name + '/', depth + 1); }
      else if (/\.(md|markdown)$/i.test(name)) out.push({ path: prefix + name, name, handle, parent: dir });
    }
  }
  try { await walk(state.dir, '', 0); }
  catch (e) { console.error(e); toast('Could not read folder: ' + e.message, true); }
  out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  state.files = out;
  renderFiles();
}
function renderFiles() {
  const el = $('#filesPane');
  if (!FS_OK) { el.innerHTML = '<div class="fp-msg">Folder access needs Chrome, Edge or Brave. Documents are still saved in this browser.</div>'; return; }
  if (!state.dir) { el.innerHTML = '<div class="fp-msg">No folder open. Open a folder and your documents are saved there as .md files.<br><button class="btn2" data-act="open">Open Folder</button></div>'; return; }
  if (state.needsReconnect) { el.innerHTML = `<div class="fp-msg">Folder “${esc(state.dir.name)}” needs permission again after the browser restarted.<br><button class="btn2" data-act="reconnect">Reconnect</button> <button class="btn2" data-act="open" style="background:#64748b">Other folder…</button></div>`; return; }
  let html = `<div class="fp-head"><span title="${esc(state.dir.name)}">📁 ${esc(state.dir.name)}</span><span><button data-act="new" title="New document">＋</button><button data-act="refresh" title="Rescan folder">⟳</button><button data-act="open" title="Open a different folder">…</button></span></div>`;
  let lastDir = '';
  for (const f of state.files) {
    const i = f.path.lastIndexOf('/'), dir = i < 0 ? '' : f.path.slice(0, i);
    if (dir !== lastDir) { if (dir) html += `<div class="fp-dir">${esc(dir)}</div>`; lastDir = dir; }
    html += `<a href="#" data-path="${esc(f.path)}" class="fp-file${f.path === state.filePath ? ' on' : ''}${dir ? ' in' : ''}" title="${esc(f.path)}">${esc(f.name)}</a>`;
  }
  if (!state.files.length) html += '<div class="fp-msg">No .md files yet. Use ＋ to create one.</div>';
  el.innerHTML = html;
}
async function openFileEntry(entry) {
  if (state.dirty) await persistNow();
  const file = await entry.handle.getFile();
  const text = await file.text();
  state.fileHandle = entry.handle; state.filePath = entry.path; state.lastMod = file.lastModified;
  state.parentDir = entry.parent; state.diskText = text; state.conflictPaused = 0; clearAssetCache();
  setMarkdown(text, { seed: true });
  updateFileLabel(); renderFiles();
  saveFolderRecord();
  if (state.db) DB.put(state.db, { id: 'active_document', markdown: text, meta: state.meta || null, updated: Date.now() }).catch(() => {});
  setSaveStatus('saved');
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
    await scanFolder(); showPane('files'); updateFileLabel(); await saveFolderRecord();
    if (hadUnlinked && confirm(`Save the document currently in the editor into “${h.name}” as a new file?`)) {
      const pm = parseDoc(prevMd).meta;
      const name = prompt('File name:', ((pm && pm.doc_number) || 'document').replace(/[^\w.\-]+/g, '_'));
      if (name && name.trim()) await openFileEntry(await createDocFile(name, prevMd));
    }
  } catch (e) { if (e.name !== 'AbortError') { console.error(e); toast('Could not open folder: ' + e.message, true); } }
}
async function activateFolder() {
  state.needsReconnect = false;
  await scanFolder(); showPane('files');
  if (state.pendingFile) {
    const f = state.files.find((x) => x.path === state.pendingFile);
    state.pendingFile = null;
    if (f) await openFileEntry(f);
  }
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
async function newDocument() {
  try {
    if (!state.dir || state.needsReconnect) {
      if (state.dirty) await persistNow();
      if (!confirm('No folder is open, so the new document replaces the one in the editor. Download the current one first if you need a copy. Continue?')) return;
      state.fileHandle = null; state.filePath = null;
      setMarkdown(newDocTemplate('Untitled Document', nextDocNo()), { fromUser: true });
      state.mode = 'edit'; updateFileLabel(); renderFiles(); applyLayout();
      return;
    }
    const raw = prompt('New document name (use folder/name to place it in a subfolder):', 'new-document');
    if (!raw || !raw.trim()) return;
    if (state.dirty) await persistNow();
    const lastSeg = raw.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Untitled Document';
    const entry = await createDocFile(raw, newDocTemplate(titleFromName(lastSeg), nextDocNo()));
    await openFileEntry(entry);
    state.mode = 'edit'; applyLayout();
    toast('Created ' + entry.path);
  } catch (e) { console.error(e); toast('Could not create document: ' + e.message, true); }
}
$('#btnFolder').addEventListener('click', openFolder);
$('#btnFolder').disabled = !FS_OK;
if (!FS_OK) $('#btnFolder').title = 'Needs Chrome, Edge or Brave (File System Access API)';
$('#btnNew').addEventListener('click', newDocument);
$('#sidebar .side-tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showPane(b.dataset.pane); });
$('#filesPane').addEventListener('click', async (e) => {
  e.preventDefault();
  const act = e.target.closest('[data-act]'), a = e.target.closest('a[data-path]');
  try {
    if (act) {
      const k = act.dataset.act;
      if (k === 'open') await openFolder();
      else if (k === 'new') await newDocument();
      else if (k === 'refresh') await scanFolder();
      else if (k === 'reconnect') { if ((await state.dir.requestPermission({ mode: 'readwrite' })) === 'granted') await activateFolder(); else toast('Permission was not granted.', true); }
    } else if (a) {
      const f = state.files.find((x) => x.path === a.dataset.path);
      if (f && f.path !== state.filePath) await openFileEntry(f);
    }
  } catch (err) { console.error(err); toast(err.message, true); }
});
/* Pick up edits made to the file by other programs while this window was in the background */
window.addEventListener('focus', async () => {
  if (!state.fileHandle || state.dirty) return;
  try {
    const f = await state.fileHandle.getFile();
    if (f.lastModified > state.lastMod) {
      state.lastMod = f.lastModified;
      const text = await f.text();
      state.diskText = text;
      if (text !== state.md) { setMarkdown(text, { seed: true }); toast('Reloaded – the file changed on disk.'); }
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
function sanitize(html) {
  if (!window.DOMPurify) throw new Error('DOMPurify failed to load – refusing to render unsanitised HTML.');
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true, svg: true, mathMl: true }, FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed'], FORBID_ATTR: ['srcset'] });
}

/* =====================================================================
   Images stored as files (assets/ next to the document)
   ===================================================================== */
const assetCache = new Map();      // normalised path from folder root → { url, file }
function clearAssetCache() { for (const r of assetCache.values()) { try { URL.revokeObjectURL(r.url); } catch {} } assetCache.clear(); }

function assetKey(src) {
  try {
    const rel = decodeURI(src.split('#')[0].split('?')[0]);
    const parts = state.filePath ? state.filePath.split('/').slice(0, -1) : [];
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
function applyAssets(root) {
  const pending = [];
  for (const img of root.querySelectorAll('img[data-asset]')) {
    const src = img.getAttribute('data-asset');
    const key = assetKey(src);
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
  table: () => editor.insertTemplate('| Column A | Column B | Column C |\n| --- | --- | --- |\n| § |  |  |\n|  |  |  |\n'),
  eq: () => editor.insertTemplate('$$\n§\n$$\n'),
  codeblock: () => editor.insertTemplate('```\n§\n```\n'),
  image: () => $('#fileImage').click(),
};
$('#formatBar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });   // keep the caret in the editor
$('#formatBar').addEventListener('click', (e) => { const b = e.target.closest('button[data-cmd]'); if (b && FB[b.dataset.cmd]) { FB[b.dataset.cmd](); editor.focus(); } });

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
    const passed = layout === 'raw' ? hl[n] != null && hl[n] <= editor.topLine() + 1 : (headingY(n) ?? Infinity) <= $('#preview').scrollTop + 70;
    if (passed) idx = k;
  });
  const nav = $('#tocList');
  nav.querySelectorAll('a.on').forEach((a) => a.classList.remove('on'));
  if (idx >= 0) { const a = nav.querySelector(`a[data-id="${toc[idx].id}"]`); if (a) { a.classList.add('on'); a.scrollIntoView({ block: 'nearest' }); } }
}
let scrollRaf = 0;
function onEditorScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; if ($('#content').dataset.layout === 'visual-edit') syncPreviewToEditor(); updateActiveToc(); });
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
  if (disk === state.diskText || disk === snap) return true;       // touched but unchanged, or already identical
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
  state.lastMod = f.lastModified; state.diskText = disk; state.dirty = false;
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
  applyLayout();
  updateFileLabel(); renderFiles();
  await restoreFolder();
}
boot();
