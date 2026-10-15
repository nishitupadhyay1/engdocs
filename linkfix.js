'use strict';
/* Link re-writing for rename / move.
   LF.plan({ files: [{ path, text }], mapPath }) works out which relative links, image paths and HTML src/href values need to change
   when something is renamed or moved. `path` is each file's CURRENT path; mapPath(p) gives where any path will be AFTER the move.
   A link is rewritten only when its target moves or the file that contains it moves, so untouched links stay byte-for-byte the same.
   Links inside code blocks, inline code and the frontmatter are never touched. Pure functions: no DOM, no file access. */
const LF = (() => {
  const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/|\\|#)/i;
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

  function resolve(baseDir, rel) {            // 'a/b' + '../c.md' -> 'a/c.md'; null if it climbs above the folder root
    const parts = baseDir ? baseDir.split('/') : [];
    for (const seg of rel.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
    }
    return parts.join('/');
  }
  function relPath(fromDir, to) {
    const a = fromDir ? fromDir.split('/') : [], b = to ? to.split('/') : [];
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return '../'.repeat(a.length - i) + b.slice(i).join('/');
  }
  const encSeg = (s) => s.replace(/[%\s()<>#?"\\]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));

  function mask(text) {                       // same length; code and frontmatter blanked so link patterns cannot match inside them
    const blank = (s) => s.replace(/[^\n]/g, ' ');
    let out = '', i = 0;
    const lines = text.split('\n');
    let fence = null, pos = 0;
    const fm = /^---[ \t]*\r?\n[\s\S]*?\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/.exec(text);
    const fmEnd = fm ? fm[0].length : 0;
    for (const line of lines) {
      const end = pos + line.length + 1;
      let keep = line;
      if (pos < fmEnd) keep = blank(line);
      else if (fence) { keep = blank(line); const m = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/.exec(line); if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null; }
      else { const m = /^ {0,3}(`{3,}|~{3,})/.exec(line); if (m) { fence = m[1]; keep = blank(line); } }
      out += keep + (end <= text.length ? '\n' : ''); pos = end;
    }
    return out.replace(/(`+)([^`][\s\S]*?[^`]|[^`])\1(?!`)/g, (m) => blank(m));
  }

  function candidates(masked) {               // [{ start, end }] of every destination that could be a file path
    const found = new Map();
    const add = (start, end) => { if (end > start) found.set(start, end); };
    let m; const inline = /(!?\[(?:[^\[\]\\\n]|\\.|\[[^\[\]\n]*\])*\]\()([ \t]*)(<[^<>\n]*>|(?:[^\s()\\]|\\.|\([^\s()]*\))*)/g;
    while ((m = inline.exec(masked))) { const s = m.index + m[1].length + m[2].length; add(s, s + m[3].length); inline.lastIndex = m.index + 1; }
    const ref = /^( {0,3}\[[^\]\n]+\]:[ \t]*)(<[^<>\n]*>|\S+)/gm;
    while ((m = ref.exec(masked))) { const s = m.index + m[1].length; add(s, s + m[2].length); }
    const html = /(\b(?:src|href)\s*=\s*)(?:"([^"\n]*)"|'([^'\n]*)')/gi;
    while ((m = html.exec(masked))) { const v = m[2] !== undefined ? m[2] : m[3], s = m.index + m[1].length + 1; add(s, s + v.length); }
    return [...found].map(([start, end]) => ({ start, end })).sort((a, b) => a.start - b.start);
  }

  function fixOne(raw, oldDir, newDir, mapPath) {   // returns the replacement text, or null to leave the link alone
    const angle = raw.startsWith('<') && raw.endsWith('>'), inner = angle ? raw.slice(1, -1) : raw;
    const cut = inner.search(/[#?]/), pathPart = cut < 0 ? inner : inner.slice(0, cut), suffix = cut < 0 ? '' : inner.slice(cut);
    if (!pathPart || EXTERNAL.test(pathPart) || pathPart.includes('\\')) return null;
    let dec; try { dec = pathPart.split('/').map(decodeURIComponent); } catch (e) { return null; }
    const target = resolve(oldDir, dec.join('/')); if (target === null) return null;
    const moved = mapPath(target);
    if (moved === target && oldDir === newDir) return null;
    let rel = relPath(newDir, moved);
    const dirLink = /\/$/.test(pathPart);
    if (rel === '') rel = '.';
    if (rel === dec.filter((x) => x && x !== '.').join('/')) return null;   // already points at the right place
    if (/^\.\//.test(pathPart) && !/^\.\.\//.test(rel) && rel !== '.') rel = './' + rel;
    if (dirLink && !rel.endsWith('/')) rel += '/';
    const out = angle ? '<' + rel.replace(/[<>]/g, (c) => (c === '<' ? '%3C' : '%3E')) + suffix + '>' : rel.split('/').map(encSeg).join('/') + suffix;
    return out === raw ? null : out;
  }

  function plan({ files, mapPath }) {
    const result = [];
    for (const f of files) {
      const oldDir = dirOf(f.path), newDir = dirOf(mapPath(f.path)), text = f.text;
      const cands = candidates(mask(text)), changes = [];
      for (const c of cands) {
        const raw = text.slice(c.start, c.end), rep = fixOne(raw, oldDir, newDir, mapPath);
        if (rep !== null && rep !== raw) changes.push({ start: c.start, end: c.end, from: raw, to: rep, line: text.slice(0, c.start).split('\n').length });
      }
      if (!changes.length) continue;
      let t = text; for (let i = changes.length - 1; i >= 0; i--) t = t.slice(0, changes[i].start) + changes[i].to + t.slice(changes[i].end);
      result.push({ path: f.path, newText: t, changes });
    }
    return result;
  }
  return { plan, resolve, relPath, mask };
})();
if (typeof module !== 'undefined') module.exports = LF;
