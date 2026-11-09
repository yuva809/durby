'use client';

import { type LocationSummary, receiptPrinters } from '@durby/shared';
import { useEffect, useId, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { loadBillLayout } from '../../lib/pos/api';
import {
  loadDeviceSettings,
  updateDeviceSettings,
  useDeviceSettings,
} from '../../lib/print/device-settings';
import { nativePrinter } from '../../lib/print/native';
import { useTillLocation } from '../../lib/print/till-location';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Loaded, NoAccess } from '../users/common';

/**
 * /settings/device (ADR 0033 §5, §13): this device's own settings, kept by the Android app (version 1.1): whether it
 * prints, the location it prints for and its receipt printer for bills. Only inside the app, for members who print
 * bills: nothing here reaches the api.
 */
export function DevicePage() {
  const t = useT();
  const { store, session } = useAuth();
  const canPrint =
    (session?.activePermissions.includes('pos.bills.print') ?? false) &&
    (session?.activeFeatures.includes('pos') ?? false);
  const inApp = nativePrinter() !== null;
  const [locations, reload] = useResource(
    canPrint && inApp ? (session?.activeOrganizationId ?? null) : null,
    () => loadLocations(store),
  );
  useEffect(() => {
    if (inApp) void loadDeviceSettings();
  }, [inApp]);
  if (!session) return null;
  if (!canPrint) return <NoAccess title="pos.deviceSettings.title" />;
  if (!inApp) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('pos.deviceSettings.title')}</h1>
        <Notice tone="info" text={t('pos.deviceSettings.onlyInApp')} />
      </div>
    );
  }
  return (
    <Loaded resource={locations} reload={reload}>
      {(list) => <DeviceSettingsForm locations={list} />}
    </Loaded>
  );
}

function DeviceSettingsForm({ locations }: { locations: LocationSummary[] }) {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const device = useDeviceSettings();
  const { settings } = device;
  const location = useTillLocation();
  const [result, setResult] = useState<'saved' | 'failed' | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    void nativePrinter()
      ?.info()
      .then((answer) => setVersion(answer?.appVersion ?? null));
  }, []);

  const [layout] = useResource(location, () => loadBillLayout(store, location!));
  const printers = layout.status === 'ready' ? receiptPrinters(layout.data.printerList) : [];

  async function change(next: Parameters<typeof updateDeviceSettings>[0]) {
    setResult(null);
    setResult((await updateDeviceSettings(next)) ? 'saved' : 'failed');
  }

  function chooseReceiptPrinter(printerId: string) {
    if (!location) return;
    const others = Object.entries(settings.receiptPrinters).filter(([l]) => l !== location);
    void change({
      receiptPrinters: Object.fromEntries(printerId ? [...others, [location, printerId]] : others),
    });
  }

  if (!device.loaded) return null;
  return (
    <div className="flex flex-col gap-6" data-testid="device-settings">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('pos.deviceSettings.title')}</h1>
        <p className="max-w-2xl text-muted-foreground">{t('pos.deviceSettings.description')}</p>
      </div>
      {!device.stored && <Notice tone="error" text={t('pos.deviceSettings.notStored')} />}
      <Card className="flex max-w-2xl flex-col gap-6 p-6">
        <div className="flex items-start gap-3">
          <Checkbox
            id={`${id}-prints`}
            data-testid="device-prints"
            className="mt-0.5"
            checked={settings.prints}
            disabled={!device.stored}
            onCheckedChange={(on) => void change({ prints: on === true })}
          />
          <div className="grid gap-1">
            <Label htmlFor={`${id}-prints`}>{t('pos.deviceSettings.prints')}</Label>
            <p className="text-sm text-muted-foreground">{t('pos.deviceSettings.printsHelp')}</p>
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-location`}>{t('pos.deviceSettings.location')}</Label>
          <Select
            id={`${id}-location`}
            data-testid="device-location"
            value={settings.tillLocationId ?? ''}
            disabled={!device.stored}
            onChange={(e) => void change({ tillLocationId: e.target.value || null })}
          >
            <option value="">{t('pos.deviceSettings.locationShown')}</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
        {location && (
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-receipt`}>{t('pos.deviceSettings.receiptPrinter')}</Label>
            {layout.status === 'ready' && printers.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="device-no-receipt">
                {t('pos.deviceSettings.noReceiptPrinter')}
              </p>
            ) : (
              <Select
                id={`${id}-receipt`}
                data-testid="device-receipt"
                value={settings.receiptPrinters[location] ?? ''}
                onChange={(e) => chooseReceiptPrinter(e.target.value)}
              >
                <option value="">{t('pos.deviceSettings.receiptAsk')}</option>
                {printers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
        )}
      </Card>
      {result && (
        <Notice
          tone={result === 'saved' ? 'info' : 'error'}
          text={t(
            result === 'saved' ? 'pos.deviceSettings.saved' : 'pos.deviceSettings.saveFailed',
          )}
        />
      )}
      {version && (
        <p className="text-sm text-muted-foreground" data-testid="device-app-version">
          {t('pos.deviceSettings.appVersion', { version })}
        </p>
      )}
    </div>
  );
}
