'use client';

import type { LabelKey } from '@durby/i18n';
import {
  type LocationSummary,
  type NativeDiscoverAnswer,
  type Printer,
  type PrinterCommand,
  type PrinterCommandKind,
  type PrinterSettings,
  printerSettingsOf,
  printerSettingsSchema,
  PRINTER_NAME_MAX_LENGTH,
  PRINTER_PORTS,
  PRINTER_STATION_KEYS,
  type PrinterStationKey,
} from '@durby/shared';
import { Plus, Printer as PrinterIcon, Search } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Notice } from '../../app/auth-layout';
import { useT } from '../../app/labels-provider';
import { useAuth } from '../../app/providers';
import { errorLabel } from '../../lib/auth/errors';
import { loadPrinterCommands, requestPrinterCommand } from '../../lib/pos/printer-commands';
import { renderBillImage } from '../../lib/print/bill-image';
import { nativePrinter, type NativePrintOutcome } from '../../lib/print/native';
import { nativePrintMessage } from '../../lib/print/native-bill';
import { archivePrinter, createPrinter, loadPrinters, updatePrinter } from '../../lib/pos/printers';
import { useActionKey } from '../../lib/use-action-key';
import { useResource } from '../../lib/use-resource';
import { loadLocations } from '../../lib/users/api';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { ConfirmAction, Loaded, NoAccess } from '../users/common';
import { TestPrintPage, type TestPagePrinter } from '../pos/test-print-page';

/** 80 mm first and the default for a new printer: most restaurant printers in Germany use it. */
const PAPER_WIDTHS = [576, 512, 384] as const;
const DEFAULT_WIDTH_DOTS = PAPER_WIDTHS[0];

const STATUS_LABELS: Record<NativeDiscoverAnswer['printers'][number]['status'], LabelKey> = {
  online: 'pos.printerSettings.statusOnline',
  paper_out: 'pos.printerSettings.statusPaperOut',
  cover_open: 'pos.printerSettings.statusCoverOpen',
  no_status: 'pos.printerSettings.statusNoStatus',
};

const STATION_LABELS: Record<PrinterStationKey, LabelKey> = {
  kitchen: 'pos.station.kitchen',
  bar: 'pos.station.bar',
};

interface Draft {
  name: string;
  host: string;
  port: string;
  widthDots: string;
  cutter: boolean;
  imageMode: PrinterSettings['imageMode'];
  printsBills: boolean;
  stations: PrinterStationKey[];
  enabled: boolean;
}

const draftOf = (p: Printer | null): Draft => ({
  name: p?.name ?? '',
  host: p?.host ?? '',
  port: String(p?.port ?? 9100),
  widthDots: String(p?.widthDots ?? DEFAULT_WIDTH_DOTS),
  cutter: p?.cutter ?? true,
  imageMode: p?.imageMode ?? 'gsV0',
  printsBills: p?.printsBills ?? false,
  stations: p?.stations ?? [],
  // A new printer starts switched off (ADR 0033); it is switched on after a test print.
  enabled: p?.enabled ?? false,
});

const printerOf = (d: Draft) =>
  printerSettingsSchema.safeParse({
    host: d.host.trim(),
    port: Number(d.port),
    widthDots: Number(d.widthDots),
    cutter: d.cutter,
    imageMode: d.imageMode,
  });

/**
 * /settings/printers (ADR 0032, ADR 0033): each location's printers, as a list. A printer prints bills and/or the
 * tickets of chosen stations; one printer may serve several stations and one station may print on several. New
 * printers start switched off. Find printer and the test print run in the app, or from a browser through the till
 * (remote commands). Reading needs platform.settings.read, changing platform.settings.manage (the api checks both).
 */
export function PrintersPage() {
  const { store, session } = useAuth();
  const canRead = session?.activePermissions.includes('platform.settings.read') ?? false;
  const [locations, reload] = useResource(
    canRead ? (session?.activeOrganizationId ?? null) : null,
    () => loadLocations(store),
  );
  if (!session) return null;
  if (!canRead || !session.activeFeatures.includes('pos')) {
    return <NoAccess title="pos.printerSettings.title" />;
  }
  return (
    <Loaded resource={locations} reload={reload}>
      {(list) => <PrinterSettingsView locations={list} />}
    </Loaded>
  );
}

