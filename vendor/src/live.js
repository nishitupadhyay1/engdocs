/* EngDocs – "Live preview" for the CodeMirror editor.
   The document stays plain Markdown. This only changes how it is *drawn*:
   - Markdown symbols (#, **, ~~, `, [](), >) are hidden on every line the caret/selection is not on.
   - "- [ ]" / "- [x]" become real, clickable checkboxes.
   - Images are drawn in place; click to select, drag the corner handle to resize (rewrites ![alt|450px](…)).
   - Pipe tables are drawn as tables; click a cell to edit it. Edits are written back as an aligned table.
   - The YAML frontmatter is drawn as a compact document card (click it to edit the YAML).
   - $$ display equations and $inline$ equations are drawn with KaTeX; fenced code blocks are boxed and syntax-coloured.
   Everything is derived from the text, so turning Live preview off (or opening the file elsewhere) shows ordinary Markdown. */
import { Decoration, ViewPlugin, WidgetType, EditorView, keymap } from '@codemirror/view';
import { StateField, StateEffect, EditorState, EditorSelection, Prec } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

export const bumpLive = StateEffect.define();
let selImgPos = null;       // document position of the selected image widget
let pendingFocus = null;    // { start, r, c }: start editing this table cell after the next render
const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const posOf = (view, dom) => { try { return view.posAtDOM(dom, 0); } catch { return null; } };

/* ---------------------------------------------------------------- small widgets */
class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() { return el('span', 'cm-live-bullet', '•'); }
  ignoreEvent() { return false; }
}
class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() { return el('span', 'cm-live-hr'); }
  ignoreEvent() { return false; }
}
class CheckWidget extends WidgetType {
  constructor(checked) { super(); this.checked = checked; }
  eq(o) { return o.checked === this.checked; }
  toDOM(view) {
    const cb = el('input', 'cm-live-cb');
    cb.type = 'checkbox'; cb.checked = this.checked; cb.setAttribute('aria-label', 'Task');
    cb.addEventListener('mousedown', (e) => e.preventDefault());           // do not move the caret (that would reveal the line's raw Markdown)
    cb.addEventListener('click', (e) => { e.preventDefault(); toggleTask(view, cb); });
    return cb;
  }
  ignoreEvent() { return true; }
}
const BULLET = Decoration.replace({ widget: new BulletWidget() });
const RULE = Decoration.replace({ widget: new RuleWidget() });
const CHECKED = new CheckWidget(true), UNCHECKED = new CheckWidget(false);

function toggleTask(view, cb) {
  if (view.state.readOnly) return;
  const pos = posOf(view, cb);
  if (pos == null) return;
  const m = /^(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\]/.exec(view.state.sliceDoc(pos, pos + 16));
  if (!m) return;
  const at = pos + m[0].length - 2;
  view.dispatch({ changes: { from: at, to: at + 1, insert: m[1] === ' ' ? 'x' : ' ' }, userEvent: 'input' });
}

/* ---------------------------------------------------------------- images */
function imageParts(doc, m0, m1, urlNode) {
  const alt = doc.sliceString(m0.to, m1.from);
  const src = doc.sliceString(urlNode.from, urlNode.to).replace(/^<|>$/g, '');
  let width = '', label = alt;
  const p = alt.lastIndexOf('|');
  if (p >= 0) {
    const size = alt.slice(p + 1).trim();
    if (/^\d+(?:\.\d+)?(?:px|%)?$/.test(size)) { label = alt.slice(0, p).trim(); width = /\D$/.test(size) ? size : size + 'px'; }
  }
  return { alt: label, src, width };
}
const DIRECT_SRC = /^(data:image\/|https?:|blob:)/i;

class ImageWidget extends WidgetType {
  constructor(alt, src, width, from, sel, ctx) { super(); Object.assign(this, { alt, src, width, from, sel, ctx }); }
  eq(o) { return o.src === this.src && o.alt === this.alt && o.width === this.width && o.from === this.from && o.sel === this.sel; }
  toDOM(view) {
    const wrap = el('span', 'cm-live-img' + (this.sel ? ' sel' : ''));
    const img = el('img'); img.alt = this.alt; img.draggable = false;
    if (this.width) img.style.width = this.width;
    if (DIRECT_SRC.test(this.src)) img.src = this.src;
    else if (/^(javascript|vbscript|data):/i.test(this.src)) { img.src = PLACEHOLDER; img.classList.add('img-missing'); }
    else { img.src = PLACEHOLDER; img.setAttribute('data-asset', this.src); wrap.appendChild(img); this.ctx.assets && this.ctx.assets(wrap); }
    if (!img.parentNode) wrap.appendChild(img);
    const handle = el('span', 'cm-live-handle'); handle.title = 'Drag to resize';
    wrap.appendChild(handle);

    wrap.addEventListener('mousedown', (e) => {
      if (e.target === handle) return;
      e.preventDefault();                                           // selecting the picture must not move the caret
      const pos = posOf(view, wrap);
      if (pos != null && selImgPos !== pos) { selImgPos = pos; view.dispatch({ effects: bumpLive.of(null) }); }
      view.focus();
    });
    wrap.addEventListener('dblclick', (e) => {                      // double-click: show the Markdown for this image
      e.preventDefault();
      const pos = posOf(view, wrap);
      if (pos != null) { selImgPos = null; view.dispatch({ selection: { anchor: pos + 2 } }); view.focus(); }
    });
    handle.addEventListener('pointerdown', (e) => {
      if (view.state.readOnly) return;
      e.preventDefault(); e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const x0 = e.clientX, w0 = img.getBoundingClientRect().width;
      const maxW = Math.max(120, view.contentDOM.clientWidth - 40);
      let w = w0;
      const move = (ev) => { w = Math.max(32, Math.min(maxW, w0 + ev.clientX - x0)); img.style.width = w + 'px'; wrap.dataset.tip = Math.round(w) + ' px'; };
      const up = () => {
        handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
        delete wrap.dataset.tip;
        setImageWidth(view, wrap, w);
      };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
    });
    return wrap;
  }
  ignoreEvent() { return true; }
}

