# EngDocs layout guide

Everything here is plain Markdown plus frontmatter. There is no new language to learn.
Settings go in the frontmatter, content goes in the body.

---

## 1. Fields in the text: `{{name}}`

Any frontmatter field can be used in the body.

```
This report, {{doc_number}}, is issued by {{author.name}} ({{author.title}}).
Current revision: {{rev}} dated {{rev_date}}.
```

| Variable | Value |
|---|---|
| `{{title}}`, `{{doc_number}}`, `{{status}}`, `{{date}}`, `{{classification}}` … | the field of that name |
| `{{author.name}}`, `{{approver.title}}` … | a field inside a block |
| `{{rev}}`, `{{rev_date}}` | the latest revision and its date |
| `{{today}}`, `{{year}}` | the date you export |

* A name with no value prints as written and is listed by **Check before export**.
* To show the braces themselves, put a backslash in front: `\{{title}}`.
* Anything inside code blocks or `inline code` is left alone.

## 2. Conditional content

```
{{if status == DRAFT}}
> **DRAFT.** Not for construction.
{{else}}
Approved for issue.
{{endif}}
```

Allowed tests: `name`, `not name`, `name == value`, `name != value`, joined with `and` / `or` (`and` binds tighter).
`{{elif …}}` works. A field counts as false when it is missing, empty, `false`, `no`, `off` or `0`.
Comparisons ignore upper/lower case.

## 3. Including other files

```
{{include: sections/scope.md}}
```

* The line must contain only the include.
* The path is relative to the file that contains it, and `../` works.
* The included file's frontmatter is ignored. Its images and links are adjusted to still work.
* Includes can be nested. Loops are detected.
* **Limit:** includes are expanded for PDF export, the print preview and *Check before export*. The editor's own live preview does not expand them yet.

## 4. Page breaks and keeping things together

```
<!-- pagebreak -->          (or a line containing \newpage)

<!-- keep -->
A heading, its table and the sentence introducing it stay on one page.
<!-- /keep -->
```

Headings are already kept with the text that follows them. A kept block taller than a page will still split.

## 5. Table column widths

Turn on in the frontmatter:

```yaml
page_setup:
  table_widths: dashes
```

Then the number of dashes in the separator row sets the relative width:

```
| Item | Description                           | Qty |
|------|---------------------------------------|-----|
```

Widths are proportions, so only the ratios matter. Every column needs at least one dash. Without `table_widths: dashes`, columns size themselves.

## 6. Captions, automatic numbers and cross-references

```
Table: Fan duty points {#duty}

| Point | Flow | Pressure |
|---|---|---|
| A | 1.2 | 300 |

![Fan curve](curve.png)
Figure: Measured fan curve {#curve}
```

* The caption line sits directly above a table, and directly below an image. A caption on the other side is also accepted.
* Numbers are automatic: *Table 1*, *Figure 1*, … in document order.
* Refer to anything with an id using empty link text: `[](#duty)` prints **Table 1**, `[](#curve)` prints **Figure 1**.
* Headings can have ids too: `## Method {#method}`, then `[](#method)` prints **Section 2.1** (or the heading text when headings are not numbered).
* If you write text in the link, `[see the duty table](#duty)`, your text is used.
* A reference with no matching target prints `??` and is listed by the check.

Lists of tables and figures (after the contents page):

```yaml
page_setup:
  pg_lot: true     # list of tables
  pg_lof: true     # list of figures
```

**Page numbers:** the contents, list of tables and list of figures show page numbers when you export with the **VS Code extension**, which prints twice to find where each heading landed. The web app's own *Export to PDF* (the browser print dialog) cannot do this, so there those lists have no page numbers.

## 7. Footnotes

```
The motor is rated for continuous duty.[^1]

[^1]: Rating from the manufacturer's data sheet, rev C.
```

Footnotes are numbered in order of use and printed as a list of notes at the **end of the document**, not at the foot of each page.
A note that is never used is reported by the check.

## 8. References and abbreviations

Keep them in the frontmatter, once:

```yaml
references:
  - AS/NZS 3000:2018 Wiring Rules
  - id: iec60034
    text: IEC 60034-1 Rotating electrical machines
abbreviations:
  VSD: Variable speed drive
  MCC: Motor control centre
```

* They are added at the end as **References** and **Abbreviations** (abbreviations are sorted).
* To put them somewhere else, write `{{references}}` or `{{abbreviations}}` on a line by itself.
* A reference with an `id` can be cited with `[](#iec60034)`, which prints its number, for example **[2]**.

## 9. Page layout

```yaml
page_setup:
  size: A4                       # A3, A4, A5, B5, Letter, Legal, Tabloid, or custom millimetres such as 150x200
  orientation: landscape        # whole document; default portrait
  margin_top: 24                # millimetres, 5 to 50
  margin_right: 18
  margin_bottom: 22
  margin_left: 18
  break_before_h1: true         # every top-level heading starts a new page
```

### Landscape (or portrait) sections

In the body:

```
## Cable schedule {.landscape}
```

Or by name in the frontmatter:

```yaml
page_setup:
  landscape_sections: ['Cable schedule', 'Load list']
  portrait_sections: ['Appendix B']
```

The section runs until the next heading of the same or higher level. Landscape and portrait pages can be mixed in one PDF, always at the paper size you chose. The cover, revision history and contents pages stay portrait in a landscape document.

All of this is also in **File → Page setup → Page** (paper size, orientation, margins). Settings you do not change in that dialog are not written into the document.

### Different headers and footers

```yaml
page_setup:
  header_left: '{title}'
  footer_right: 'Page {page} of {pages}'
  first:                        # the first page of the PDF
    header_left: ''
  odd:                          # right-hand pages
    header_right: 'Confidential'
  even:                         # left-hand pages
    header_left: 'Confidential'
  mirror: true                  # swap left and right on even pages (double-sided printing)
```

Positions: `header_left`, `header_centre`, `header_right`, `footer_left`, `footer_centre`, `footer_right`.
Only the positions you list in `first`, `odd` or `even` are changed; the rest are inherited.
**Note:** `first` means the first page of the PDF. If the document has a cover page, that is the cover.

## 10. Check before export

**File menu → Check before export…** (it also runs automatically before *Export to PDF*; choose *Export anyway* to continue).

It reports:

* missing images, includes and cross-reference targets
* fields used in the text that have no value
* duplicate ids and unused footnotes
* required frontmatter fields that are missing
* tables and code blocks wider than the page they will print on
* heading levels that skip (for example `#` then `###`)

In VS Code the same checks run during export and are listed in the **EngDocs** output panel; the PDF is still produced.

---

## Known limits

* Page numbers in the contents and lists appear only in PDFs made by the VS Code extension, not in the web app's print dialog. (If the extension has to fall back to its command-line print method, they are also left out.)
* Footnotes print at the end of the document.
* Very long lines in code blocks are not wrapped and are cut at the page edge; the check warns about them.
* Includes are not expanded in the live editor preview.
* A table that is wider than the page is not rescaled. Use fewer columns, set widths, or put it in a landscape section.
