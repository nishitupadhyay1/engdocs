'use strict';
/* View-only renderers for files that are not Markdown: Word (.docx), PDF, and Google Drive shortcuts (.gdoc/.gsheet/.gslides).
   The heavy libraries (mammoth, pdf.js) are loaded the first time one of these files is opened, not at start-up.
   Functions here use helpers from app.js ($, esc, sanitize) at call time. */

const vwScripts = {};
function vwLoadScript(src) {
  if (!vwScripts[src]) vwScripts[src] = new Promise((ok, fail) => {
    const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => { delete vwScripts[src]; fail(new Error('Could not load ' + src)); };
    document.head.appendChild(s);
  });
  return vwScripts[src];
}
let vwPdfjs = null;
function vwLoadPdfjs() {
  if (!vwPdfjs) vwPdfjs = import('./vendor/pdf.min.mjs').then((m) => { m.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', document.baseURI).href; return m; }).catch((e) => { vwPdfjs = null; throw e; });
  return vwPdfjs;
}
async function vwBytes(t) { return (await t.handle.getFile()).arrayBuffer(); }
const vwNote = (msg) => `<div class="vw-note">${msg}</div>`;

/* ---------- Word ---------- */
async function vwDocx(t, host, live) {
  host.innerHTML = '<div class="ref-empty">Reading Word document…</div>';
  await vwLoadScript('./vendor/mammoth.browser.min.js');
  if (t.viewHtml === undefined || t.viewHtml === null) {
    const r = await mammoth.convertToHtml({ arrayBuffer: await vwBytes(t) });
    t.viewHtml = sanitize(r.value); t.viewMsgs = r.messages.filter((m) => m.type === 'warning').length;
  }
  if (!live()) return;
  host.innerHTML = `<div class="page doc docview">${t.viewHtml || '<p><em>This document has no text content.</em></p>'}</div>` +
    vwNote('Simplified view of the text, tables and pictures. Headers, footers, text boxes, columns, comments and exact page layout are not shown' + (t.viewMsgs ? ` (${t.viewMsgs} item${t.viewMsgs > 1 ? 's' : ''} could not be converted)` : '') + '. Open the file in Word for the exact layout.');
}

/* ---------- PDF ---------- */
async function vwPdf(t, host, live) {
  host.innerHTML = '<div class="ref-empty">Reading PDF…</div>';
  const pdfjs = await vwLoadPdfjs();
  if (host._pdf) { try { host._pdf.destroy(); } catch (e) { /* already gone */ } host._pdf = null; }
  if (host._pdfCleanup) { host._pdfCleanup(); host._pdfCleanup = null; }
  let pdf;
  try { pdf = await pdfjs.getDocument({ data: await vwBytes(t), isEvalSupported: false }).promise; }
  catch (e) {
    if (!live()) return;
    host.innerHTML = '<div class="ref-empty">' + (e && e.name === 'PasswordException' ? 'This PDF is password-protected, so it cannot be shown here.' : 'Could not open this PDF: ' + esc(e && e.message || String(e))) + '</div>';
    return;
  }
  if (!live()) { pdf.destroy(); return; }
  host._pdf = pdf;
  const n = pdf.numPages, first = await pdf.getPage(1), base = first.getViewport({ scale: 1 });
  host.innerHTML = `<div class="pdfbar"><span class="pdfpg">Page <b>1</b> of ${n}</span><span class="sp"></span><button type="button" data-z="out" title="Zoom out" aria-label="Zoom out">−</button><button type="button" data-z="fit" title="Fit to width">Fit</button><button type="button" data-z="in" title="Zoom in" aria-label="Zoom in">+</button></div><div class="pdfpages"></div>`;
  const pages = host.querySelector('.pdfpages'), bar = host.querySelector('.pdfbar'), pgNo = bar.querySelector('b');
  let gen = 0, io = null;
  const scaleNow = () => (t.zoom ? t.zoom : Math.min(2.5, Math.max(0.4, (host.clientWidth - 40) / base.width)));
  const build = () => {
    const my = ++gen; if (io) io.disconnect();
    const sc = scaleNow(), dpr = window.devicePixelRatio || 1;
    pages.innerHTML = '';
    io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting && !en.target._done) { en.target._done = true; draw(en.target, my); } }), { root: host, rootMargin: '700px 0px' });
    for (let i = 1; i <= n; i++) {
      const w = document.createElement('div'); w.className = 'pdfpage'; w.dataset.n = i;
      w.style.width = Math.round(base.width * sc) + 'px'; w.style.height = Math.round(base.height * sc) + 'px';
      pages.appendChild(w); io.observe(w);
    }
    async function draw(w, mine) {
      try {
        const page = await pdf.getPage(+w.dataset.n); if (mine !== gen) return;
        const vp = page.getViewport({ scale: sc });
        w.style.width = Math.round(vp.width) + 'px'; w.style.height = Math.round(vp.height) + 'px';
        const cv = document.createElement('canvas'); cv.width = Math.floor(vp.width * dpr); cv.height = Math.floor(vp.height * dpr);
        cv.style.width = Math.round(vp.width) + 'px'; cv.style.height = Math.round(vp.height) + 'px';
        w.appendChild(cv);
        await page.render({ canvasContext: cv.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
        if (mine !== gen) return;
        const tl = document.createElement('div'); tl.className = 'textLayer'; tl.style.setProperty('--total-scale-factor', String(vp.scale)); w.appendChild(tl);
        await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp }).render();
      } catch (e) { if (e && e.name !== 'RenderingCancelledException') console.warn('PDF page', w.dataset.n, e); }
    }
  };
  build();
  const onScroll = () => {
    const top = host.getBoundingClientRect().top + bar.offsetHeight + 8;
    for (const w of pages.children) { if (w.getBoundingClientRect().bottom > top) { pgNo.textContent = w.dataset.n; break; } }
  };
  host.addEventListener('scroll', onScroll, { passive: true });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const cur = scaleNow();
    if (b.dataset.z === 'fit') t.zoom = null; else t.zoom = Math.min(4, Math.max(0.25, cur * (b.dataset.z === 'in' ? 1.25 : 0.8)));
    build();
  });
  let rt = 0, lastW = host.clientWidth;
  const ro = new ResizeObserver(() => { if (t.zoom || Math.abs(host.clientWidth - lastW) < 24) return; lastW = host.clientWidth; clearTimeout(rt); rt = setTimeout(build, 200); });
  ro.observe(host);
  host._pdfCleanup = () => { ro.disconnect(); if (io) io.disconnect(); host.removeEventListener('scroll', onScroll); gen++; };
}