function setImageWidth(view, wrap, w) {
  const pos = posOf(view, wrap);
  if (pos == null) return;
  let n = syntaxTree(view.state).resolveInner(pos, 1);
  while (n && n.name !== 'Image') n = n.parent;
  if (!n) return;
  const marks = []; for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === 'LinkMark') marks.push(c);
  if (marks.length < 2) return;
  const alt = view.state.sliceDoc(marks[0].to, marks[1].from);
  let base = alt;
  const p = base.lastIndexOf('|');
  if (p >= 0 && /^\s*\d+(?:\.\d+)?(?:px|%)?\s*$/.test(base.slice(p + 1))) base = base.slice(0, p);
  selImgPos = n.from;
  view.dispatch({ changes: { from: marks[0].to, to: marks[1].from, insert: `${base.trimEnd()}|${Math.round(w)}px` }, userEvent: 'input' });
}

/* ---------------------------------------------------------------- tables */
const CHECK_CELL = /^\[([ xX])\]$/;
const esc = (s) => String(s).replace(/(?<!\\)\|/g, '\\|');

/* Pure: apply a row/column operation to a table model {rows, align}. Returns {r,c} | {del:true} | {error}. */
export function applyTableOp(model, op, r, c) {
  const n = model.rows[0].length, blank = () => Array(n).fill('');
  switch (op) {
    case 'rowAbove': r = Math.max(r, 1); model.rows.splice(r, 0, blank()); break;
    case 'rowBelow': model.rows.splice(r + 1, 0, blank()); r += 1; break;
    case 'rowDel':
      if (r === 0 || model.rows.length <= 2) return { error: 'The header row and the last body row cannot be deleted.' };
      model.rows.splice(r, 1); r = Math.min(r, model.rows.length - 1); break;
    case 'colLeft': model.rows.forEach((row) => row.splice(c, 0, '')); model.align.splice(c, 0, ''); break;
    case 'colRight': model.rows.forEach((row) => row.splice(c + 1, 0, '')); model.align.splice(c + 1, 0, ''); c += 1; break;
    case 'colDel':
      if (n <= 1) return { error: 'A table needs at least one column.' };
      model.rows.forEach((row) => row.splice(c, 1)); model.align.splice(c, 1); c = Math.min(c, n - 2); break;
    case 'left': case 'center': case 'right': model.align[c] = model.align[c] === op ? '' : op; break;
    case 'tblDel': return { del: true };
    default: return { error: 'Unknown table action.' };
  }
  return { r, c };
}

class TableWidget extends WidgetType {
  constructor(t, ctx) { super(); this.t = t; this.ctx = ctx; this.key = JSON.stringify([t.start, t.rows, t.align]); }
  eq(o) { return o.key === this.key; }
  get estimatedHeight() { return 32 * this.t.rows.length + 36; }
  ignoreEvent() { return true; }
  toDOM(view) { return buildTable(view, this.t, this.ctx); }
}

function tableAt(view, root, ctx) {
  const pos = posOf(view, root);
  if (pos == null) return null;
  const tools = ctx.tableTools && ctx.tableTools();
  if (!tools) return null;
  const line = view.state.doc.lineAt(pos).number - 1;
  const t = tools.scan(view.state.doc.toString()).find((x) => x.start === line);
  return t ? { t, tools, rows: t.rows.map((r) => r.slice()), align: t.align.slice() } : null;
}
function writeTable(view, m, pf) {
  const doc = view.state.doc;
  const from = doc.line(m.t.start + 1).from, to = doc.line(m.t.end + 1).to;
  pendingFocus = pf ? { start: m.t.start, ...pf } : null;
  view.dispatch({ changes: { from, to, insert: m.tools.format(m.rows, m.align).join('\n') }, userEvent: 'input' });
  // The rebuilt table is already in the DOM here, so move focus now: keystrokes typed right after Tab must not be lost.
  if (pendingFocus) {
    const root = view.dom.querySelector(`.cm-live-table[data-start="${m.t.start}"]`);
    if (root && root._startEdit) { const p = pendingFocus; pendingFocus = null; root._startEdit(p.r, p.c); }
  }
}

