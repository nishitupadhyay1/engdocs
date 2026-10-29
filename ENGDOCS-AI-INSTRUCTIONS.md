# Instructions for any AI: writing documents for EngDocs

Paste this whole file into the chat (Claude, Gemini, ChatGPT or any other assistant) before asking for a document.
Then ask for the document you want. The assistant should reply with **one Markdown file and nothing else**, ready to save as `something.md`.

---

## 0. The task

You are writing a Markdown file for **EngDocs**, a document manager that turns Markdown plus a YAML header into a controlled engineering PDF
(cover page, revision history, contents list, headers and footers, watermark for drafts).
The YAML header at the top of the file controls the document settings. The Markdown below it is the content.
Do not invent a new syntax. Use only what is listed here.

### Output rules

1. Return **only the contents of the .md file**, in a single fenced code block using four backticks (so inner code fences survive). No commentary before or after unless you need to ask a question.
2. Start the file with the YAML header between two lines containing only `---`.
3. Use Australian English spelling and ISO dates (`YYYY-MM-DD`) unless told otherwise.
4. Do not make up facts, standards clauses, part numbers, measurements, names or dates. If something is not supplied, write `TBC` in the text and list it in a final section called `Open Items`.
5. Do not include a "Table of Contents", cover page, revision history table or page numbers in the body. EngDocs builds those from the YAML header.
6. Do not repeat the document title as a heading at the top of the body. The title comes from the header.

---

## 1. The YAML header

### Controlled document (the normal case)

```yaml
---
doc_number: DOC-ENG-2026-014
title: Exhaust Fan Speed Control – Design Note
date: 2026-10-29
status: DRAFT
classification: Company Confidential
author:
  name: Nishit Upadhyay
  title: Senior Product Development Engineer
approver:
  name: Alex Example
  title: Engineering Manager
compliance:
  - ISO 9001:2015
  - AS/NZS 2243.8
revisions:
  - rev: "A"
    date: 2026-10-29
    author: N. Upadhyay
    approver: A. Example
    ecn: ECN-0412
    description: Initial draft issued for internal review.
---
```

Rules (EngDocs checks these and warns when they are broken):

| Field | Rule |
|---|---|
| `doc_number`, `title` | Text. |
| `date` | `YYYY-MM-DD`, a real calendar date. |
| `status` | Exactly one of: `DRAFT`, `PRELIMINARY`, `FOR REVIEW`, `APPROVED`, `RELEASED`, `OBSOLETE` (capitals). A new document is `DRAFT`. Never set `APPROVED` or `RELEASED` yourself; a person decides that. |
| `author`, `approver` | Each is a block with `name` and `title`. |
| `compliance` | A **list** of standards. Only list standards the user named. |
| `classification` | Text, for example `Company Confidential`. |
| `revisions` | A non-empty list, oldest first, dates not going backwards. Every entry needs `rev`, `date`, `author`, `approver`, `description`; `ecn` is optional. |
| `rev` | **Always in quotes**: `"A"`, `"1.0"`. An unquoted `1.0` is read as the number 1. Revisions must not repeat. |
| Approver | Must not be the same person as the author when the status is `APPROVED` or `RELEASED`. |

A file is treated as a **controlled document** if its header contains at least one of: `doc_number`, `status`, `revisions`, `author`, `approver`, `compliance`, `classification`.
Otherwise it is treated as a **note** (no cover page, no automatic heading numbers). For a note, a header of just `title` and `date` is enough, or no header at all.

### Optional header settings (`page_setup`)

Only add what the user asked for. Do not change the paper size or orientation unless asked; the default is A4 portrait.

```yaml
page_setup:
  size: A4                       # A3, A4, A5, B5, Letter, Legal, Tabloid, or custom millimetres such as 150x200 (default A4)
  orientation: landscape         # whole document; default is portrait
  margin_top: 24                 # millimetres, 5 to 50 (also margin_right, margin_bottom, margin_left)
  break_before_h1: true          # each top-level heading starts a new page
  pg_lot: true                   # list of tables after the contents
  pg_lof: true                   # list of figures after the contents
  table_widths: dashes           # dashes in the table separator row set column widths
  landscape_sections: ['Cable schedule']   # headings (by exact text) that print on landscape pages
  portrait_sections: ['Appendix B']
  header_left: '{doc_number}  ·  {title}'  # also header_centre, header_right, footer_left, footer_centre, footer_right
  footer_right: 'Page {page} of {pages}'
```

