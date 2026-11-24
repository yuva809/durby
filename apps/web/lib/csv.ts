const BOM = String.fromCharCode(0xfeff);

/** Text a spreadsheet would run as a formula (CSV injection); plain numbers, also negative ones, stay numbers. */
const isFormula = (value: string) =>
  /^[=+\-@\t\r]/.test(value) && !/^[+-]?\d+([.,]\d+)?$/.test(value);

/** RFC 4180 CSV with a UTF-8 byte order mark, so Excel opens umlauts and € correctly. */
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const cell = (raw: string) => {
    const value = isFormula(raw) ? `'${raw}` : raw;
    return /[",\n\r;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  };
  return `${BOM}${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

/** Hands the viewer a CSV file. */
export function downloadCsv(
  fileName: string,
  header: readonly string[],
  rows: readonly (readonly string[])[],
): void {
  const url = URL.createObjectURL(
    new Blob([toCsv(header, rows)], { type: 'text/csv;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `${fileName}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