function buildTable(view, t, ctx) {
  const root = el('div', 'cm-live-table');
  const scroller = el('div', 'cm-live-tscroll'), table = el('table');
  const readOnly = () => view.state.readOnly;
  root._edit = null; root._last = null; root.dataset.start = t.start;

  const paint = (cell, raw, header) => {
    cell.replaceChildren();
    const ck = !header && CHECK_CELL.exec(raw.trim());
    if (ck) { const cb = el('input', 'cellcb'); cb.type = 'checkbox'; cb.checked = ck[1] !== ' '; cell.appendChild(cb); }
    else if (raw && ctx.renderInline) cell.innerHTML = ctx.renderInline(raw);
    else cell.textContent = raw;
  };
  t.rows.forEach((row, r) => {
    const tr = el('tr');
    row.forEach((raw, c) => {
      const cell = el(r === 0 ? 'th' : 'td'); cell.dataset.r = r; cell.dataset.c = c; cell.tabIndex = 0;
      if (t.align[c]) cell.style.textAlign = t.align[c];
      paint(cell, raw, r === 0); tr.appendChild(cell);
    });
    table.appendChild(tr);
  });
  scroller.appendChild(table); root.appendChild(scroller);

  const cellAt = (r, c) => table.rows[r] && table.rows[r].cells[c];
  const rcOf = (cell) => (cell && cell.dataset && cell.dataset.r !== undefined ? { r: +cell.dataset.r, c: +cell.dataset.c } : null);

  function startEdit(r, c) {
    if (readOnly()) return;
    const cell = cellAt(r, c);
    if (!cell || cell.querySelector('.cellcb')) return;
    const raw = (t.rows[r] && t.rows[r][c]) || '';
    const input = el('input', 'cm-cell-in'); input.type = 'text'; input.value = raw; input.spellcheck = true;
    cell.classList.add('editing'); cell.replaceChildren(input);
    root._edit = { r, c, raw, input, cell }; root._last = { r, c };
    input.focus(); input.setSelectionRange(raw.length, raw.length);
  }
  function stopEdit() {                                    // restore the rendered cell, no write
    const ed = root._edit; if (!ed) return null;
    root._edit = null; ed.cell.classList.remove('editing'); paint(ed.cell, ed.raw, ed.r === 0);
    return ed;
  }
  function commit(next, extra) {                           // write the edited cell (if changed) and move on
    const ed = root._edit; if (!ed) return;
    const val = esc(ed.input.value.trim());
    root._edit = null;
    if (val === ed.raw && !(extra && extra.addRow)) {
      ed.cell.classList.remove('editing'); paint(ed.cell, ed.raw, ed.r === 0);
      if (next) startEdit(next.r, next.c);
      return;
    }
    const m = tableAt(view, root, ctx);
    if (!m || !m.rows[ed.r]) return;
    m.rows[ed.r][ed.c] = val;
    if (extra && extra.addRow) m.rows.push(m.rows[0].map(() => ''));
    writeTable(view, m, next);
  }

  root._startEdit = startEdit;
  root.addEventListener('focusin', (e) => {
    if (e.target.matches && e.target.matches('th,td') && !root._edit) { const rc = rcOf(e.target); if (rc) startEdit(rc.r, rc.c); }
  });
  root.addEventListener('focusout', (e) => {
    const ed = root._edit;
    if (!ed || e.target !== ed.input) return;
    const nx = e.relatedTarget && root.contains(e.relatedTarget) ? rcOf(e.relatedTarget.closest && e.relatedTarget.closest('th,td')) : null;
    commit(nx);
  });
  root.addEventListener('keydown', (e) => {
    const ed = root._edit;
    if (!ed || e.target !== ed.input) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { commit(null); return; }   // let the app's Save run after the write
    const nr = t.rows.length, nc = t.rows[0].length;
    if (e.key === 'Escape') { e.preventDefault(); stopEdit(); view.focus(); return; }
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      const i = ed.input, a = i.selectionStart, z = i.selectionEnd;
      i.value = i.value.slice(0, a) + '<br>' + i.value.slice(z); i.setSelectionRange(a + 4, a + 4); return;
    }
    if (e.key === 'Enter') { e.preventDefault(); commit(ed.r + 1 < nr ? { r: ed.r + 1, c: ed.c } : null); if (ed.r + 1 >= nr) view.focus(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      let rr = ed.r, cc = ed.c + (e.shiftKey ? -1 : 1), add = false;
      if (cc >= nc) { cc = 0; rr++; } else if (cc < 0) { cc = nc - 1; rr--; }
      if (rr >= nr) add = true;
      if (rr < 0) { rr = 0; cc = 0; }
      commit({ r: rr, c: cc }, add ? { addRow: true } : undefined);
    }
  });
  root.addEventListener('change', (e) => {                  // checkbox cell
    const cb = e.target; if (!cb.classList || !cb.classList.contains('cellcb') || readOnly()) return;
    const rc = rcOf(cb.closest('th,td')), m = rc && tableAt(view, root, ctx);
    if (!m) return;
    m.rows[rc.r][rc.c] = cb.checked ? '[x]' : '[ ]';
    writeTable(view, m, null);
  });

  /* Row / column tools */
  const bar = el('div', 'cm-live-tbar');
  const B = [['rowAbove', 'Row ↑'], ['rowBelow', 'Row ↓'], ['rowDel', 'Row ✕'], ['colLeft', 'Col ←'], ['colRight', 'Col →'], ['colDel', 'Col ✕'],
    ['left', 'Left'], ['center', 'Centre'], ['right', 'Right'], ['tblDel', 'Delete table'], ['source', 'Edit source']];
  B.forEach(([op, label]) => { const b = el('button', null, label); b.type = 'button'; b.dataset.op = op; bar.appendChild(b); });
  bar.addEventListener('mousedown', (e) => e.preventDefault());       // keep the cell's text field focused
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-op]'); if (!b) return;
    const op = b.dataset.op;
    if (op === 'source') { const pos = posOf(view, root); if (pos != null) { view.dispatch({ selection: { anchor: pos } }); view.focus(); } return; }
    if (readOnly()) return;
    const ed = root._edit, at = ed ? { r: ed.r, c: ed.c } : root._last;
    if (!at) { ctx.toast && ctx.toast('Click a cell first, then choose the row or column action.', true); return; }
    const m = tableAt(view, root, ctx); if (!m) return;
    if (ed) { m.rows[ed.r][ed.c] = esc(ed.input.value.trim()); root._edit = null; }
    const res = applyTableOp(m, op, at.r, at.c);
    if (res.error) { ctx.toast && ctx.toast(res.error, true); if (ed) writeTable(view, m, at); return; }
    if (res.del) {
      const doc = view.state.doc;
      pendingFocus = null;
      view.dispatch({ changes: { from: doc.line(m.t.start + 1).from, to: Math.min(doc.length, doc.line(m.t.end + 1).to + 1) }, userEvent: 'input' });
      return;
    }
    writeTable(view, m, { r: res.r, c: res.c });
  });
  root.appendChild(bar);

  // Normally writeTable() focuses the rebuilt table straight away (and clears pendingFocus). This is only the fallback
  // for a table that gets rebuilt some other way while a focus request is still waiting.
  if (pendingFocus && pendingFocus.start === t.start) {
    requestAnimationFrame(() => {
      if (pendingFocus && pendingFocus.start === t.start && root.isConnected) { const pf = pendingFocus; pendingFocus = null; startEdit(pf.r, pf.c); }
    });
  }
  return root;
}