function PrinterSettingsView({ locations }: { locations: LocationSummary[] }) {
  const t = useT();
  const id = useId();
  const { store, session } = useAuth();
  // Printers are where the paper is: always one location.
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [printers, reload] = useResource(
    locationId ? `${session?.activeOrganizationId ?? ''}:${locationId}` : null,
    () => loadPrinters(store, locationId),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('pos.printerSettings.title')}</h1>
          <p className="max-w-2xl text-muted-foreground">{t('pos.printerSettings.description')}</p>
        </div>
        {locations.length > 0 && (
          <div className="grid min-w-56 gap-1.5">
            <Label htmlFor={`${id}-location`}>{t('pos.printerSettings.location')}</Label>
            <Select
              id={`${id}-location`}
              data-testid="printers-location"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
            >
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      {locations.length === 0 ? (
        <p className="text-muted-foreground">{t('pos.printerSettings.noLocations')}</p>
      ) : (
        <Loaded resource={printers} reload={reload}>
          {(list) => (
            <PrinterList
              key={locationId}
              locationId={locationId}
              locationName={locations.find((l) => l.id === locationId)?.name ?? ''}
              printers={list}
              onChanged={reload}
            />
          )}
        </Loaded>
      )}
    </div>
  );
}

function PrinterList({
  locationId,
  locationName,
  printers,
  onChanged,
}: {
  locationId: string;
  locationName: string;
  printers: Printer[];
  onChanged: () => void;
}) {
  const t = useT();
  const { session } = useAuth();
  const canManage = session?.activePermissions.includes('platform.settings.manage') ?? false;
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {printers.length === 0 && !adding && (
        <p className="text-muted-foreground" data-testid="printers-none">
          {t('pos.printerSettings.noPrinters')}
        </p>
      )}
      {printers.map((p) => (
        // A saved change remounts only that card; the others keep what is being typed.
        <PrinterCard
          key={`${p.id}:${p.updatedAt}`}
          locationId={locationId}
          locationName={locationName}
          printer={p}
          canManage={canManage}
          onChanged={onChanged}
        />
      ))}
      {adding && (
        <PrinterCard
          locationId={locationId}
          locationName={locationName}
          printer={null}
          canManage={canManage}
          onChanged={() => {
            setAdding(false);
            onChanged();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {canManage && !adding && (
        <Button
          type="button"
          variant="outline"
          className="gap-2 self-start"
          onClick={() => setAdding(true)}
          data-testid="printers-add"
        >
          <Plus aria-hidden />
          {t('pos.printerSettings.add')}
        </Button>
      )}
    </div>
  );
}

/** One printer, or a new one (`printer` null) until it is added. */
function PrinterCard({
  locationId,
  locationName,
  printer,
  canManage,
  onChanged,
  onCancel,
}: {
  locationId: string;
  locationName: string;
  printer: Printer | null;
  canManage: boolean;
  onChanged: () => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const id = useId();
  const { store } = useAuth();
  const saveAction = useActionKey();
  const archiveAction = useActionKey();
  const [draft, setDraft] = useState<Draft>(() => draftOf(printer));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const app = nativePrinter();

  const parsed = printerOf(draft);
  const name = draft.name.trim();
  const valid = parsed.success && name !== '';
  const hostInvalid =
    draft.host.trim() !== '' &&
    !printerSettingsSchema.shape.host.safeParse(draft.host.trim()).success;
  const testId = printer ? `printers-card-${printer.id}` : 'printers-card-new';

  const set = <K extends keyof Draft>(field: K, next: Draft[K]) =>
    setDraft((d) => ({ ...d, [field]: next }));
  const toggleStation = (key: PrinterStationKey, on: boolean) =>
    setDraft((d) => ({
      ...d,
      stations: on
        ? PRINTER_STATION_KEYS.filter((k) => k === key || d.stations.includes(k))
        : d.stations.filter((k) => k !== key),
    }));
  const pick = (host: string, port: number) =>
    setDraft((d) => ({ ...d, host, port: String(port) }));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!parsed.success) {
      setError(t('pos.printerSettings.hostInvalid'));
      return;
    }
    if (!name) {
      setError(t('pos.printerSettings.nameRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    const fields = {
      name,
      ...parsed.data,
      printsBills: draft.printsBills,
      stations: draft.stations,
    };
    const result = printer
      ? await updatePrinter(store, saveAction, printer.id, { ...fields, enabled: draft.enabled })
      : await createPrinter(store, saveAction, { locationId, ...fields });
    setBusy(false);
    if (!result.ok) {
      setError(t(errorLabel(result.code)));
      return;
    }
    saveAction.done();
    onChanged();
  }

  // What the test page says: the saved name, or the one being typed.
  const testPrinter: TestPagePrinter | null = parsed.success
    ? { name: name || (printer?.name ?? ''), host: parsed.data.host, port: parsed.data.port }
    : null;

  return (
    <Card className="flex flex-col gap-4 p-4" data-testid={testId}>
      <form className="flex flex-col gap-4" onSubmit={(e) => void save(e)} noValidate>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">{printer?.name ?? t('pos.printerSettings.newPrinter')}</h2>
          {printer && (
            <Badge data-testid="printers-state">
              {t(printer.enabled ? 'pos.printerSettings.on' : 'pos.printerSettings.off')}
            </Badge>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-name`}>{t('pos.printerSettings.name')}</Label>
          <Input
            id={`${id}-name`}
            data-testid="printers-name"
            maxLength={PRINTER_NAME_MAX_LENGTH}
            value={draft.name}
            disabled={!canManage}
            onChange={(e) => set('name', e.target.value)}
          />
          <p className="text-sm text-muted-foreground">{t('pos.printerSettings.nameHint')}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-host`}>{t('pos.printerSettings.host')}</Label>
            <Input
              id={`${id}-host`}
              data-testid="printers-host"
              inputMode="decimal"
              autoComplete="off"
              placeholder="192.168.1.20"
              value={draft.host}
              disabled={!canManage}
              aria-invalid={hostInvalid || undefined}
              onChange={(e) => set('host', e.target.value)}
            />
            <p
              className={hostInvalid ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
            >
              {t(hostInvalid ? 'pos.printerSettings.hostInvalid' : 'pos.printerSettings.hostHint')}
            </p>
          </div>
          <div className="grid content-start gap-1.5">
            <Label htmlFor={`${id}-port`}>{t('pos.printerSettings.port')}</Label>
            <Select
              id={`${id}-port`}
              data-testid="printers-port"
              value={draft.port}
              disabled={!canManage}
              onChange={(e) => set('port', e.target.value)}
            >
              {PRINTER_PORTS.map((p) => (
                <option key={p} value={String(p)}>
                  {p}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-paper`}>{t('pos.printerSettings.paper')}</Label>
            <Select
              id={`${id}-paper`}
              data-testid="printers-paper"
              value={draft.widthDots}
              disabled={!canManage}
              onChange={(e) => set('widthDots', e.target.value)}
            >
              {PAPER_WIDTHS.map((w) => (
                <option key={w} value={String(w)}>
                  {t(`pos.printerSettings.paper${w}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-mode`}>{t('pos.printerSettings.imageMode')}</Label>
            <Select
              id={`${id}-mode`}
              data-testid="printers-mode"
              value={draft.imageMode}
              disabled={!canManage}
              onChange={(e) => set('imageMode', e.target.value as Draft['imageMode'])}
            >
              <option value="gsV0">{t('pos.printerSettings.imageModeGsV0')}</option>
              <option value="escStar">{t('pos.printerSettings.imageModeEscStar')}</option>
            </Select>
          </div>
        </div>
        <CheckRow
          id={`${id}-cutter`}
          testId="printers-cutter"
          checked={draft.cutter}
          disabled={!canManage}
          onChange={(on) => set('cutter', on)}
          label={t('pos.printerSettings.cutter')}
        />
        <fieldset className="flex flex-col gap-1">
          <CheckRow
            id={`${id}-bills`}
            testId="printers-bills"
            checked={draft.printsBills}
            disabled={!canManage}
            onChange={(on) => set('printsBills', on)}
            label={t('pos.printerSettings.printsBills')}
          />
          <legend className="sr-only">{t('pos.printerSettings.ticketsFor')}</legend>
          <p className="mt-2 text-sm font-medium">{t('pos.printerSettings.ticketsFor')}</p>
          <div className="flex flex-wrap gap-x-6">
            {PRINTER_STATION_KEYS.map((key) => (
              <CheckRow
                key={key}
                id={`${id}-station-${key}`}
                testId={`printers-station-${key}`}
                checked={draft.stations.includes(key)}
                disabled={!canManage}
                onChange={(on) => toggleStation(key, on)}
                label={t(STATION_LABELS[key])}
              />
            ))}
          </div>
        </fieldset>
        {printer && (
          <div className="flex flex-col gap-1">
            <CheckRow
              id={`${id}-enabled`}
              testId="printers-enabled"
              checked={draft.enabled}
              disabled={!canManage}
              onChange={(on) => set('enabled', on)}
              label={t('pos.printerSettings.enabled')}
              strong
            />
            <p className="text-sm text-muted-foreground">{t('pos.printerSettings.enabledHint')}</p>
          </div>
        )}
        {!printer && (
          <p className="text-sm text-muted-foreground">{t('pos.printerSettings.enabledHint')}</p>
        )}

        {canManage && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy || !valid} data-testid="printers-save">
              {t(printer ? 'pos.printerSettings.save' : 'pos.printerSettings.create')}
            </Button>
            {onCancel && (
              <Button type="button" variant="ghost" onClick={onCancel}>
                {t('pos.printerSettings.cancel')}
              </Button>
            )}
            {printer && (
              <ConfirmAction
                trigger={t('pos.printerSettings.archive')}
                title={t('pos.printerSettings.archive')}
                description={t('pos.printerSettings.archiveConfirm')}
                confirm={t('pos.printerSettings.archive')}
                run={() => archivePrinter(store, archiveAction, printer.id)}
                onDone={onChanged}
                testId="printers-archive"
              />
            )}
            <Notice text={error} tone="error" />
          </div>
        )}
      </form>

      {canManage &&
        (app ? (
          <OnDevice
            printer={parsed.success ? parsed.data : null}
            testPrinter={testPrinter}
            locationName={locationName}
            onPick={pick}
          />
        ) : (
          <OnTill
            locationId={locationId}
            printerId={printer?.id ?? null}
            canTest={
              printer !== null && parsed.success && sameAs(parsed.data, printerSettingsOf(printer))
            }
            onPick={pick}
          />
        ))}
    </Card>
  );
}

function CheckRow({
  id,
  testId,
  checked,
  disabled,
  onChange,
  label,
  strong = false,
}: {
  id: string;
  testId: string;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
  label: string;
  strong?: boolean;
}) {
  return (
    <div className="flex min-h-11 items-center gap-3">
      <Checkbox
        id={id}
        data-testid={testId}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(on) => onChange(on === true)}
      />
      <Label htmlFor={id} className={strong ? 'cursor-pointer font-semibold' : 'cursor-pointer'}>
        {label}
      </Label>
    </div>
  );
}

/** Inside the Android app: find printers on the till's network and send a test print to the form's printer. */
function OnDevice({
  printer,
  testPrinter,
  locationName,
  onPick,
}: {
  printer: PrinterSettings | null;
  testPrinter: TestPagePrinter | null;
  locationName: string;
  onPick: (host: string, port: number) => void;
}) {
  const t = useT();
  const testBill = useRef<HTMLDivElement>(null);
  const [found, setFound] = useState<NativeDiscoverAnswer | 'searching' | 'noAnswer' | null>(null);
  const [test, setTest] = useState<NativePrintOutcome | 'printing' | null>(null);

  async function find() {
    const app = nativePrinter();
    if (!app) return;
    setFound('searching');
    setFound((await app.discover()) ?? 'noAnswer');
  }

  async function testPrint() {
    const app = nativePrinter();
    if (!app || !printer || !testBill.current) return;
    setTest('printing');
    try {
      const image = await renderBillImage(testBill.current, printer.widthDots);
      setTest(await app.print(crypto.randomUUID(), image, printer));
    } catch {
      setTest({ state: 'failed', code: 'print.payload_invalid' });
    }
  }

  return (
    <div
      className="flex flex-col gap-4 border-t border-border pt-4"
      data-testid="printers-on-device"
    >
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          disabled={found === 'searching'}
          onClick={() => void find()}
          data-testid="printers-find"
        >
          <Search aria-hidden />
          {t('pos.printerSettings.find')}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          disabled={!printer || test === 'printing'}
          onClick={() => void testPrint()}
          data-testid="printers-test"
        >
          <PrinterIcon aria-hidden />
          {t('pos.printerSettings.test')}
        </Button>
      </div>

      {found === 'searching' && <Notice text={t('pos.printerSettings.finding')} tone="info" />}
      {found === 'noAnswer' && <Notice text={t('pos.nativePrint.noAnswer')} tone="error" />}
      {found && typeof found === 'object' && <FoundPrinters answer={found} onPick={onPick} />}

      {test === 'printing' && <Notice text={t('pos.nativePrint.printing')} tone="info" />}
      {test && typeof test === 'object' && (
        <Notice
          text={t(nativePrintMessage(test.code))}
          tone={test.state === 'sent' ? 'info' : 'error'}
        />
      )}

      <TestPrintPage ref={testBill} locationName={locationName} printer={testPrinter} />
    </div>
  );
}

const sameAs = (a: PrinterSettings, b: PrinterSettings) => JSON.stringify(a) === JSON.stringify(b);

/**
 * From a browser (Berlin): Find printer and the test print go to the location's till as remote commands
 * (ADR 0032 §15); the page follows the command until the till answers or it expires after 5 minutes.
 */
function OnTill({
  locationId,
  printerId,
  canTest,
  onPick,
}: {
  locationId: string;
  /** The saved printer a test print goes to; none before it is added. */
  printerId: string | null;
  canTest: boolean;
  onPick: (host: string, port: number) => void;
}) {
  const t = useT();
  const { store } = useAuth();
  const findAction = useActionKey();
  const testAction = useActionKey();
  const [command, setCommand] = useState<PrinterCommand | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open =
    command !== null &&
    !command.expired &&
    (command.status === 'pending' || command.status === 'claimed');

  // Follow the command while it is open: the till picks it up within 15 s.
  useEffect(() => {
    if (!open || !command) return;
    const timer = setInterval(() => {
      void loadPrinterCommands(store, locationId).then((list) => {
        const latest = list.ok ? list.data.find((c) => c.id === command.id) : undefined;
        if (latest) setCommand(latest);
      });
    }, 3_000);
    return () => clearInterval(timer);
  }, [open, command, store, locationId]);

  async function send(kind: PrinterCommandKind) {
    setError(null);
    const action = kind === 'find_printers' ? findAction : testAction;
    const created = await requestPrinterCommand(
      store,
      action,
      locationId,
      kind,
      kind === 'test_print' ? (printerId ?? undefined) : undefined,
    );
    action.done();
    if (!created.ok) setError(t(errorLabel(created.code)));
    else setCommand(created.data);
  }

  return (
    <div className="flex flex-col gap-4 border-t border-border pt-4" data-testid="printers-on-till">
      <p className="text-sm text-muted-foreground">{t('pos.printerSettings.remoteHint')}</p>
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          disabled={open}
          onClick={() => void send('find_printers')}
          data-testid="printers-find-on-till"
        >
          <Search aria-hidden />
          {t('pos.printerSettings.findOnTill')}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          disabled={open || !canTest}
          onClick={() => void send('test_print')}
          data-testid="printers-test-on-till"
        >
          <PrinterIcon aria-hidden />
          {t('pos.printerSettings.testOnTill')}
        </Button>
      </div>
      {!canTest && (
        <p className="text-sm text-muted-foreground">{t('pos.printerSettings.testSaved')}</p>
      )}
      <Notice text={error} tone="error" />
      {command && <CommandOutcome command={command} onPick={onPick} />}
    </div>
  );
}

function CommandOutcome({
  command,
  onPick,
}: {
  command: PrinterCommand;
  onPick: (host: string, port: number) => void;
}) {
  const t = useT();
  const testId = 'printers-command-state';
  if (command.expired) {
    return (
      <div data-testid={testId}>
        <Notice text={t('pos.printerSettings.expired')} tone="error" />
      </div>
    );
  }
  if (command.status === 'pending' || command.status === 'claimed') {
    const text = t(
      command.status === 'pending' ? 'pos.printerSettings.waiting' : 'pos.printerSettings.running',
    );
    return (
      <div data-testid={testId}>
        <Notice text={text} tone="info" />
      </div>
    );
  }
  const result = command.result;
  if (result && 'printers' in result) {
    return (
      <div data-testid={testId}>
        <FoundPrinters answer={{ type: 'discover', ...result }} onPick={onPick} />
      </div>
    );
  }
  const code = result?.code ?? 'print.no_answer';
  return (
    <div data-testid={testId}>
      <Notice text={t(nativePrintMessage(code))} tone={code === 'print.sent' ? 'info' : 'error'} />
    </div>
  );
}

function FoundPrinters({
  answer,
  onPick,
}: {
  answer: NativeDiscoverAnswer;
  onPick: (host: string, port: number) => void;
}) {
  const t = useT();
  if (!answer.subnet) return <Notice text={t('pos.printerSettings.noNetwork')} tone="error" />;
  if (answer.printers.length === 0) {
    return (
      <Notice text={t('pos.printerSettings.foundNone', { subnet: answer.subnet })} tone="info" />
    );
  }
  return (
    <ul
      className="flex flex-col divide-y divide-border rounded-md border border-border"
      data-testid="printers-found"
    >
      {answer.printers.map((p) => (
        <li
          key={`${p.host}:${p.port}`}
          className="flex min-h-12 items-center justify-between gap-3 px-3"
        >
          <span className="font-mono tabular-nums">
            {p.host}:{p.port}
          </span>
          <span className="flex items-center gap-3">
            <Badge>{t(STATUS_LABELS[p.status])}</Badge>
            <Button type="button" onClick={() => onPick(p.host, p.port)}>
              {t('pos.printerSettings.use')}
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );
}
