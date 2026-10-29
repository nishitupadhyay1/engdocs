'use strict';
/* Document features that sit on top of Markdown, shared logic for the EngDocs renderer (captions, cross-references, footnotes, table widths).
   Nothing here needs a new language: it recognises a few plain-text conventions.

     Table: Load cases {#loads}      caption line directly above (or below) a table      -> "Table 3 - Load cases"
     Figure: Fan curve {#curve}      caption line directly below (or above) an image     -> "Figure 2 - Fan curve"
     ## Heading {#id}  ## Wide {.landscape}   a custom id and/or class on a heading
     [](#loads)                      a cross-reference; the text is filled in ("Table 3", "Section 2.1", "[4]")
     text[^1]  and  [^1]: note       footnotes (printed as notes at the end of the document)

   Pure functions apart from the `inst` (a marked instance) that the renderer passes in. */
const EngRich = (() => {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const L = typeof EngLayout !== 'undefined' ? EngLayout : require('./layout.js');
  const ID = '[A-Za-z0-9_][\\w:.\\-]*';

  /* "Title {#id .landscape}" -> { text: 'Title', id, classes } */
  function parseAttrs(s) {
    const m = new RegExp(`\\s*\\{((?:\\s*[#.]${ID})+)\\s*\\}\\s*$`).exec(String(s));
    if (!m) return { text: String(s), id: null, classes: [] };
    let id = null; const classes = [];
    for (const a of m[1].trim().split(/\s+/)) { if (a[0] === '#') id = id || a.slice(1); else classes.push(a.slice(1)); }
    return { text: String(s).slice(0, m.index), id, classes };
  }

  /* ---------- footnotes ---------- */
  function extractFootnotes(text) {
    const m = L.mask(text), defs = new Map();
    const s = m.text.replace(/^\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n(?:[ \t]{2,}|\t)[^\n]*)*)\n?/gm, (all, id, body) => { if (!defs.has(id)) defs.set(id, body.replace(/\n[ \t]+/g, ' ').trim()); return ''; });
    return { text: m.restore(s), defs };
  }

  /* ---------- tables, figures, captions (token level) ---------- */
  const isSpace = (t) => t && t.type === 'space';
  const capOf = (t, kind) => t && t.type === 'paragraph' && new RegExp(`^${kind}\\s*:\\s*\\S`, 'i').test(t.text) && !/\n/.test(t.text.trim());
  const imageOnly = (t) => t && t.type === 'paragraph' && Array.isArray(t.tokens) && t.tokens.length > 0 && t.tokens.every((x) => x.type === 'image' || (x.type === 'link' && x.tokens && x.tokens.every((y) => y.type === 'image')) || (x.type === 'text' && !x.text.trim()));
  const nearest = (toks, i, dir) => { for (let j = i + dir; j >= 0 && j < toks.length; j += dir) if (!isSpace(toks[j])) return j; return -1; };

  function widthsFrom(tok) {
    const line = String(tok.raw).split('\n')[1] || '';
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => (c.match(/-/g) || []).length);
    const sum = cells.reduce((a, b) => a + b, 0);
    return cells.length === tok.header.length && sum > 0 && cells.every((c) => c > 0) ? cells.map((c) => Math.round((c / sum) * 10000) / 100) : null;
  }

  /* inst: marked instance. o: { tableWidths, anchors (Map, filled here), labels, issues }
     Returns the token list, with captioned/fixed-width tables and captioned figures replaced by 'rtable' / 'rfigure' tokens. */
  function prepare(tokens, inst, o) {
    const labels = Object.assign({ table: 'Table', figure: 'Figure' }, o.labels || {});
    const claimed = new Map(), skip = new Set();           // content token index -> caption paragraph index
    const claim = (kind, isContent, preferAfter) => {
      tokens.forEach((t, i) => {
        if (!capOf(t, kind) || skip.has(i)) return;
        const order = preferAfter ? [1, -1] : [-1, 1];
        for (const d of order) { const j = nearest(tokens, i, d); if (j >= 0 && isContent(tokens[j]) && !claimed.has(j)) { claimed.set(j, i); skip.add(i); return; } }
      });
    };
    claim('Table', (t) => t.type === 'table', true);        // table captions normally sit above the table
    claim('Figure', imageOnly, false);                     // figure captions normally sit below the picture
    // "image line + Figure: line" in one paragraph (no blank line between)
    tokens.forEach((t, i) => {
      if (t.type !== 'paragraph' || claimed.has(i) || skip.has(i)) return;
      const lines = t.raw.replace(/\n+$/, '').split('\n');
      if (lines.length === 2 && /^Figure\s*:\s*\S/i.test(lines[1])) { const img = inst.lexer(lines[0])[0]; if (imageOnly(img)) { tokens[i] = { type: 'paragraph', raw: lines[0], text: lines[0], tokens: img.tokens, _cap: lines[1] }; } }
    });
    const out = [], counters = { table: 0, figure: 0 }, lists = { tables: [], figures: [] };
    tokens.forEach((t, i) => {
      if (skip.has(i)) return;
      const isTbl = t.type === 'table', isFig = imageOnly(t) && (claimed.has(i) || t._cap);
      if (!isTbl && !isFig) { out.push(t); return; }
      const kind = isTbl ? 'table' : 'figure';
      const widths = isTbl && o.tableWidths ? widthsFrom(t) : null;
      const capRaw = claimed.has(i) ? tokens[claimed.get(i)].text : t._cap || null;
      if (!capRaw && !widths) { out.push(t); return; }
      const tok = { type: isTbl ? 'rtable' : 'rfigure', raw: t.raw, inner: t, widths };
      if (capRaw) {
        const a = parseAttrs(capRaw.replace(new RegExp(`^${isTbl ? 'Table' : 'Figure'}\\s*:\\s*`, 'i'), '').trim());
        const n = ++counters[kind];
        tok.n = n; tok.label = `${labels[kind]} ${n}`; tok.id = a.id; tok.capHtml = a.text ? inst.parseInline(a.text) : ''; tok.capText = a.text;
        if (a.id) {
          if (o.anchors.has(a.id)) o.issues.push({ type: 'id', msg: `The id "${a.id}" is used more than once` });
          o.anchors.set(a.id, { label: tok.label, kind });
        }
        lists[isTbl ? 'tables' : 'figures'].push({ n, id: a.id, label: tok.label, html: tok.capHtml });
      }
      out.push(tok);
    });
    return { tokens: out, lists };
  }

  /* marked extensions that draw the tokens made by prepare(); o.prefix keeps ids unique when a page shows the same document twice */
  function extensions(o) {
    const cap = (t) => {
      return `<figcaption><span class="cap-n">${esc(t.label)}</span>${t.capHtml ? `<span class="cap-t"> – ${t.capHtml}</span>` : ''}</figcaption>`;
    };
    return [
      { name: 'rtable', renderer(t) {
        let h = this.parser.parse([t.inner]);
        if (t.widths) h = h.replace('<table>', `<table class="fixed"><colgroup>${t.widths.map((w) => `<col style="width:${w}%">`).join('')}</colgroup>`);
        if (!t.label) return h;
        return `<figure class="cap-tbl"${t.id ? ` id="${o.prefix}${esc(t.id)}"` : ''}>${cap(t)}${h}</figure>\n`;
      } },
      { name: 'rfigure', renderer(t) {
        return `<figure class="cap-fig"${t.id ? ` id="${o.prefix}${esc(t.id)}"` : ''}>${this.parser.parse([t.inner])}${cap(t)}</figure>\n`;
      } },
    ];
  }

  /* ---------- html level: references, cross-references, footnotes ---------- */
  const outsideCode = (html, fn) => html.split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/g).map((seg, i) => (i % 2 ? seg : fn(seg))).join('');

  function finish(html, o) {
    const { anchors, prefix, issues, inst } = o;
    // reference list entries -> anchors "[n]"
    let n = 0;
    html = html.replace(/<span class="refid" data-ref="([^"]+)"><\/span>/g, (all, id) => { n++; if (anchors.has(id)) issues.push({ type: 'id', msg: `The id "${id}" is used more than once` }); anchors.set(id, { label: `[${n}]`, kind: 'ref' }); return `<span id="${prefix}${id}"></span>`; });
    // cross-references
    html = html.replace(/<a class="xref" href="#([^"]*)" data-xref="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g, (all, hid, id, rest, inner) => {
      const a = anchors.get(id);
      if (a) return `<a class="xref" href="#${prefix}${id}"${rest}>${inner.trim() ? inner : esc(a.label)}</a>`;
      if (inner.trim()) return `<a href="#${id}"${rest}>${inner}</a>`;                  // explicit text, unknown target: leave as an ordinary link
      issues.push({ type: 'xref', id, msg: `Cross-reference to "${id}" has no target` });
      return `<a class="xref xref-missing" href="#${id}"${rest}>??</a>`;
    });
    // footnotes
    const order = [];
    if (o.footnotes && o.footnotes.size) {
      html = outsideCode(html, (seg) => seg.replace(/\[\^([^\]\s]+)\]/g, (all, id) => {
        if (!o.footnotes.has(id)) return all;
        if (!order.includes(id)) order.push(id);
        return `<sup class="fnref" id="${prefix}fnref-${esc(id)}"><a href="#${prefix}fn-${esc(id)}">${order.indexOf(id) + 1}</a></sup>`;
      }));
      for (const id of o.footnotes.keys()) if (!order.includes(id)) issues.push({ type: 'footnote', msg: `Footnote [^${id}] is never used` });
      if (order.length) html += `<section class="footnotes"><ol>${order.map((id) => `<li id="${prefix}fn-${esc(id)}">${inst.parseInline(o.footnotes.get(id))} <a class="fnback" href="#${prefix}fnref-${esc(id)}">↩</a></li>`).join('')}</ol></section>`;
    }
    return html;
  }

  return { parseAttrs, extractFootnotes, prepare, extensions, finish, widthsFrom };
})();
if (typeof module !== 'undefined') module.exports = EngRich;