Header and footer text can use `{doc_number}`, `{title}`, `{status}`, `{classification}`, `{date}`, `{rev}`, `{today}`, `{page}`, `{pages}`.
Single braces here. Do not change header/footer text unless asked; the defaults are correct.

### Optional reference lists (top level, not inside `page_setup`)

```yaml
references:
  - AS/NZS 3000:2018 Wiring Rules
  - id: iec60034
    text: IEC 60034-1 Rotating electrical machines
abbreviations:
  VSD: Variable speed drive
  MCC: Motor control centre
```

These are added automatically at the end as **References** and **Abbreviations**. Do not also write those sections by hand.

---

## 2. The body

### Headings

* Use `#` for main sections, `##` for subsections, `###` and `####` below that.
* **Do not number headings yourself.** EngDocs numbers levels 1 to 4 automatically (`1.0`, `1.1`, `1.1.1`). Write `# Scope`, not `# 1. Scope`.
* Do not skip levels (no `#` followed directly by `###`).
* Keep heading text short and unique. The contents page is built from them.

### Text

* Plain paragraphs, `**bold**`, `*italic*`, `` `inline code` ``, `~~strikethrough~~`, links `[text](https://…)`, bullet lists (`-`), numbered lists (`1.`), task lists (`- [ ]` and `- [x]`), and blockquotes (`>`).
* A callout is just a blockquote with a bold label: `> **Note:** text`, `> **Warning:** text`.
* A page break: put `<!-- pagebreak -->` on its own line.
* Keep a block together on one page: wrap it in `<!-- keep -->` and `<!-- /keep -->` lines.

### Tables

Standard pipe tables with a header row:

```markdown
| Item | Description | Qty |
|---|---|---|
| 1 | Contactor | 2 |
```

* Keep tables to **about six columns or fewer** for a portrait page. Wider tables get cut off. If more columns are essential, put the section on a landscape page (see §3).
* Alignment with colons in the separator row works: `|:---|:---:|---:|`.
* Never put a blank line inside a table. Keep each cell on one line. Use `<br>` for a line break inside a cell.
* A checkbox cell is `[ ]` or `[x]` on its own.
* Optional column widths: set `table_widths: dashes` in the header, then the number of dashes sets the relative width (`|--|------------|-|`). Every column needs at least one dash.

### Code

Fenced blocks with a language tag. Highlighting exists for `python` (`py`), `c`, `cpp` (`c++`, `arduino`), and IEC 61131-3 Structured Text (`st`, `iecst`, `scl`, `plc`). Other languages still print, without colours.

````markdown
```st
IF Start AND NOT Fault THEN
    Run := TRUE;
END_IF
```
````

Do not use very long lines in code (over about 90 characters). They are cut off at the page edge.

### Equations

Use LaTeX: inline `$Q = A \cdot v$`, display blocks:

```markdown
$$
\sigma = \frac{M\,y}{I}
$$
```

Also supported: `\( … \)` and `\[ … \]`. Write units with `\text{m/s}`. Keep each equation correct; do not invent formulas.

### Images

```markdown
![System schematic|420px](images/schematic.png)
```

* The text before `|` is the alt text. `|420px` (or `|60%`) is the optional width.
* The path is relative to the Markdown file. Only use image files the user has said exist. Otherwise write a placeholder line such as `> **Figure to be supplied:** wiring schematic` and add it to `Open Items`.
* Never invent image paths.

### Captions, numbering and cross-references

```markdown
Table: Fan duty points {#duty}

| Point | Flow | Pressure |
|---|---|---|
| A | 1.2 | 300 |

![Fan curve](images/curve.png)
Figure: Measured fan curve {#curve}

As shown in [](#duty) and [](#curve), …
```

* A caption line starts with `Table:` or `Figure:` and sits directly above a table, or directly below an image, with the id in `{#id}`.
* Numbers are automatic: **Table 1**, **Figure 1**. Do not type the number.
* `[](#id)` (empty link text) prints the number, such as "Table 1". The same works for headings with an id (`## Method {#method}`), which print as "Section 2.1".
* Ids use letters, digits, `-`, `_`. Each id must be unique.
* A reference to an id that does not exist prints `??`. Check every `[](#…)` has a matching id.

