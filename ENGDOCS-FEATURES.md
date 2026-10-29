# EngDocs: features, tips and tricks

Everything below is something the current build (app v27, VS Code extension 0.1.5) does. Items marked **limit** are things it does not do.

## 1. Getting someone to review a document

**There is no built-in comment or review feature.** There is no way to attach a comment to a line, reply to it, or mark it resolved. What works today:

| Option | How | Catch |
|---|---|---|
| Hidden notes | Write `<!-- Alex: check the 0.5 m/s value -->` in the Markdown. | Hidden from the preview and the PDF, so the reviewer must open the `.md` source. Easy to miss. |
| Visible review notes | Put notes in the text as `> **Review (Alex, 2026-10-29):** …`, then delete them once resolved. | They print in the PDF if you forget to remove them. |
| Status and watermark | Set `status: FOR REVIEW`. Drafts and for-review documents print with a watermark and the status in the footer. | Tells readers the state; it does not collect comments. |
| Mark up the PDF | Export the PDF and have the reviewer comment in a PDF reader (Acrobat, Edge, Preview). | Comments live in the PDF, not the source. You then edit by hand. |
| Git review | Keep the folder in a Git repository (GitHub, Azure DevOps). A reviewer can comment on lines of the `.md` in a pull request. | Needs Git. Comments are on the Markdown source, not the rendered page. |

If you want a proper review feature (reviewer name, comment text, resolved/unresolved, shown in the margin in the preview and listed or stripped on export), that is a build job. Tell me if you want it.

## 2. The app

* **Works offline.** It installs as an app (PWA), and all libraries are bundled. Nothing is sent anywhere.
* **Your files stay on your computer.** Open a folder and the app reads and writes `.md` files in it directly (browser File System Access). Chrome and Edge on desktop, and Chrome on recent Android, support this. Safari and Firefox do not support it.
* **Notes kept in the browser.** *New note (kept in this browser)* works without a folder. Back these up; clearing site data deletes them.
* **Templates.** *New document…* offers Engineering document, Daily priority, Personal note and Blank note. Put your own `.md` templates in a `_templates` folder and they appear in the list. *Save as template* needs an open folder.
* **Controlled document or note.** A file with any controlled field (`doc_number`, `status`, `revisions`, `author`, `approver`, `compliance`, `classification`) is a controlled document: cover page, automatic heading numbers, revision history. A file without those is a note.
* **Properties.** The *Choose which fields* button lets you add or remove header fields without typing YAML. The status field is a drop-down.
* **Header checks.** Problems in the header (bad date, unquoted revision, unknown status, repeated revision, same author and approver on an approved document) are flagged. They warn; they do not block.
* **Tabs and split view.** Several documents in tabs. *Split* shows two side by side; Shift+click a tab to send it to the other pane.
* **Editing modes.** Raw Markdown, a live "visual" mode, and a preview. A formatting bar covers bold, italic, strikethrough, code, headings, lists, task lists, quotes, links, tables (grid picker), table alignment, equations, code blocks and images. The editor also shows a "Type / for commands" hint; I have not tested that command menu in this session, so check it yourself.
* **Shortcuts.** Ctrl+B bold, Ctrl+I italic, Ctrl+E inline code, Ctrl+K link, Ctrl+Alt+1 to 4 paragraph style, Alt+Z word wrap. In visual mode, Ctrl+click opens a link.
* **Tables.** Edit visually in the preview, add or remove rows, align the pipes in the source.
* **Images.** Insert from the toolbar, drag in, or paste. They are saved as files beside your document. *Store embedded images as files* (File menu) moves older embedded images to `assets/`. Set a width with `![alt|420px](path)`.
* **Code.** Syntax colours for Python, C, C++/Arduino and IEC 61131-3 Structured Text (`st`). Every block gets line numbers and a Copy button.
* **Equations.** LaTeX with KaTeX: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`.
* **Links.** Links to other `.md` files open them in the app. Rename or move a file and links to it from other files are rewritten (you are shown what will change first).
* **Other files.** PDFs, Word (.docx) files and images open in a viewer.
* **Search** across the folder.
* **Themes.** Light and dark.

## 3. Page layout and PDF

* **Export to PDF** from the app uses the browser's print dialog (choose *Save as PDF*, and untick the browser's own headers and footers). The paper size comes from Page setup (A4 by default).
* **Cover page**, **revision history** and **contents** are built from the header. Show or hide them, and rename the cover label, in *Page setup*.
* **Headers and footers** have six positions and use `{doc_number}`, `{title}`, `{status}`, `{classification}`, `{date}`, `{rev}`, `{today}`, `{page}`, `{pages}`.
* **Page setup** has four tabs: **Page** (paper size A3, A4, A5, B5, Letter, Legal, Tabloid or custom; portrait or landscape; margins), **Header & footer**, **Cover & contents**, and **New documents** (author and classification defaults). When you save to a document, only the settings you changed are written into its frontmatter. Font size, rule lines and the watermark are in Header & footer. A mirrored layout for double-sided printing and different first, odd and even pages are set in the frontmatter (see the layout guide).
* **Landscape sections.** `## Heading {.landscape}` prints that section on a landscape page. Mixed orientations in one PDF are supported.
* **Page breaks and keep-together.** `<!-- pagebreak -->`, and `<!-- keep -->` … `<!-- /keep -->`. Option `break_before_h1: true` starts every top-level heading on a new page.
* **Captions and cross-references.** `Table: Title {#id}` and `Figure: Title {#id}` number themselves; `[](#id)` links to them. Optional lists of tables and figures (`pg_lot`, `pg_lof`).
* **Footnotes** (`[^1]`) print as notes at the end of the document. **limit**
* **References and abbreviations** are lists in the header, added automatically at the end.
* **Fields and conditions.** `{{title}}`, `{{author.name}}` and `{{if status == DRAFT}}…{{endif}}` in the body. Good for templates.
* **Includes.** `{{include: part.md}}` pulls another file in.
* **Column widths** from the dashes in a table's separator row (`table_widths: dashes`).
* **Check before export** (File menu, and automatic before exporting): missing images, includes, cross-references and header fields, tables or code wider than the page, and skipped heading levels.

