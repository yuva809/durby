/** A percentage of the api ("-5.0") in the organization's locale; `signed` puts a plus before a rise. */
export function percentText(locale: string, value: string, signed = false): string {
  const options: Intl.NumberFormatOptions = {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    ...(signed ? { signDisplay: 'exceptZero' } : {}),
  };
  try {
    return `${new Intl.NumberFormat(locale, options).format(value as `${number}`)} %`;
  } catch {
    return `${value} %`;
  }
}
