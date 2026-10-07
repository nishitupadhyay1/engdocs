/* EngDocs editor bundle – CodeMirror 6 with Markdown + YAML frontmatter, slash commands, formatting
   shortcuts, table/URL paste handling, image drop/paste hooks, and folding of embedded base64 images.
   Built with esbuild into vendor/codemirror.bundle.js (global: window.EngEditor). */
import { EditorState, EditorSelection, Compartment, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, snippetCompletion } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';

/* ---------- YAML frontmatter as its own block, so "---" is not read as a rule / setext heading ---------- */
export const Frontmatter = {
  defineNodes: [{ name: 'Frontmatter', block: true, style: t.meta }],
  parseBlock: [{
    name: 'Frontmatter',
    before: 'HorizontalRule',
    parse(cx, line) {
      if (cx.lineStart !== 0 || !/^---[ \t]*$/.test(line.text)) return false;
      const head = cx.input.read(0, Math.min(cx.input.length, 60000));
      const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?=\r?\n|$)/.exec(head);
      if (!m) return false;
      const end = m[0].length;
      do { if (!cx.nextLine()) break; } while (cx.lineStart < end);
      cx.addElement(cx.elt('Frontmatter', 0, end));
      return true;
    },
  }],
};

/* ---------- Highlighting ---------- */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const mdStyle = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700', fontSize: '1.35em', color: '#0f172a' },
  { tag: t.heading2, fontWeight: '700', fontSize: '1.2em', color: '#0f172a' },
  { tag: t.heading3, fontWeight: '700', fontSize: '1.1em', color: '#0f172a' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700', color: '#334155' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: '#2563eb' },
  { tag: t.monospace, color: '#9a3412', fontFamily: MONO },
  { tag: t.quote, color: '#475569' },
  { tag: t.processingInstruction, color: '#94a3b8' },
  { tag: t.contentSeparator, color: '#94a3b8' },
  { tag: t.meta, color: '#7c3aed' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: '#fff', color: '#0f172a' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: MONO, fontSize: '13.5px', lineHeight: '1.65', overflow: 'auto' },
  '.cm-content': { padding: '14px 4px 120px', caretColor: '#0f172a' },
  '.cm-line': { padding: '0 14px 0 8px' },
  '.cm-gutters': { backgroundColor: '#f8fafc', border: 'none', color: '#94a3b8' },
  '.cm-activeLine': { backgroundColor: '#f1f5f980' },
  '.cm-activeLineGutter': { backgroundColor: '#e2e8f0', color: '#334155' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#bfdbfe !important' },
  '.cm-imgdata': { background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: '4px', padding: '0 6px', fontSize: '12px', fontFamily: 'system-ui, sans-serif' },
  '.cm-tooltip.cm-tooltip-autocomplete': { border: '1px solid #cbd5e1', borderRadius: '8px', boxShadow: '0 8px 24px rgba(15,23,42,.18)', overflow: 'hidden' },
  '.cm-tooltip-autocomplete ul li': { padding: '3px 10px !important', fontFamily: 'system-ui, sans-serif' },
  '.cm-completionDetail': { color: '#64748b', marginLeft: '10px', fontStyle: 'normal' },
});

/* ---------- Fold embedded base64 images into a small chip ---------- */
const DATA_RE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{200,}/g;
class ImgChip extends WidgetType {
  constructor(label) { super(); this.label = label; }
  eq(o) { return o.label === this.label; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-imgdata'; s.textContent = this.label; s.title = 'Embedded image data (folded). Use File → Move embedded images to assets/ to store as files.'; return s; }
  ignoreEvent() { return false; }
}
function chips(view) {
  const out = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    DATA_RE.lastIndex = 0;
    let m;
    while ((m = DATA_RE.exec(text))) {
      const kb = Math.max(1, Math.round((m[0].length * 0.75) / 1024));
      out.push(Decoration.replace({ widget: new ImgChip(`🖼 image data · ${kb} KB`) }).range(from + m.index, from + m.index + m[0].length));
    }
  }
  return Decoration.set(out, true);
}
const imgFold = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = chips(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = chips(u.view); }
}, { decorations: (v) => v.decorations, provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.decorations ?? Decoration.none) });

