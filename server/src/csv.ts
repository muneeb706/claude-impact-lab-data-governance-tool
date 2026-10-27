// Minimal RFC 4180 CSV parsing and writing: quoted fields, escaped quotes ("") and line breaks inside quotes.

export class CsvError extends Error {}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // skip a UTF-8 byte order mark

  for (; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new CsvError('The file ends inside a quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Ignore blank lines.
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

const needsQuotes = /[",\r\n]/;

export function toCsv(rows: string[][]): string {
  return rows
    .map((row) => row.map((value) => (needsQuotes.test(value) ? `"${value.replace(/"/g, '""')}"` : value)).join(','))
    .join('\n')
    .concat('\n');
}

/** Parses a CSV with a header row, checking every row has the same number of fields. */
export function parseTable(text: string): { header: string[]; rows: string[][] } {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new CsvError('The file is empty');
  const trimmed = header.map((h) => h.trim());
  if (trimmed.some((h) => h === '')) throw new CsvError('Every column needs a name in the header row');
  const duplicate = trimmed.find((h, i) => trimmed.indexOf(h) !== i);
  if (duplicate) throw new CsvError(`The column "${duplicate}" appears more than once`);
  rows.forEach((row, i) => {
    if (row.length !== trimmed.length) {
      throw new CsvError(`Row ${i + 2} has ${row.length} fields but the header has ${trimmed.length}`);
    }
  });
  return { header: trimmed, rows };
}