### Footnotes

```markdown
The motor is rated for continuous duty.[^1]

[^1]: Rating from the manufacturer's data sheet, rev C.
```

Footnotes print as a list at the **end of the document**.

### Fields and conditions

Header fields can be used in the text: `{{title}}`, `{{doc_number}}`, `{{author.name}}`, `{{rev}}`, `{{rev_date}}`, `{{today}}`, `{{year}}`.
To show the braces literally, write `\{{like this}}`.

```markdown
{{if status == DRAFT}}
> **DRAFT.** Not for construction.
{{else}}
Approved for issue.
{{endif}}
```

Tests: `name`, `not name`, `name == value`, `name != value`, joined with `and` / `or`.
Use these only if the user asks for reusable template behaviour. Otherwise write plain text.

### Including other files

`{{include: sections/scope.md}}` on a line by itself inserts another Markdown file. Only use this if the user has told you the file exists.

### Landscape sections

Add `{.landscape}` to a heading to print that section (until the next heading of the same or higher level) on a landscape page: `## Cable schedule {.landscape}`. Use `{.portrait}` to go back. Use it for wide tables.

### Notes to the reviewer

`<!-- text -->` is a hidden comment. It does **not** appear in the preview or the PDF, so a reader only sees it in the Markdown source.
Use it sparingly for notes to the next editor. Anything the reader of the PDF must see belongs in the visible text.

---

## 3. What is NOT supported (do not use)

* `==highlight==`, `H~2~O` / `x^2^` sub- and superscript (`~2~` renders as strikethrough; write `H₂O`, `x²`, or use LaTeX `$x^2$`).
* GitHub alerts (`> [!NOTE]`). Use `> **Note:**`.
* Definition lists (`Term` newline `: definition`). Use a two-column table.
* Mermaid, PlantUML or other diagram code blocks. Describe the diagram, or give an image path the user supplied, or ask for the image.
* Manually typed contents pages, page numbers, heading numbers, "Page x of y".
* Page numbers in the contents list are produced only by the VS Code extension export, not by the web app print dialog. Do not write them by hand.
* `<script>`, `<iframe>`, forms and other active HTML (removed for safety). Plain inline HTML such as `<br>` or `<span>` is fine but avoid it.

---

## 4. Quality checklist (run this before replying)

1. The header is valid YAML, starts and ends with `---`, and `rev` values are quoted.
2. `status` is one of the six allowed values, in capitals, and is `DRAFT` for anything new.
3. Dates are real `YYYY-MM-DD` dates and revisions are in date order.
4. Nothing is invented: every figure, standard, name, image and file path came from the user. Gaps are marked `TBC` and listed under `Open Items`.
5. Headings are not numbered by hand and do not skip levels.
6. Every `[](#id)` has a matching `{#id}`, and ids are unique.
7. Every table has a header row and a separator row, and fits a portrait page (about six columns), or sits in a `{.landscape}` section.
8. Every code fence has a language tag and is closed.
9. No unsupported syntax from §3.
10. The reply is only the file, in one four-backtick code block.

---

## 5. Minimal skeleton

````markdown
---
doc_number: DOC-ENG-2026-000
title: Replace With Title
date: 2026-10-29
status: DRAFT
classification: Company Confidential
author:
  name: Author Name
  title: Engineer
approver:
  name: Approver Name
  title: Engineering Manager
compliance:
  - ISO 9001:2015
revisions:
  - rev: "A"
    date: 2026-10-29
    author: Author Name
    approver: Approver Name
    description: Initial draft for review.
---

# Purpose and Scope

State what the document covers and why.

# Design Basis

## Requirements

| ID | Requirement | Source |
|---|---|---|
| R1 | Requirement text | Client brief |

Table: Design inputs {#inputs}

| Input | Value | Unit |
|---|---|---|
| Face velocity | 0.5 | m/s |

The inputs in [](#inputs) are TBC with the client.

# Open Items

- [ ] Confirm the design inputs with the client.
````