/* ---------- Google Drive shortcuts ---------- */
const VW_G_KIND = { gdoc: ['Google Doc', 'document'], gsheet: ['Google Sheet', 'spreadsheets'], gslides: ['Google Slides', 'presentation'] };
function vwGoogleUrl(name, j) {
  const ext = (name.match(/\.([a-z]+)$/i) || [])[1] || 'gdoc';
  if (j && typeof j.url === 'string' && /^https:\/\/(docs|drive|sheets|slides)\.google\.com\//.test(j.url)) return j.url;
  const id = j && (j.doc_id || j.resource_id);
  if (typeof id === 'string' && /^[\w-]{10,}$/.test(id)) return `https://docs.google.com/${(VW_G_KIND[ext.toLowerCase()] || VW_G_KIND.gdoc)[1]}/d/${id}/edit`;
  return null;
}
async function vwGoogle(t, host, live) {
  let j = null;
  try { j = JSON.parse(await (await t.handle.getFile()).text()); } catch (e) { /* not JSON */ }
  if (!live()) return;
  const ext = ((t.path || '').match(/\.([a-z]+)$/i) || [])[1] || 'gdoc', label = (VW_G_KIND[ext.toLowerCase()] || VW_G_KIND.gdoc)[0], url = vwGoogleUrl(t.path || '', j);
  host.innerHTML = `<div class="page doc"><div class="vw-card"><h2>${esc(label)} shortcut</h2>
    <p>This file is only a link to a document stored in Google Drive. Its content is not on your computer, so it cannot be shown or searched here, and it needs an internet connection to open.</p>
    ${url ? `<p><button type="button" class="btn2" data-gopen="${esc(url)}">Open in Google Drive ↗</button></p>` : '<p><em>This shortcut file has no usable link in it.</em></p>'}
    <p class="vw-small">To read or edit this content in EngDocs, export it from Google (File → Download → Markdown, Word or PDF) into the folder.</p></div></div>`;
}

/* ---------- entry point ---------- */
async function renderViewer(t, host) {
  const tok = (host._vt = {}), live = () => host._vt === tok;
  if (host._pdfCleanup && t.kind !== 'pdf') { host._pdfCleanup(); host._pdfCleanup = null; }
  try {
    if (t.kind === 'docx') await vwDocx(t, host, live);
    else if (t.kind === 'pdf') await vwPdf(t, host, live);
    else if (t.kind === 'gdoc') await vwGoogle(t, host, live);
  } catch (e) {
    console.error(e); if (live()) host.innerHTML = '<div class="ref-empty">Could not display this file: ' + esc(e.message || String(e)) + '</div>';
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-gopen]'); if (!b) return;
  const u = b.dataset.gopen; if (/^https:\/\/(docs|drive|sheets|slides)\.google\.com\//.test(u)) window.open(u, '_blank', 'noopener,noreferrer');
});
