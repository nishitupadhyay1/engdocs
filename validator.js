'use strict';
/* Frontmatter parsing and validation, shared by the EngDocs web app and the VS Code extension so a document is judged identically in both.
   Pure functions: no DOM and no file access. In the browser it needs the global `jsyaml`; elsewhere call EngValidate.setYaml(require('js-yaml')). */
const EngValidate = (() => {
  const STATUSES = ['DRAFT', 'PRELIMINARY', 'FOR REVIEW', 'APPROVED', 'RELEASED', 'OBSOLETE'];
  const CONTROLLED = ['doc_number', 'status', 'revisions', 'author', 'approver', 'compliance', 'classification'];
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  let yaml = typeof jsyaml !== 'undefined' ? jsyaml : null;
  const setYaml = (y) => { yaml = y; };

  function isRealDate(s) {                       // YYYY-MM-DD that exists on the calendar (rejects 2026-02-30)
    if (!ISO.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number), t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }
  function splitFrontmatter(text) {
    const m = text.match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    if (!m) return { yamlText: null, body: text };
    return { yamlText: m[1], body: text.slice(m[0].length) };
  }
  const present = (m, k) => Object.prototype.hasOwnProperty.call(m, k) && m[k] !== null && m[k] !== undefined && m[k] !== '';
  const nm = (o) => (o && typeof o === 'object' && typeof o.name === 'string' ? o.name.trim().toLowerCase() : '');

  /* Returns [{ msg, path }]. `path` names the field ('status', 'revisions.1.date') so an editor can underline the right line.
     opts.required = field names that must be present (empty by default, which matches the web app). */
  function check(m, opts = {}) {
    const w = [], add = (msg, path, required) => w.push(required ? { msg, path, required: true } : { msg, path });
    if (!m || typeof m !== 'object' || Array.isArray(m)) return [{ msg: 'Frontmatter is missing or is not a YAML mapping.', path: '' }];
    for (const k of opts.required || []) if (!present(m, k)) add(`"${k}" is required for controlled documents here, but it is missing or empty.`, k, true);
    for (const k of ['doc_number', 'title']) if (k in m && present(m, k) && typeof m[k] !== 'string') add(`"${k}" should be text.`, k);
    if (present(m, 'date')) {
      const d = String(m.date);
      if (!ISO.test(d)) add('"date" must be YYYY-MM-DD.', 'date');
      else if (!isRealDate(d)) add(`"date" (${d}) is not a real calendar date.`, 'date');
    }
    if (present(m, 'status') && !STATUSES.includes(m.status)) add(`"status" must be one of: ${STATUSES.join(', ')}.`, 'status');
    for (const k of ['author', 'approver']) {
      if (!present(m, k)) continue;
      const o = m[k];
      if (!o || typeof o !== 'object' || Array.isArray(o) || !o.name) add(`"${k}" needs a "name" (and normally a "title").`, k);
    }
    if (present(m, 'compliance') && !Array.isArray(m.compliance)) add('"compliance" must be a list of standards.', 'compliance');
    if ('revisions' in m && m.revisions !== null && m.revisions !== undefined) {
      if (!Array.isArray(m.revisions) || !m.revisions.length) add('"revisions" must be a non-empty list.', 'revisions');
      else {
        const seen = new Map(); let prev = null;
        m.revisions.forEach((r, i) => {
          const p = `revisions.${i}`;
          if (!r || typeof r !== 'object') return add(`revisions[${i}] is not an object.`, p);
          if (r.rev === undefined || r.rev === null || r.rev === '') add(`revisions[${i}].rev is missing.`, p + '.rev');
          else if (typeof r.rev !== 'string') add(`revisions[${i}].rev should be quoted (e.g. "1.0"); unquoted 1.0 is read as the number 1.`, p + '.rev');
          else {
            const key = r.rev.trim().toLowerCase();
            if (seen.has(key)) add(`revisions[${i}].rev "${r.rev}" repeats revisions[${seen.get(key)}].`, p + '.rev'); else seen.set(key, i);
          }
          const ds = String(r.date || '');
          if (!ISO.test(ds)) add(`revisions[${i}].date must be YYYY-MM-DD.`, p + '.date');
          else if (!isRealDate(ds)) add(`revisions[${i}].date (${ds}) is not a real calendar date.`, p + '.date');
          else { if (prev && ds < prev) add(`revisions[${i}].date (${ds}) is earlier than the previous revision (${prev}).`, p + '.date'); prev = ds; }
          for (const k of ['author', 'approver', 'description']) if (!r[k]) add(`revisions[${i}].${k} is missing.`, p + '.' + k);
        });
      }
    }
    // Light guardrails: consistency checks that warn but never block
    const last = Array.isArray(m.revisions) && m.revisions.length ? m.revisions[m.revisions.length - 1] : null;
    if (['APPROVED', 'RELEASED'].includes(m.status) && nm(m.author) && nm(m.author) === nm(m.approver)) add(`Status is ${m.status} but the author and approver are the same person (${m.author.name}).`, 'approver');
    if (last && typeof last === 'object') {
      const li = m.revisions.length - 1;
      const chk = (label, top, rv) => { if (nm(top) && typeof rv === 'string' && rv.trim() && rv.trim().toLowerCase() !== nm(top)) add(`The active revision's ${label} ("${rv}") differs from the document ${label} ("${top.name}").`, `revisions.${li}.${label}`); };
      chk('author', m.author, last.author); chk('approver', m.approver, last.approver);
    }
    return w;
  }
  const validateMeta = (m, opts) => check(m, opts).map((x) => x.msg);

  /* Returns { meta (normalised or null), warnings[], issues[{msg,path}], body, note?, yamlError? } */
  function parseDoc(text, opts = {}) {
    const { yamlText, body } = splitFrontmatter(text);
    if (yamlText === null) return { meta: null, warnings: [], issues: [], note: true, body };   // plain note: no frontmatter, no issues
    let meta;
    try {
      // CORE_SCHEMA keeps YYYY-MM-DD as a string instead of a Date object
      meta = yaml.load(yamlText, { schema: yaml.CORE_SCHEMA });
    } catch (e) {
      const msg = 'YAML error: ' + (e.reason || e.message);
      return { meta: null, warnings: [msg], issues: [{ msg, path: '', line: e.mark ? e.mark.line : 0 }], body, yamlError: true };
    }
    if (meta === null || meta === undefined || (typeof meta === 'object' && !Array.isArray(meta) && !CONTROLLED.some((k) => k in meta))) {
      const m = meta || {}, issues = [];
      if ('title' in m && typeof m.title !== 'string') issues.push({ msg: '"title" should be text.', path: 'title' });
      if ('date' in m) { m.date = String(m.date); if (!ISO.test(m.date)) issues.push({ msg: '"date" should be YYYY-MM-DD.', path: 'date' }); }
      return { meta: m, warnings: issues.map((x) => x.msg), issues, note: true, body };
    }
    const issues = check(meta, opts);
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      if (Array.isArray(meta.revisions)) meta.revisions = meta.revisions.filter((r) => r && typeof r === 'object').map((r) => ({ ...r, rev: String(r.rev ?? ''), date: String(r.date ?? '') }));
      meta.date = String(meta.date ?? '');
      return { meta, warnings: issues.map((x) => x.msg), issues, body };
    }
    return { meta: null, warnings: issues.map((x) => x.msg), issues, body };
  }
  const activeRev = (meta) => (meta && Array.isArray(meta.revisions) && meta.revisions.length ? meta.revisions[meta.revisions.length - 1] : null);

  /* Finds the 0-based line (within the whole file) of a field path such as 'status' or 'revisions.1.date', for editor squiggles. */
  function lineOf(text, path) {
    const { yamlText } = splitFrontmatter(text); if (yamlText === null) return 0;
    const start = text.indexOf(yamlText), base = text.slice(0, start).split('\n').length - 1, lines = yamlText.split('\n');
    if (!path) return base;
    const segs = path.split('.');
    let from = 0, indent = -1, found = base;
    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s];
      if (/^\d+$/.test(seg)) {                         // n-th "- " item at the next indent level
        let n = -1, itemIndent = -1;
        for (let i = from; i < lines.length; i++) {
          const mm = /^(\s*)-(\s|$)/.exec(lines[i]); if (!mm) { if (/^\S/.test(lines[i]) && i > from) break; continue; }
          if (itemIndent < 0) itemIndent = mm[1].length;
          if (mm[1].length === itemIndent && ++n === +seg) { from = i; found = base + i; indent = itemIndent; break; }
        }
        if (n < +seg) return found;
        if (s + 1 < segs.length) {                      // the key may share the dash line ("- rev: A")
          const rest = lines[from].replace(/^(\s*)-\s?/, '$1  ');
          if (new RegExp('^\\s*' + segs[s + 1] + '\\s*:').test(rest)) { found = base + from; s++; }
        }
      } else {
        const re = new RegExp('^(\\s*)(?:-\\s+)?' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:');
        let hit = false;
        for (let i = from; i < lines.length; i++) {
          const mm = re.exec(lines[i]);
          if (mm && (indent < 0 || mm[1].length > indent || s === 0)) { from = i; found = base + i; indent = mm[1].length; hit = true; break; }
        }
        if (!hit) return found;
      }
    }
    return found;
  }
  return { STATUSES, CONTROLLED, setYaml, isRealDate, splitFrontmatter, check, validateMeta, parseDoc, activeRev, lineOf };
})();
if (typeof module !== 'undefined') module.exports = EngValidate;
