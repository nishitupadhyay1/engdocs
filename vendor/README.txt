Vendored libraries (no CDN needed at runtime)
marked 12.0.2 | katex 0.16.9 | prismjs 1.29.0 | js-yaml 4.1.0 | dompurify 3.2.6
codemirror.bundle.js is built from src/cm-entry.js with esbuild (CodeMirror 6, @lezer/markdown 1.8.0).
To rebuild: npm i esbuild @codemirror/{state,view,commands,language,lang-markdown,search,autocomplete} @lezer/{highlight,markdown}; node src/build.mjs
(The app itself needs no build step – these files are served as-is.)
mammoth 1.x (BSD-2) | pdf.js 6.4.299 legacy build (Apache-2.0): pdf.min.mjs + pdf.worker.min.mjs, loaded only when a PDF is opened
