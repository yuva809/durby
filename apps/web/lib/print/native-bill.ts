import type { LabelKey } from '@durby/i18n';
import type { PrinterSettings, PrintImage } from '@durby/shared';
import type { NativePrinter, NativePrintOutcome } from './native';

/**
 * One bill through the app: draw it at the printer's width, send it with the location's printer. Never throws:
 * every way it can end is an outcome with a message.
 */
export async function printBillNatively(
  printer: Pick<NativePrinter, 'print'>,
  settings: PrinterSettings | null,
  bill: HTMLElement,
  jobId: string,
  render: (bill: HTMLElement, widthDots: number) => Promise<PrintImage>,
): Promise<NativePrintOutcome> {
  if (!settings) return { state: 'failed', code: 'print.no_printer' };
  let image: PrintImage;
  try {
    image = await render(bill, settings.widthDots);
  } catch {
    return { state: 'failed', code: 'print.payload_invalid' };
  }
  return printer.print(jobId, image, settings);
}

const MESSAGES: Record<NativePrintOutcome['code'], LabelKey> = {
  'print.sent': 'pos.nativePrint.sent',
  'print.no_printer': 'pos.nativePrint.noPrinter',
  'print.host_not_allowed': 'pos.nativePrint.hostNotAllowed',
  'print.port_not_allowed': 'pos.nativePrint.portNotAllowed',
  'print.payload_invalid': 'pos.nativePrint.payloadInvalid',
  'print.printer_unreachable': 'pos.nativePrint.printerUnreachable',
  'print.printer_timeout': 'pos.nativePrint.printerTimeout',
  'print.printer_disconnected': 'pos.nativePrint.printerDisconnected',
  'print.paper_out': 'pos.nativePrint.paperOut',
  'print.cover_open': 'pos.nativePrint.coverOpen',
  'print.no_answer': 'pos.nativePrint.noAnswer',
};

export function nativePrintMessage(code: NativePrintOutcome['code']): LabelKey {
  return MESSAGES[code];
}
