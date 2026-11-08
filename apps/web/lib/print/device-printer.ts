/**
 * This device's default receipt printer per location (ADR 0033): the printer a bill goes to when the location has
 * several. Held in memory for now, so the till asks once per app start: the web never uses browser storage
 * (lib/auth/session.test.ts). Version 1.1 of the app keeps it in the app's own storage (device settings).
 */
const chosen = new Map<string, string>();

export function deviceBillPrinter(locationId: string): string | null {
  return chosen.get(locationId) ?? null;
}

export function setDeviceBillPrinter(locationId: string, printerId: string): void {
  chosen.set(locationId, printerId);
}

/** Tests: forget every choice. */
export function forgetDeviceBillPrinters(): void {
  chosen.clear();
}