/* ---------------------------------------------------------------- frontmatter card, equations, code */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const openFm = StateEffect.define();            // true = show the YAML, false = show the card
const FENCE = /^---[ \t]*$/;
function fmRangeDoc(doc) {
  if (doc.lines < 2 || !FENCE.test(doc.line(1).text)) return null;
  const max = Math.min(doc.lines, 600);
  for (let i = 2; i <= max; i++) if (FENCE.test(doc.line(i).text)) return { from: 0, to: doc.line(i).to, text: doc.sliceString(0, doc.line(i).to) };
  return null;
}
class FmWidget extends WidgetType {
  constructor(html) { super(); this.html = html; }
  eq(o) { return o.html === this.html; }
  toDOM(view) {
    const d = el('div', 'cm-live-fm');
    d.tabIndex = 0; d.setAttribute('role', 'button'); d.title = 'Click to edit the document information';
    d.innerHTML = this.html;
    const open = () => {
      const doc = view.state.doc, at = doc.lines >= 2 ? doc.line(2).to : 0;
      view.dispatch({ effects: openFm.of(true), selection: { anchor: at }, scrollIntoView: true }); view.focus();
    };
    d.addEventListener('mousedown', (e) => { if (e.target.closest && e.target.closest('.fix-fm')) return; e.preventDefault(); open(); });
    d.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return d;
  }
  ignoreEvent() { return true; }
}
class MathWidget extends WidgetType {
  constructor(tex, display, ctx, block = display) { super(); this.tex = tex; this.display = display; this.block = block; this.ctx = ctx; }
  eq(o) { return o.tex === this.tex && o.display === this.display && o.block === this.block; }
  toDOM(view) {
    const d = el(this.block ? 'div' : 'span', this.block ? 'cm-live-math' : 'cm-live-imath');
    d.title = 'Click to edit the equation';
    try { d.innerHTML = this.ctx.mathHTML ? this.ctx.mathHTML(this.tex, this.display) : ''; } catch (e) { d.textContent = this.tex; }
    d.addEventListener('mousedown', (e) => { e.preventDefault(); const p = posOf(view, d); if (p != null) { view.dispatch({ selection: { anchor: p }, scrollIntoView: true }); view.focus(); } });
    return d;
  }
  ignoreEvent() { return true; }
}
const NOFORMAT = new Set(['FencedCode', 'CodeBlock', 'Frontmatter', 'InlineCode']);
function inCode(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) if (NOFORMAT.has(n.name)) return true;
  return false;
}
function scanMath(state) {
  const doc = state.doc, out = [];
  if (!doc.length || !doc.toString().includes('$$')) return out;
  const zones = [];
  syntaxTree(state).iterate({ enter(n) { if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'Frontmatter') { zones.push([n.from, n.to]); return false; } } });
  const inZone = (p) => zones.some(([a, b]) => p >= a && p <= b);
  for (let i = 1; i <= doc.lines; i++) {
    const ln = doc.line(i), t = ln.text.trim();
    if (!t.startsWith('$$') || inZone(ln.from)) continue;
    if (t.length > 4 && t.endsWith('$$')) { const tex = t.slice(2, -2).trim(); if (tex) out.push({ from: ln.from, to: ln.to, tex }); continue; }
    if (t.length > 2 && !t.endsWith('$$')) { /* "$$ x" opens, continue below */ }
    for (let j = i + 1; j <= Math.min(doc.lines, i + 300); j++) {
      const e = doc.line(j), et = e.text.trim();
      if (!et.endsWith('$$')) continue;
      const parts = [ln.text.slice(ln.text.indexOf('$$') + 2)];
      for (let k = i + 1; k < j; k++) parts.push(doc.line(k).text);
      parts.push(e.text.slice(0, e.text.lastIndexOf('$$')));
      const tex = parts.join('\n').trim();
      if (tex) out.push({ from: ln.from, to: e.to, tex });
      i = j;
      break;
    }
  }
  return out;
}
const IMATH = /(?<![\\$])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\d$])/g;     // same rule as the preview and PDF
const DMATH = /\$\$([^\n]+?)\$\$/g;                                                // $$ … $$ in the middle of a line (display style, kept inline)
const tokCache = new Map();
function cachedTokens(ctx, code, lang) {
  const k = lang + '\0' + code;
  let v = tokCache.get(k);
  if (!v) { try { v = ctx.codeTokens(code, lang) || []; } catch (e) { v = []; } tokCache.set(k, v); if (tokCache.size > 60) tokCache.delete(tokCache.keys().next().value); }
  return v;
}

