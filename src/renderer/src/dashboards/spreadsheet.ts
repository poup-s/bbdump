/**
 * A dashboard's data for spreadsheets: an Excel file (.xlsx, one sheet per block) and the
 * tab-separated text Excel and Google Sheets take when pasting. Numbers stay numbers and ISO
 * dates become real dates, so they can be summed and sorted. Pure: tested without a window.
 */
import { zipSync, strToU8 } from 'fflate';

export interface Sheet {
  name: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  /** Headers shown instead of the column names */
  labels?: string[];
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

const escapeXml = (text: string) => text
  // Characters XML 1.0 does not allow (a binary value…)
  .replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Excel's day number of a date written as text (null when it is not one) */
export function excelDate(value: string): { serial: number; time: boolean } | null {
  const withTime = ISO_DATETIME.exec(value);
  const m = withTime ?? ISO_DATE.exec(value);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - Date.UTC(1899, 11, 30);
  return { serial: ms / 86400000, time: !!withTime };
}

/** Column letters: 0 → A, 26 → AA */
export function columnName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Sheet names: at most 31 characters, none of []:*?/\, all different */
export function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, i) => {
    const base = (raw.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim() || `Sheet ${i + 1}`).slice(0, 31);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

// Styles: 0 default, 1 header (bold), 2 date, 3 date and time
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
</styleSheet>`;

function cell(ref: string, value: unknown, header = false): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const text = String(value);
  if (!header) {
    const date = excelDate(text);
    if (date) return `<c r="${ref}" s="${date.time ? 3 : 2}"><v>${date.serial}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ''}><is><t xml:space="preserve">${escapeXml(text.slice(0, 32767))}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const headers = sheet.columns.map((c, i) => sheet.labels?.[i] || c);
  const rows = [
    `<row r="1">${headers.map((h, i) => cell(`${columnName(i)}1`, h, true)).join('')}</row>`,
    ...sheet.rows.map((row, r) => `<row r="${r + 2}">${sheet.columns.map((c, i) => cell(`${columnName(i)}${r + 2}`, row[c])).join('')}</row>`),
  ];
  const widths = headers.map((h, i) => {
    const longest = Math.max(h.length, ...sheet.rows.slice(0, 200).map(r => String(r[sheet.columns[i]] ?? '').length));
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(8, longest + 2))}" customWidth="1"/>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${widths.length ? `<cols>${widths.join('')}</cols>` : ''}<sheetData>${rows.join('')}</sheetData></worksheet>`;
}

/** An Excel workbook, one sheet per block */
export function toXlsx(sheets: Sheet[]): Uint8Array {
  const list = sheets.length ? sheets : [{ name: 'Sheet 1', columns: [], rows: [] }];
  const names = sheetNames(list.map(s => s.name));
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(STYLES),
  };
  list.forEach((sheet, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(sheet)); });
  return zipSync(files, { level: 6 });
}

/** Tab-separated text: what spreadsheets take when pasting (numbers with the user's decimal mark) */
export function toTsv(sheet: Sheet, lang: string): string {
  const decimal = (1.5).toLocaleString(lang).includes(',') ? ',' : '.';
  const clean = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const text = typeof v === 'number' ? String(v).replace('.', decimal) : String(v);
    return text.replace(/[\t\r\n]+/g, ' ');
  };
  return [sheet.columns.map((c, i) => clean(sheet.labels?.[i] || c)).join('\t'), ...sheet.rows.map(r => sheet.columns.map(c => clean(r[c])).join('\t'))].join('\n');
}