## 4. The VS Code extension

* **Export controlled PDF** from a Markdown file in VS Code. It runs the same app code in a hidden Chrome or Edge, so the PDF matches the app's.
* **Page numbers in the contents and lists** (the extension prints twice to find them). The web app's print dialog cannot do this. **limit**
* Includes are read from disk; the same checks run and are listed in the **EngDocs** output panel.
* Header problems show in VS Code's Problems list. The required fields come from the `engdocs.requiredFields` setting.
* Needs Chrome or Edge installed (or set `engdocs.browserPath`).

## 5. Tips and tricks

1. **Write the header first.** Get `doc_number`, `status`, `author`, `approver` and the first revision right, then write content.
2. **Never number headings yourself.** The contents page and cross-references rely on the automatic numbers.
3. **Quote your revisions.** `rev: "1.0"`, not `rev: 1.0`.
4. **Keep portrait tables to six columns or fewer.** For more, use a landscape section. *Check before export* tells you which table overflows and by how many millimetres.
5. **Give long URLs or part numbers their own cells.** The app only breaks a cell mid-word for tokens of about 26 characters or more.
6. **Use ids on anything you refer to.** `Table: … {#id}` plus `[](#id)` means the numbers stay right when you add a table earlier in the document.
7. **Use `<!-- pagebreak -->` sparingly.** Headings already stay with their following text.
8. **Template your standard documents.** Build one good document with `{{fields}}` and conditions, save it in `_templates`, and start new documents from it.
9. **Use the extension for the controlled copy.** It is the only route with page numbers in the contents.
10. **Back up the folder.** Files are plain Markdown, so a synced folder (OneDrive) or a Git repository works.
11. **Ask any AI to write documents with the instruction sheet.** Paste `ENGDOCS-AI-INSTRUCTIONS.md` first, then your request. Run *Check before export* on whatever it returns.
12. **Never let an AI set `APPROVED` or `RELEASED`.** Those are a person's decision.

## 6. Known limits

* No comments or review workflow (see section 1).
* Not supported in Markdown: `==highlight==`, sub/superscript with `~` or `^`, GitHub-style alerts (`> [!NOTE]`), definition lists, Mermaid diagrams.
* Contents page numbers only from the VS Code extension. Footnotes print at the end of the document.
* Long lines in code blocks are cut at the page edge. Wide tables are not rescaled.
* Includes are not expanded in the live editor preview, only in print and PDF.
* Tested on Linux with Chromium only. Not tested on Windows or Android.