/* ---------------------------------------------------------------- the extension */
export function liveExtensions(ctx) {
  /* Tables: a block widget per table, found from the text (same scanner the preview pane uses). */
  const tableField = StateField.define({
    create(state) { return buildTables(state, null); },
    update(v, tr) {
      if (tr.docChanged) return buildTables(tr.state, null);
      if (!tr.startState.selection.eq(tr.state.selection) || tr.effects.some((e) => e.is(bumpLive))) return buildTables(tr.state, v.tables);
      return v;
    },
    provide: (f) => [EditorView.decorations.from(f, (v) => v.decos), EditorView.atomicRanges.of((view) => view.state.field(f).decos)],
  });
  function buildTables(state, known) {
    const tools = ctx.tableTools && ctx.tableTools();
    const doc = state.doc;
    let tables = known;
    if (!tables) {
      tables = [];
      if (tools && doc.length && doc.toString().includes('|')) {
        try {
          for (const t of tools.scan(doc.toString())) {
            let plain = true;                                  // tables inside lists/indented blocks stay as source (rewriting would lose the indent)
            for (let i = t.start; i <= t.end && plain; i++) if (/^\s/.test(doc.line(i + 1).text)) plain = false;
            if (plain) tables.push(t);
          }
        } catch (e) { console.error('Live preview: table scan failed', e); tables = []; }
      }
    }
    const out = [], shown = [], sel = state.selection.ranges;
    for (const t of tables) {
      const from = doc.line(t.start + 1).from, to = doc.line(t.end + 1).to;
      if (sel.some((r) => r.from <= to && r.to >= from)) continue;     // caret/selection in the table → show its Markdown
      out.push(Decoration.replace({ widget: new TableWidget(t, ctx), block: true }).range(from, to));
      shown.push({ from, to });
    }
    return { tables, decos: Decoration.set(out, true), shown };
  }

  /* Frontmatter: a block card in place of the YAML until you click it or move the caret into it. */
  function buildFm(state, open, prev) {
    const r = fmRangeDoc(state.doc);
    if (!r) return { open: false, shown: false, r: null, html: '', decos: Decoration.none };
    let html = prev && prev.r && prev.r.text === r.text ? prev.html : '';
    if (!html && ctx.frontCard) { try { html = ctx.frontCard(r.text) || ''; } catch (e) { console.error('Live preview: frontmatter card failed', e); } }
    const shown = !open && !!html && r.to < state.doc.length;
    return { open, shown, r, html, decos: shown ? Decoration.set([Decoration.replace({ widget: new FmWidget(html), block: true }).range(r.from, r.to)]) : Decoration.none };
  }
  const fmField = StateField.define({
    create(state) { return buildFm(state, false, null); },
    update(v, tr) {
      if (!tr.docChanged && !tr.selection && !tr.effects.length) return v;
      let open = v.open, forced = false;
      for (const e of tr.effects) if (e.is(openFm)) { open = e.value; forced = true; }
      let next = buildFm(tr.state, open, v);
      if (next.open && next.r && !forced && tr.state.selection.main.head > next.r.to) next = buildFm(tr.state, false, v);      // caret left the YAML → card again
      return next;
    },
    provide: (f) => [EditorView.decorations.from(f, (v) => v.decos), EditorView.atomicRanges.of((view) => view.state.field(f).decos)],
  });
  /* While the card is showing, the caret may not sit inside it and typed text may not reach it (that would corrupt the "---" fences). */
  const fmGuard = EditorState.transactionFilter.of((tr) => {
    const f = tr.startState.field(fmField, false);
    if (!f) return tr;
    let open = f.open;
    for (const e of tr.effects) if (e.is(openFm)) open = e.value;
    if (open) return tr;
    const r = fmRangeDoc(tr.newDoc), r0 = f.r;
    if (f.shown && r0 && tr.docChanged && tr.startState.selection.main.empty && (tr.isUserEvent('input') || tr.isUserEvent('delete'))) {   // a cursor (not a selection) typing into the card
      let hit = false;
      tr.changes.iterChangedRanges((fa) => { if (fa <= r0.to) hit = true; });
      if (hit) return [];
    }
    if (!r || r.to >= tr.newDoc.length) return tr;
    const sel = tr.newSelection.main;
    if (!sel.empty || sel.head > r.to) return tr;
    return [tr, { selection: EditorSelection.cursor(r.to + 1), sequential: true }];
  });
  /* Chrome drops the caret position when text is typed over a selection that covers the card, so the first typed letter
     would stay selected and the next one would replace it. Do that replacement ourselves. */
  const typeOver = EditorView.inputHandler.of((view, from, to, text) => {
    const sel = view.state.selection.main, f = view.state.field(fmField, false);
    if (sel.empty || !f || !f.shown || from !== sel.from || to !== sel.to) return false;
    view.dispatch({ ...view.state.replaceSelection(text), userEvent: 'input.type', scrollIntoView: true });
    return true;
  });
  function enterFm(view, force) {
    const f = view.state.field(fmField, false);
    if (!f || !f.shown) return false;
    const h = view.state.selection.main;
    if (!force && !(h.empty && h.head <= f.r.to + 1)) return false;
    const doc = view.state.doc;
    view.dispatch({ effects: openFm.of(true), selection: { anchor: doc.lines >= 2 ? doc.line(2).to : 0 }, scrollIntoView: true });
    return true;
  }
  const fmKeys = Prec.high(keymap.of([
    { key: 'ArrowUp', run: (v) => enterFm(v, false) }, { key: 'ArrowLeft', run: (v) => enterFm(v, false) },
    { key: 'Backspace', run: (v) => enterFm(v, false) }, { key: 'Mod-Home', run: (v) => enterFm(v, true) },
  ]));

  /* Display equations ($$ … $$ on their own lines) as block widgets. */
  const mathField = StateField.define({
    create(state) { return buildMath(state, null); },
    update(v, tr) {
      if (tr.docChanged) return buildMath(tr.state, null);
      if (!tr.startState.selection.eq(tr.state.selection) || tr.effects.some((e) => e.is(bumpLive))) return buildMath(tr.state, v.blocks);
      return v;
    },
    provide: (f) => [EditorView.decorations.from(f, (v) => v.decos), EditorView.atomicRanges.of((view) => view.state.field(f).decos)],
  });
  function buildMath(state, known) {
    let blocks = known;
    if (!blocks) { try { blocks = scanMath(state); } catch (e) { console.error('Live preview: equation scan failed', e); blocks = []; } }
    const sel = state.selection.ranges, out = [];
    for (const b of blocks) {
      if (sel.some((r) => r.from <= b.to && r.to >= b.from)) continue;           // caret in the equation → show its source
      out.push(Decoration.replace({ widget: new MathWidget(b.tex, true, ctx), block: true }).range(b.from, b.to));
    }
    return { blocks, decos: Decoration.set(out, true) };
  }

  /* Inline formatting, checkboxes, images, rules, quotes. */
  function build(view) {
    const { state } = view, doc = state.doc, sel = state.selection.ranges;
    const shown = state.field(tableField, false) ? state.field(tableField).shown : [];
    const mathAll = state.field(mathField, false) ? state.field(mathField).blocks : [];
    const deco = [], atomic = [];
    const lineAct = (from, to) => { const a = doc.lineAt(from).from, z = doc.lineAt(Math.min(to, doc.length)).to; return sel.some((r) => r.from <= z && r.to >= a); };
    const inMathBlk = (a, b) => mathAll.some((m) => a >= m.from && b <= m.to);
    const imath = [];                                                      // inline $…$ equations on lines the caret is not on
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const ln = doc.lineAt(pos);
        if (ln.text.indexOf('$') >= 0 && !lineAct(ln.from, ln.to) && !inMathBlk(ln.from, ln.to) && !(shown.length && shown.some((s) => ln.from >= s.from && ln.to <= s.to))) {
          const here = [];
          for (const [re, display] of [[DMATH, true], [IMATH, false]]) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(ln.text))) {
              const a = ln.from + m.index, b = a + m[0].length;
              if (here.some((h) => a < h.to && b > h.from) || inCode(state, a)) continue;
              here.push({ from: a, to: b, tex: m[1].trim(), display });
            }
          }
          for (const h of here) if (h.tex) imath.push(h);
        }
        pos = ln.to + 1;
      }
    }
    const inIm = (p) => imath.some((m) => p >= m.from && p < m.to);
    for (const m of imath.sort((a, b) => a.from - b.from)) { const d = Decoration.replace({ widget: new MathWidget(m.tex, m.display, ctx, false) }).range(m.from, m.to); deco.push(d); atomic.push(d); }
    const doneCode = new Set();
    const rep = (from, to, spec) => { if (to > from && !inIm(from)) { const d = (spec || Decoration.replace({})).range(from, to); deco.push(d); atomic.push(d); } };
    const hideSp = (from, to) => rep(from, to + (doc.sliceString(to, to + 1) === ' ' ? 1 : 0));
    const inTable = (a, b) => shown.some((s) => a >= s.from && b <= s.to);

    for (const { from, to } of view.visibleRanges) {
      syntaxTree(state).iterate({
        from, to,
        enter(node) {
          if (shown.length && inTable(node.from, node.to)) return false;
          if (mathAll.length && inMathBlk(node.from, node.to)) return false;
          const n = node.node;
          switch (node.name) {
            case 'FencedCode': {
              if (doneCode.has(node.from)) return false;
              doneCode.add(node.from);
              const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
              const closed = last.number > first.number && /^\s*(```+|~~~+)\s*$/.test(last.text);
              const active = sel.some((r) => r.from <= node.to && r.to >= node.from);
              const lang = ((first.text.match(/^\s*(?:```+|~~~+)\s*(\S*)/) || [])[1]) || '';
              for (let k = first.number; k <= last.number; k++) {
                const isFence = k === first.number || (closed && k === last.number);
                deco.push(Decoration.line({ class: 'cm-live-code' + (k === first.number ? ' cm-live-code-first' : '') + (k === last.number ? ' cm-live-code-last' : '') + (isFence && !active ? ' cm-live-fence' : '') }).range(doc.line(k).from));
              }
              if (!active) for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === 'CodeMark') rep(c.from, c.to);
              const bodyFrom = first.to + 1, bodyTo = closed ? last.from - 1 : node.to;
              if (ctx.codeTokens && lang && bodyTo > bodyFrom) {
                for (const t of cachedTokens(ctx, doc.sliceString(bodyFrom, bodyTo), lang)) if (t.to > t.from) deco.push(Decoration.mark({ class: t.cls }).range(bodyFrom + t.from, bodyFrom + t.to));
              }
              return false;
            }
            case 'HeaderMark': { const p = n.parent; if (p && /^ATXHeading/.test(p.name) && !lineAct(p.from, p.to)) hideSp(node.from, node.to); break; }
            case 'EmphasisMark': case 'StrikethroughMark': { const p = n.parent; if (p && !lineAct(p.from, p.to)) rep(node.from, node.to); break; }
            case 'CodeMark': { const p = n.parent; if (p && p.name === 'InlineCode' && !lineAct(p.from, p.to)) rep(node.from, node.to); break; }
            case 'InlineCode': deco.push(Decoration.mark({ class: 'cm-live-icode' }).range(node.from, node.to)); break;
            case 'QuoteMark': if (!lineAct(node.from, node.to)) hideSp(node.from, node.to); break;
            case 'Blockquote':
              for (let p = node.from; p <= node.to;) { const ln = doc.lineAt(p); deco.push(Decoration.line({ class: 'cm-live-quote' }).range(ln.from)); p = ln.to + 1; }
              break;
            case 'HorizontalRule': if (!lineAct(node.from, node.to)) rep(node.from, node.to, RULE); break;
            case 'ListMark': {
              const li = n.parent, nx = n.nextSibling;
              if (li && li.parent && li.parent.name === 'BulletList' && !(nx && nx.name === 'Task') && !lineAct(node.from, node.to)) rep(node.from, node.to, BULLET);
              break;
            }
            case 'TaskMarker': {
              const task = n.parent, li = task && task.parent, lm = li && li.firstChild;
              if (!li || !li.parent || li.parent.name !== 'BulletList' || !lm || lm.name !== 'ListMark') break;
              rep(lm.from, node.to, Decoration.replace({ widget: /[xX]/.test(doc.sliceString(node.from, node.to)) ? CHECKED : UNCHECKED }));
              break;
            }
            case 'Link': {
              let open = null, close = null, url = null;
              for (let c = n.firstChild; c; c = c.nextSibling) {
                if (c.name === 'LinkMark') { if (!open) open = c; else if (!close) close = c; } else if (c.name === 'URL') url = doc.sliceString(c.from, c.to);
              }
              if (!open || !close || url === null || close.from <= open.to) break;
              if (!lineAct(n.from, n.to)) { rep(open.from, open.to); rep(close.from, n.to); }
              deco.push(Decoration.mark({ class: 'cm-live-link', attributes: { 'data-href': url.replace(/^<|>$/g, ''), title: 'Ctrl+click to open' } }).range(open.to, close.from));
              break;
            }
            case 'Image': {
              let m0 = null, m1 = null, u = null;
              for (let c = n.firstChild; c; c = c.nextSibling) { if (c.name === 'LinkMark') { if (!m0) m0 = c; else if (!m1) m1 = c; } else if (c.name === 'URL') u = c; }
              if (!m0 || !m1 || !u) return false;
              if (sel.some((r) => r.from < n.to && r.to > n.from)) return false;      // caret inside → show the Markdown
              const info = imageParts(doc, m0, m1, u);
              if (!info.src) return false;
              rep(n.from, n.to, Decoration.replace({ widget: new ImageWidget(info.alt, info.src, info.width, n.from, selImgPos === n.from, ctx) }));
              return false;
            }
          }
        },
      });
    }
    return { decorations: Decoration.set(deco, true), atomic: Decoration.set(atomic, true) };
  }

  const plugin = ViewPlugin.fromClass(class {
    constructor(view) { Object.assign(this, build(view)); }
    update(u) {
      if (u.docChanged && selImgPos != null) selImgPos = u.changes.mapPos(selImgPos);
      if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state) || u.transactions.some((tr) => tr.effects.some((e) => e.is(bumpLive)))) Object.assign(this, build(u.view));
    }
  }, {
    decorations: (v) => v.decorations,
    provide: (p) => EditorView.atomicRanges.of((view) => { const v = view.plugin(p); return v ? v.atomic : Decoration.none; }),
  });

  const handlers = EditorView.domEventHandlers({
    mousedown(e, view) {
      if (selImgPos != null && !(e.target.closest && e.target.closest('.cm-live-img'))) { selImgPos = null; view.dispatch({ effects: bumpLive.of(null) }); }
      return false;
    },
    click(e) {
      const a = e.target.closest && e.target.closest('.cm-live-link');
      if (a && (e.ctrlKey || e.metaKey)) {
        const href = a.getAttribute('data-href') || '';
        if (/^https?:\/\//i.test(href)) { e.preventDefault(); window.open(href, '_blank', 'noopener,noreferrer'); return true; }
      }
      return false;
    },
  });

  return [fmField, fmGuard, fmKeys, typeOver, tableField, mathField, plugin, handlers, liveTheme];
}