/* ---------- Pasting tables ---------- */
export function tableToMarkdown(html, text) {
  let rows = null;
  if (html && /<table[\s>]/i.test(html)) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    rows = [...doc.querySelectorAll('tr')].map((r) => [...r.children].filter((c) => /^t[dh]$/i.test(c.tagName)).map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
  } else if (text && text.includes('\t') && text.includes('\n')) {
    rows = text.replace(/\r/g, '').replace(/\n+$/, '').split('\n').map((l) => l.split('\t').map((s) => s.trim()));
  }
  if (!rows || !rows.length) return null;
  const cols = Math.max(...rows.map((r) => r.length));
  if (cols < 2) return null;
  const line = (r) => { const a = r.map((s) => s.replace(/\|/g, '\\|')); while (a.length < cols) a.push(''); return '| ' + a.join(' | ') + ' |'; };
  return [line(rows[0]), '| ' + Array(cols).fill('---').join(' | ') + ' |', ...rows.slice(1).map(line)].join('\n') + '\n';
}

/* ---------- Formatting commands ---------- */
function toggleWrap(view, mark, ph = 'text') {
  const st = view.state;
  view.dispatch(st.changeByRange((r) => {
    const before = st.sliceDoc(Math.max(0, r.from - mark.length), r.from), after = st.sliceDoc(r.to, r.to + mark.length);
    if (before === mark && after === mark) {
      return { changes: [{ from: r.from - mark.length, to: r.from }, { from: r.to, to: r.to + mark.length }], range: EditorSelection.range(r.from - mark.length, r.to - mark.length) };
    }
    const txt = r.empty ? ph : st.sliceDoc(r.from, r.to);
    return { changes: { from: r.from, to: r.to, insert: mark + txt + mark }, range: EditorSelection.range(r.from + mark.length, r.from + mark.length + txt.length) };
  }), { scrollIntoView: true, userEvent: 'input' });
  view.focus();
  return true;
}
function selectedLines(view) {
  const st = view.state, out = [], seen = new Set();
  for (const r of st.selection.ranges) {
    for (let p = r.from; p <= r.to;) {
      const ln = st.doc.lineAt(p);
      if (!seen.has(ln.number)) { seen.add(ln.number); out.push(ln); }
      p = ln.to + 1;
    }
  }
  return out;
}
function setHeading(view, level) {
  const changes = [];
  for (const ln of selectedLines(view)) {
    const m = /^(#{1,6})\s+/.exec(ln.text);
    const same = m && m[1].length === level;
    changes.push({ from: ln.from, to: ln.from + (m ? m[0].length : 0), insert: same ? '' : '#'.repeat(level) + ' ' });
  }
  view.dispatch({ changes, userEvent: 'input' }); view.focus(); return true;
}
function toggleLinePrefix(view, kind) {
  const lines = selectedLines(view), changes = [];
  const re = { bullet: /^(\s*)[-*+]\s(?!\[[ xX]\])/, number: /^(\s*)\d+\.\s/, task: /^(\s*)[-*+]\s\[[ xX]\]\s/, quote: /^(\s*)>\s?/ }[kind];
  const allHave = lines.every((l) => re.test(l.text));
  lines.forEach((ln, i) => {
    const m = re.exec(ln.text);
    const prefix = { bullet: '- ', number: `${i + 1}. `, task: '- [ ] ', quote: '> ' }[kind];
    if (allHave && m) changes.push({ from: ln.from + m[1].length, to: ln.from + m[0].length, insert: '' });
    else if (!allHave) {
      const stripped = /^(\s*)(?:[-*+]\s\[[ xX]\]\s|[-*+]\s|\d+\.\s|>\s?)/.exec(ln.text);
      const indent = (stripped ? stripped[1] : /^\s*/.exec(ln.text)[0]);
      const cut = stripped ? stripped[0].length : indent.length;
      changes.push({ from: ln.from + indent.length, to: ln.from + cut, insert: prefix });
    }
  });
  view.dispatch({ changes, userEvent: 'input' }); view.focus(); return true;
}
function insertLink(view) {
  const st = view.state;
  view.dispatch(st.changeByRange((r) => {
    const txt = r.empty ? 'link text' : st.sliceDoc(r.from, r.to);
    const ins = `[${txt}](url)`;
    const urlFrom = r.from + txt.length + 3;
    return { changes: { from: r.from, to: r.to, insert: ins }, range: EditorSelection.range(urlFrom, urlFrom + 3) };
  }), { scrollIntoView: true, userEvent: 'input' });
  view.focus(); return true;
}

/* ---------- Slash commands (type "/" at line start or after a space) ---------- */
export function makeSlash(onCommand) {
  const S = (tpl, label, detail) => snippetCompletion(tpl, { label, detail, type: 'keyword', boost: 0 });
  const options = [
    S('# ${}', '/h1', 'Heading 1'), S('## ${}', '/h2', 'Heading 2'), S('### ${}', '/h3', 'Heading 3'), S('#### ${}', '/h4', 'Heading 4'),
    S('$${1:E = mc^2}$', '/eq', 'Inline equation'),
    S('$$\n${1:\\frac{a}{b}}\n$$\n', '/math', 'Display equation'),
    S('| ${1:Column A} | ${2:Column B} | ${3:Column C} |\n| --- | --- | --- |\n| ${} |  |  |\n|  |  |  |\n', '/table', 'Table 3 × 3'),
    S('```st\n${}\n```\n', '/st', 'Structured Text (PLC) block'),
    S('```cpp\n${}\n```\n', '/cpp', 'C / C++ block'),
    S('```python\n${}\n```\n', '/py', 'Python block'),
    S('```\n${}\n```\n', '/code', 'Code block'),
    S('> **Note:** ${}\n', '/note', 'Note callout'),
    S('> **⚠ Warning:** ${}\n', '/warning', 'Warning callout'),
    S('> **⛔ Caution:** ${}\n', '/caution', 'Caution callout'),
    S('- [ ] ${}\n- [ ] \n- [ ] \n', '/task', 'Task list'),
    S('![${1:Caption}|450px](${2:assets/figure.webp})\n', '/fig', 'Image by path'),
    S('[${1:text}](${2:https://})', '/link', 'Link'),
    S('\n---\n', '/hr', 'Horizontal rule'),
    { label: '/image', detail: 'Insert image from file…', type: 'keyword', apply(view, c, from, to) { view.dispatch({ changes: { from, to, insert: '' } }); onCommand && onCommand('image'); } },
  ];
  return (ctx) => {
    const m = ctx.matchBefore(/(?:^|\s)\/[\w-]*/);
    if (!m) return null;
    const from = m.from + (m.text.startsWith('/') ? 0 : 1);
    return { from, options, validFor: /^\/[\w-]*$/ };
  };
}

/* ---------- Public factory ---------- */
export function createEditor(parent, opts = {}) {
  const ro = new Compartment(), wrap = new Compartment();
  let readOnly = !!opts.readOnly, wrapping = opts.wrap !== false;
  const hasFiles = (e) => [...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file');
  const imgFiles = (list) => [...(list || [])].filter((f) => f.type && f.type.startsWith('image/'));

  const buildState = (doc) => EditorState.create({
    doc,
    extensions: [
      lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(),
      history(), indentOnInput(), bracketMatching(), highlightSelectionMatches(),
      closeBrackets(),
      EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['(', '[', '{', '`'] } }]),
      markdown({ base: markdownLanguage, extensions: [Frontmatter] }),
      syntaxHighlighting(mdStyle),
      autocompletion({ override: [makeSlash(opts.onCommand)], icons: false, defaultKeymap: true }),
      imgFold, theme,
      ro.of(EditorState.readOnly.of(readOnly)),
      wrap.of(wrapping ? EditorView.lineWrapping : []),
      Prec.highest(keymap.of([
        { key: 'Mod-b', run: (v) => toggleWrap(v, '**', 'bold text') },
        { key: 'Mod-i', run: (v) => toggleWrap(v, '*', 'italic text') },
        { key: 'Mod-e', run: (v) => toggleWrap(v, '`', 'code') },
        { key: 'Mod-k', run: insertLink },
        { key: 'Mod-Alt-1', run: (v) => setHeading(v, 1) }, { key: 'Mod-Alt-2', run: (v) => setHeading(v, 2) },
        { key: 'Mod-Alt-3', run: (v) => setHeading(v, 3) }, { key: 'Mod-Alt-4', run: (v) => setHeading(v, 4) },
        { key: 'Alt-z', run: () => { api.setWrap(!wrapping); return true; } },
      ])),
      keymap.of([...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap]),
      EditorView.domEventHandlers({
        paste(e, view) {
          if (view.state.readOnly) return false;
          const cd = e.clipboardData; if (!cd) return false;
          const files = imgFiles([...cd.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()));
          if (files.length) { e.preventDefault(); opts.onImageFiles && opts.onImageFiles(files); return true; }
          const text = cd.getData('text/plain');
          const md = tableToMarkdown(cd.getData('text/html'), text);
          if (md) { e.preventDefault(); view.dispatch(view.state.replaceSelection(md), { scrollIntoView: true, userEvent: 'input.paste' }); return true; }
          const sel = view.state.selection.main;
          if (!sel.empty && /^https?:\/\/\S+$/.test(text.trim())) {
            e.preventDefault();
            const label = view.state.sliceDoc(sel.from, sel.to);
            view.dispatch({ changes: { from: sel.from, to: sel.to, insert: `[${label}](${text.trim()})` }, userEvent: 'input.paste' });
            return true;
          }
          return false;
        },
        dragover(e) { if (hasFiles(e)) { e.preventDefault(); return true; } return false; },
        drop(e, view) {
          if (view.state.readOnly) return false;
          const files = imgFiles(e.dataTransfer?.files);
          if (!files.length) return false;
          e.preventDefault(); opts.onImageFiles && opts.onImageFiles(files); return true;
        },
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) opts.onChange && opts.onChange();
        if (u.docChanged || u.selectionSet) opts.onSelection && opts.onSelection(api.cursor());
      }),
    ],
  });

  const view = new EditorView({ state: buildState(opts.doc || ''), parent });
  view.scrollDOM.addEventListener('scroll', () => opts.onScroll && opts.onScroll(), { passive: true });

  const api = {
    view,
    getValue: () => view.state.doc.toString(),
    /* Replace the document and reset undo history (used when switching files). */
    setValue(text) { view.setState(buildState(text)); opts.onSelection && opts.onSelection(api.cursor()); },
    /* Replace the document as ONE undoable change, touching only the part that differs. */
    replaceAll(text) {
      const old = view.state.doc.toString();
      if (old === text) return;
      const max = Math.min(old.length, text.length);
      let a = 0; while (a < max && old.charCodeAt(a) === text.charCodeAt(a)) a++;
      let b = 0; while (b < max - a && old.charCodeAt(old.length - 1 - b) === text.charCodeAt(text.length - 1 - b)) b++;
      view.dispatch({ changes: { from: a, to: old.length - b, insert: text.slice(a, text.length - b) }, userEvent: 'input' });
    },
    /* Insert text; a § marker (if present) is removed and the caret placed there. */
    insertTemplate(text) {
      const i = text.indexOf('§'), clean = text.replace('§', ''), r = view.state.selection.main;
      view.dispatch({ changes: { from: r.from, to: r.to, insert: clean }, selection: { anchor: r.from + (i < 0 ? clean.length : i) }, scrollIntoView: true, userEvent: 'input' });
      view.focus();
    },
    insertText(text) { view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: 'input' }); view.focus(); },
    setReadOnly(v) { readOnly = !!v; view.dispatch({ effects: ro.reconfigure(EditorState.readOnly.of(readOnly)) }); },
    setWrap(v) { wrapping = !!v; view.dispatch({ effects: wrap.reconfigure(wrapping ? EditorView.lineWrapping : []) }); opts.onWrap && opts.onWrap(wrapping); },
    isWrapping: () => wrapping,
    focus: () => view.focus(),
    cursor() { const h = view.state.selection.main.head, ln = view.state.doc.lineAt(h); return { line: ln.number, col: h - ln.from + 1, lines: view.state.doc.lines }; },
    topLine() { const b = view.lineBlockAtHeight(view.scrollDOM.scrollTop); return view.state.doc.lineAt(b.from).number; },
    gotoLine(n) { const ln = view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines))); view.dispatch({ selection: { anchor: ln.from }, effects: EditorView.scrollIntoView(ln.from, { y: 'start', yMargin: 24 }) }); },
    /* formatting */
    bold: () => toggleWrap(view, '**', 'bold text'), italic: () => toggleWrap(view, '*', 'italic text'), code: () => toggleWrap(view, '`', 'code'),
    strike: () => toggleWrap(view, '~~', 'text'), link: () => insertLink(view),
    heading: (n) => setHeading(view, n),
    bullet: () => toggleLinePrefix(view, 'bullet'), number: () => toggleLinePrefix(view, 'number'), task: () => toggleLinePrefix(view, 'task'), quote: () => toggleLinePrefix(view, 'quote'),
  };
  return api;
}
