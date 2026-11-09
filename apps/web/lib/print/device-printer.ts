import { MAX_DEVICE_RECEIPT_PRINTERS } from '@durby/shared';
import { deviceSettings, resetDeviceSettings, updateDeviceSettings } from './device-settings';

/**
 * This device's default receipt printer per location (ADR 0033): the printer a bill goes to when the location has
 * several. Part of the device settings: kept by the app from version 1.1, in memory for the page before that
 * (lib/print/device-settings.ts).
 */
export function deviceBillPrinter(locationId: string): string | null {
  return deviceSettings().settings.receiptPrinters[locationId] ?? null;
}

export function setDeviceBillPrinter(locationId: string, printerId: string): void {
  const others = Object.entries(deviceSettings().settings.receiptPrinters).filter(
    ([location]) => location !== locationId,
  );
  // At most 50 locations are remembered: the oldest choices go first.
  const kept = others.slice(Math.max(0, others.length - (MAX_DEVICE_RECEIPT_PRINTERS - 1)));
  void updateDeviceSettings({
    receiptPrinters: { ...Object.fromEntries(kept), [locationId]: printerId },
  });
}

/** Tests: forget every choice. */
export function forgetDeviceBillPrinters(): void {
  resetDeviceSettings();
}
