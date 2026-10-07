// Builds /tmp/claude-0/engdocs/vendor from npm packages. Run: node build.mjs
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/tmp/claude-0/engdocs/vendor';
const NM = 'node_modules';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'fonts'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'src'), { recursive: true });

// 1. CodeMirror bundle (IIFE → window.EngEditor)
await build({
  entryPoints: ['cm-entry.js'], bundle: true, minify: true, format: 'iife', globalName: 'EngEditor',
  target: 'es2020', outfile: path.join(OUT, 'codemirror.bundle.js'), legalComments: 'none', logLevel: 'info',
});

// 2. Plain copies
const copy = (from, to) => fs.copyFileSync(path.join(NM, from), path.join(OUT, to));
copy('marked/marked.min.js', 'marked.min.js');
copy('dompurify/dist/purify.min.js', 'purify.min.js');
copy('js-yaml/dist/js-yaml.min.js', 'js-yaml.min.js');
copy('katex/dist/katex.min.js', 'katex.min.js');
for (const f of ['prism-core', 'prism-clike', 'prism-c', 'prism-cpp', 'prism-python']) copy(`prismjs/components/${f}.min.js`, `${f}.min.js`);
copy('prismjs/themes/prism.min.css', 'prism.min.css');

// 3. KaTeX: woff2 only (every browser we target supports it); strip the woff/ttf fallbacks from the CSS
for (const f of fs.readdirSync(path.join(NM, 'katex/dist/fonts'))) if (f.endsWith('.woff2')) copy(`katex/dist/fonts/${f}`, `fonts/${f}`);
let css = fs.readFileSync(path.join(NM, 'katex/dist/katex.min.css'), 'utf8');
css = css.replace(/,url\(fonts\/[^)]+\.woff\) format\("woff"\)/g, '').replace(/,url\(fonts\/[^)]+\.ttf\) format\("truetype"\)/g, '');
fs.writeFileSync(path.join(OUT, 'katex.min.css'), css);

fs.writeFileSync(path.join(OUT, 'prism-pre.js'), 'window.Prism = { manual: true, disableWorkerMessageHandler: true };\n');

// 4. Source + provenance
fs.copyFileSync('cm-entry.js', path.join(OUT, 'src/cm-entry.js'));
fs.copyFileSync('build.mjs', path.join(OUT, 'src/build.mjs'));
const ver = (p) => JSON.parse(fs.readFileSync(path.join(NM, p, 'package.json'), 'utf8')).version;
fs.writeFileSync(path.join(OUT, 'README.txt'), `Vendored libraries (no CDN needed at runtime)
marked ${ver('marked')} | katex ${ver('katex')} | prismjs ${ver('prismjs')} | js-yaml ${ver('js-yaml')} | dompurify ${ver('dompurify')}
codemirror.bundle.js is built from src/cm-entry.js with esbuild (CodeMirror 6, @lezer/markdown ${ver('@lezer/markdown')}).
To rebuild: npm i esbuild @codemirror/{state,view,commands,language,lang-markdown,search,autocomplete} @lezer/{highlight,markdown}; node src/build.mjs
(The app itself needs no build step – these files are served as-is.)
`);
console.log(fs.readdirSync(OUT));
