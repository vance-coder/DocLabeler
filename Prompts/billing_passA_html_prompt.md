# Panel voucher layout transcription (HTML)

## 1. Task

Transcribe ONE page image into HTML that keeps its printed layout. You are a transcriber, not an interpreter: copy what is printed, keep every written value in the cell it was written in, and change nothing.

- The image is the authority. Any OCR text supplied with it is a hint only; where they disagree, follow the image.
- Do not classify, translate, normalize, correct or complete anything. Do not add a value that is not written.
- Output only HTML. No explanation, no markdown fence, no CSS, no `style`, `class`, `id`, `data-*`, `<script>`, `<html>`, `<head>` or `<body>`.

## 2. Allowed containers

Use exactly these four elements, nothing else:

| Element | Use it when |
|---|---|
| `<table>` | the area has **printed column headings** (e.g. `Bill on chit`, `Payment by patient`, `Duration / Quantity`) |
| `<dl>` | a label with its own filling area, printed as label + blank space (most AIA and Trinity fields) |
| `<pre>` | a printed paragraph of terms, notes or legal text |
| `<div>` | one visual region with no table and no label, listed top to bottom |

Rules for each:

- `<table>`: `<tr>` per printed row, `<th>` only for a printed heading cell, `<td>` for every other cell. Never invent a heading that is not printed; if a heading cell is blank use `<td></td>`.
- `<dl>`: `<dt>` is the printed label exactly as printed, `<dd>` is the content written in that label's own filling area. One `<dl>` per printed block of fields, labels top to bottom.
- `<pre>`: paragraph text only, line breaks as printed, no markdown.
- `<div>`: one region per `<div>`, content in reading order.

### 2.1 Hard rules for tables

1. **One table = one printed table.** A field area with no printed column heading (e.g. `Patient Name: ___`, `SP-PRE FEE($) ___`) is `<dl>`, never a `<table>`. Do not wrap the whole page in one table.
2. **Column count must match.** Every `<tr>` in a table has exactly the same number of cells as the heading row, counting `colspan`. A row covering several columns writes `colspan="N"` explicitly. Never drop a `<td>` to make a row shorter.
3. **A cell count change starts a new table.** If a sub-block has a different number of columns (e.g. a 2-column dosage table under a 3-column fee table), close the table and open a new `<table>`.
4. **Notes and footnotes belong to the row above.** A printed explanation line attached to a row is a `<tr><td colspan="N">…</td></tr>` inside that table.
5. **Nesting only for a real printed table.** A page-level total printed inside a service table may nest; everything else stays flat.
6. **Rows of one item share one label.** When a printed label owns several following rows that carry no charge of their own (continuation lines of the same service), write the label cell once with `rowspan="N"` covering those rows, and write each continuation line in its own row. The charge stays in the single row where it is printed; the continuation rows leave that cell empty. Never repeat the label on each line, and never output a continuation line as a row with its own label.

## 3. Cell content rules

- **Copy character by character.** This overrides everything else: never shorten, reword, translate, modernise, re-punctuate or "clean up" any text. A Chinese clause printed as `退還之保費` must be written `退還之保費`, not `退保金`. A bullet printed as `-` must not become `•`.
- **Numbers are copied digit by digit.** Never drop, add, round or regroup a digit. `0003356007` must stay `0003356007`, never `000335600`. If a digit is illegible write `?` instead of leaving it out.
- Only these tags may appear: `<table> <tr> <th> <td> <dl> <dt> <dd> <pre> <div> <br>`. Never use `<p>`, `<b>`, `<span>`, `<ul>`, `<li>`, `<h1>`–`<h6>` or any attribute other than `colspan` / `rowspan`.
- Empty filling area: `<td></td>` or `<dd></dd>`. A printed mark is a mark: keep its exact form — `-` stays `-`, `--` stays `--`, `/` stays `/`. Never shorten, lengthen or normalize a mark.
- Unreadable handwriting: copy your best reading; if truly illegible write `?`. Never guess a digit.
- A cell holding several printed lines stays ONE cell: separate the lines with `<br>`. Never split one cell into several rows or columns.
- Keep the original spelling, case, punctuation and currency glyph (`$`, `HK$`). Do not drop or add a decimal point or a leading zero.
- Repeat a repeated heading only once, in the heading row.
- A printed row label and the number written to its right stay in the same `<tr>`: label in the first `<td>`, number in its own `<td>`. Never move a number to another row or column.
- If a real table sits inside another table (a page-level Total printed inside a service table), nest it as a `<table>` inside that `<td>`. Do not promote it out of the table.

## 4. Order

Sort regions by the vertical position of their **top edge**, top to bottom. When two regions start on the same horizontal band, emit the left one first. Inside a region keep the printed row order and, within one row, left to right.

A region that sits low on the page stays low: never move a bottom-left paragraph up next to the page header just because it is on the left.

Do not reorder rows to group similar content. Do not move a paragraph to the top or the bottom.

## 5. Check before output

1. Is every `<table>` a printed table with a real heading row? Anything with no heading must be `<dl>`.
2. Does every `<tr>` have the same cell count (counting `colspan`)? If not, split the table.
3. Is every printed mark (`-`, `--`, `/`) still in its original form, and is every written amount in the same row and column where it was written?
4. **Self-check every table for collapsed columns.** A real table has a heading row and, below it, cells in more than one column. If any `<table>` you produced has every row written as a single `<td>` (label only, no value column), you have failed to read the value column: re-read that region on the image and rebuild the table with its cells before outputting.
5. **Self-check that labels keep their values.** For every printed fee label (`SP-PRE FEE($)`, `SP-POST FEE($)`, `Total Fee($)`, `PROCEDURE(S)`, `PROCEDURE CODE`, `LABORATORY FEE($)`, `MEDICATION FEE($)`, and every `Bill on chit` row), confirm the amount printed next to it appears in the same row. If a label appears without its value while the image shows a value, re-read and fix it before outputting.

## 6. Example shape

```html
<dl>
  <dt>Patient Name 病人名稱</dt><dd>NG M W</dd>
  <dt>Consultation Date 診症日期</dt><dd>02 Oct 2024</dd>
</dl>
<table>
  <tr><th>Medical Service 醫療服務</th><th>Bill on chit 賬單記賬 (HK$)</th><th>Payment by patient 病人支付 (HK$)</th></tr>
  <tr><td>Extra Medication 額外藥物</td><td>-</td><td>-</td></tr>
  <tr><td>Minor Operation Procedure 小手術</td><td>4,016.0</td><td>-</td></tr>
  <tr><td>CO2Laser &gt;40 lesion excl wart</td><td></td><td></td></tr>
</table>
<pre>
本人明白是項申請核准並不代表所有醫療費用均能由保險承擔
</pre>
```