const liveTheme = EditorView.theme({
  '.cm-live-cb': { margin: '0 4px 0 0', width: '15px', height: '15px', verticalAlign: '-2px', cursor: 'pointer', accentColor: '#2563eb' },
  '.cm-live-bullet': { color: '#64748b', display: 'inline-block', width: '1ch', textAlign: 'center' },
  '.cm-live-hr': { display: 'inline-block', width: '100%', borderTop: '2px solid #cbd5e1', verticalAlign: 'middle' },
  '.cm-live-link': { color: '#2563eb', textDecoration: 'underline', cursor: 'text' },
  '.cm-live-icode': { background: '#f1f5f9', borderRadius: '3px', fontFamily: MONO, fontSize: '.88em' },
  '.cm-live-fm': { margin: '2px 0 18px', cursor: 'pointer', outline: 'none', fontFamily: 'ui-sans-serif, system-ui, "Segoe UI", sans-serif', whiteSpace: 'normal' },
  '.cm-live-fm .doccard': { margin: '0', borderRadius: '8px' },
  '.cm-live-fm:hover .doccard, .cm-live-fm:focus .doccard': { borderColor: '#2563eb', boxShadow: '0 0 0 1px #2563eb' },
  '.cm-live-fm .fmhint': { marginTop: '8px', fontSize: '11px', color: '#94a3b8' },
  '.cm-live-math': { textAlign: 'center', padding: '6px 0', cursor: 'pointer', overflowX: 'auto', overflowY: 'hidden', fontSize: '1.05em' },
  '.cm-live-math .math-block': { display: 'block' },
  '.cm-live-imath': { cursor: 'pointer' },
  '.cm-live-code': { background: '#f8fafc', fontFamily: MONO, fontSize: '13px', borderLeft: '1px solid #e2e8f0', borderRight: '1px solid #e2e8f0', paddingLeft: '14px !important', paddingRight: '14px !important' },
  '.cm-live-code-first': { borderTop: '1px solid #e2e8f0', borderTopLeftRadius: '6px', borderTopRightRadius: '6px', paddingTop: '3px' },
  '.cm-live-code-last': { borderBottom: '1px solid #e2e8f0', borderBottomLeftRadius: '6px', borderBottomRightRadius: '6px', paddingBottom: '3px' },
  '.cm-live-fence': { color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.06em', lineHeight: '1.3' },
  '.cm-live-quote': { borderLeft: '3px solid #cbd5e1', paddingLeft: '10px !important', color: '#475569' },
  '.cm-live-img': { position: 'relative', display: 'inline-block', lineHeight: '0', verticalAlign: 'bottom', maxWidth: '100%', cursor: 'pointer' },
  '.cm-live-img img': { maxWidth: '100%', height: 'auto', borderRadius: '2px' },
  '.cm-live-img img.img-missing': { background: '#fef2f2', border: '1px dashed #f87171', color: '#b91c1c', font: '12px system-ui', lineHeight: '1.4', padding: '6px 10px', minWidth: '80px', minHeight: '24px' },
  '.cm-live-img.sel img': { outline: '2px solid #2563eb', outlineOffset: '1px' },
  '.cm-live-handle': { display: 'none', position: 'absolute', right: '-6px', bottom: '-6px', width: '12px', height: '12px', background: '#2563eb', border: '2px solid #fff', borderRadius: '3px', boxShadow: '0 0 0 1px #2563eb', cursor: 'nwse-resize', touchAction: 'none' },
  '.cm-live-img.sel .cm-live-handle': { display: 'block' },
  '.cm-live-img[data-tip]::after': { content: 'attr(data-tip)', position: 'absolute', right: '14px', bottom: '14px', background: '#0f172a', color: '#fff', font: '11px system-ui', lineHeight: '1.4', padding: '2px 6px', borderRadius: '4px', whiteSpace: 'nowrap' },

  '.cm-live-table': { position: 'relative', margin: '6px 0 6px 8px', padding: '0 22px 30px 0', fontFamily: 'ui-sans-serif, system-ui, "Segoe UI", sans-serif', fontSize: '13.5px', lineHeight: '1.4' },
  '.cm-live-tscroll': { overflowX: 'auto' },
  '.cm-live-table table': { borderCollapse: 'collapse', minWidth: '40%', maxWidth: '100%' },
  '.cm-live-table th, .cm-live-table td': { border: '1px solid #cbd5e1', padding: '5px 9px', verticalAlign: 'top', minWidth: '3em', cursor: 'text', textAlign: 'left' },
  '.cm-live-table th': { background: '#f1f5f9', fontWeight: '700' },
  '.cm-live-table td:empty::before, .cm-live-table th:empty::before': { content: '"\\00a0"' },
  '.cm-live-table td:focus, .cm-live-table th:focus': { outline: '2px solid #2563eb', outlineOffset: '-2px' },
  '.cm-live-table td.editing, .cm-live-table th.editing': { padding: '0', background: '#eff6ff' },
  '.cm-live-table input.cm-cell-in': { width: '100%', minWidth: '8em', boxSizing: 'border-box', border: '0', background: 'transparent', font: 'inherit', fontWeight: 'inherit', padding: '5px 9px', outline: '2px solid #2563eb', outlineOffset: '-2px' },
  '.cm-live-table .cellcb': { cursor: 'pointer', accentColor: '#2563eb' },
  '.cm-live-table code': { background: '#f1f5f9', borderRadius: '3px', padding: '0 3px', fontFamily: 'ui-monospace, Consolas, monospace' },
  '.cm-live-tbar': { position: 'absolute', left: '0', bottom: '2px', display: 'flex', flexWrap: 'wrap', gap: '2px', visibility: 'hidden' },
  '.cm-live-table:hover .cm-live-tbar, .cm-live-table:focus-within .cm-live-tbar': { visibility: 'visible' },
  '.cm-live-tbar button': { height: '22px', padding: '0 7px', border: '1px solid #cbd5e1', borderRadius: '4px', background: '#fff', color: '#334155', font: '12px system-ui', cursor: 'pointer' },
  '.cm-live-tbar button:hover': { background: '#e2e8f0' },
});
