/**
 * Prints #print-root (docs/modules/pos.md → Printing) with `title` as the document title: if a
 * browser still prints its header despite the zero page margins, it names the organization, never
 * the product. `window.print()` blocks until the dialog closes, so the old title comes back after.
 */
export function printAs(title: string): void {
  const previous = document.title;
  if (title) document.title = title;
  try {
    window.print();
  } finally {
    document.title = previous;
  }
}
