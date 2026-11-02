'use client';

import type { ImportProductsResponse } from '@durby/shared';
import { ArrowLeft, Camera, CheckCircle2, FileText, FileUp, ScanText, X } from 'lucide-react';
import Link from 'next/link';
import { type DragEvent, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useT } from '../../../app/labels-provider';
import { useAuth } from '../../../app/providers';
import { errorLabel } from '../../../lib/auth/errors';
import { importProducts, loadCategories, loadProducts } from '../../../lib/catalog/api';
import {
  type Board,
  boardFromParsed,
  type BoardHistory,
  historyReducer,
  toImportRows,
} from '../../../lib/catalog/menu-scan/board';
import {
  MAX_SCAN_PAGES,
  type OcrProgress,
  preparePages,
  recognizePages,
  ScanError,
} from '../../../lib/catalog/menu-scan/ocr';
import { parseMenu } from '../../../lib/catalog/menu-scan/parse';
import { useActionKey } from '../../../lib/use-action-key';
import { useResource } from '../../../lib/use-resource';
import { cn } from '../../../lib/utils';
import { MoneyProvider } from '../../pos/money';
import { Button } from '../../ui/button';
import { NoAccess } from '../../users/common';
import type { PagePreview } from './original-pane';
import { ReviewBoard } from './review-board';

/** Germany's restaurant rates as a starting point; staff change them on the board. */
const DEFAULT_RATES = { food: '7', drinks: '19' };
const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf';

/** /catalog/scan (docs/modules/catalog.md → Menu scan). Needs `catalog.products.manage`. */
export function ScanPage() {
  const { session } = useAuth();
  if (!session) return null;
  if (!session.activePermissions.includes('catalog.products.manage')) {
    return <NoAccess title="catalog.scan.title" />;
  }
  return (
    <MoneyProvider>
      <Scan key={session.activeOrganizationId} organizationId={session.activeOrganizationId} />
    </MoneyProvider>
  );
}

type Step =
  | { kind: 'upload'; error: string | null }
  | { kind: 'reading'; progress: OcrProgress | null }
  | { kind: 'review' }
  | { kind: 'done'; result: ImportProductsResponse };

const EMPTY: BoardHistory = {
  past: [],
  present: { categories: [], products: {}, defaults: DEFAULT_RATES },
  future: [],
};

function Scan({ organizationId }: { organizationId: string | null }) {
  const t = useT();
  const { store } = useAuth();
  const action = useActionKey();
  const draftKey = organizationId ? `menu-scan-draft:${organizationId}` : null;
  // An unfinished scan comes back after a reload (the board only; the page images aren't kept).
  const [draft] = useState(() => (draftKey ? readDraft(draftKey) : null));
  const [step, setStep] = useState<Step>(
    draft ? { kind: 'review' } : { kind: 'upload', error: null },
  );
  const [files, setFiles] = useState<File[]>([]);
  const [pages, setPages] = useState<PagePreview[]>([]);
  const [history, dispatch] = useReducer(
    historyReducer,
    draft ? { ...EMPTY, present: draft } : EMPTY,
  );
  const [restored, setRestored] = useState(draft !== null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [categories, reloadCategories] = useResource(organizationId, () => loadCategories(store));
  const [products, reloadProducts] = useResource(organizationId, () => loadProducts(store));
  const catalog =
    categories.status === 'ready' && products.status === 'ready'
      ? { categories: categories.data, products: products.data }
      : null;

  useEffect(() => {
    if (draftKey && step.kind === 'review') writeDraft(draftKey, history.present);
  }, [draftKey, step.kind, history.present]);

  useEffect(() => () => abort.current?.abort(), []);

  function addFiles(list: FileList | null) {
    if (!list) return;
    setFiles((current) => [...current, ...Array.from(list)]);
    setStep({ kind: 'upload', error: null });
  }

  async function read() {
    const controller = new AbortController();
    abort.current = controller;
    setStep({ kind: 'reading', progress: null });
    try {
      const scanPages = await preparePages(files);
      if (controller.signal.aborted) return;
      setPages(
        scanPages.map((p) => ({
          number: p.number,
          width: p.width,
          height: p.height,
          url: p.previewUrl,
        })),
      );
      const lines = await recognizePages(
        scanPages,
        (progress) => setStep({ kind: 'reading', progress }),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const parsed = parseMenu(lines);
      if (parsed.length === 0) {
        setStep({ kind: 'upload', error: t('catalog.scan.errors.nothing') });
        return;
      }
      const board = boardFromParsed(parsed, {
        defaults: DEFAULT_RATES,
        uncategorized: t('catalog.scan.uncategorized'),
        newId: () => crypto.randomUUID(),
      });
      dispatch({ type: 'reset', board });
      setRestored(false);
      setStep({ kind: 'review' });
    } catch (error) {
      if (controller.signal.aborted) return;
      setStep({ kind: 'upload', error: scanErrorText(error) });
    }
  }

  function scanErrorText(error: unknown): string {
    if (!(error instanceof ScanError)) return t('catalog.scan.errors.ocr');
    switch (error.kind) {
      case 'heic':
        return t('catalog.scan.errors.heic');
      case 'unsupported':
        return t('catalog.scan.errors.unsupported');
      case 'tooManyPages':
        return t('catalog.scan.errors.tooManyPages', { max: String(MAX_SCAN_PAGES) });
      case 'unreadable':
        return t('catalog.scan.errors.unreadable');
    }
  }

  function cancelReading() {
    abort.current?.abort();
    setStep({ kind: 'upload', error: null });
  }

  function reset() {
    if (draftKey) clearDraft(draftKey);
    dispatch({ type: 'reset', board: EMPTY.present });
    setFiles([]);
    setPages([]);
    setRestored(false);
    setImportError(null);
    setStep({ kind: 'upload', error: null });
  }

  async function onImport() {
    setImporting(true);
    setImportError(null);
    const result = await importProducts(store, action, toImportRows(history.present));
    setImporting(false);
    if (result.ok && result.data) {
      if (draftKey) clearDraft(draftKey);
      reloadCategories();
      reloadProducts();
      setStep({ kind: 'done', result: result.data });
    } else {
      setImportError(t(errorLabel(result.ok ? 'unknown' : result.code)));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/catalog" aria-label={t('catalog.scan.back')}>
            <ArrowLeft aria-hidden />
          </Link>
        </Button>
        <div className="flex flex-col">
          <h1 className="text-2xl font-semibold">{t('catalog.scan.title')}</h1>
          {step.kind !== 'review' && (
            <p className="text-sm text-muted-foreground">{t('catalog.scan.intro')}</p>
          )}
        </div>
      </div>

      {step.kind === 'upload' && (
        <UploadStep
          files={files}
          error={step.error}
          onAdd={addFiles}
          onRemove={(index) => setFiles((current) => current.filter((_, i) => i !== index))}
          onStart={() => void read()}
        />
      )}

      {step.kind === 'reading' && <ReadingStep progress={step.progress} onCancel={cancelReading} />}

      {step.kind === 'review' && (
        <>
          {restored && (
            <p role="status" className="rounded-md bg-accent px-3 py-2 text-sm">
              {t('catalog.scan.restored')}
            </p>
          )}
          <ReviewBoard
            board={history.present}
            canUndo={history.past.length > 0}
            canRedo={history.future.length > 0}
            dispatch={dispatch}
            pages={pages}
            catalog={catalog}
            importing={importing}
            error={importError}
            onImport={() => void onImport()}
            onDiscard={reset}
          />
        </>
      )}

      {step.kind === 'done' && (
        <div className="flex flex-col items-center gap-4 rounded-xl border bg-card p-10 text-center">
          <CheckCircle2 aria-hidden className="size-12 text-primary" />
          <p role="status" className="text-lg font-medium" data-testid="scan-done">
            {t('catalog.scan.done', {
              created: String(step.result.created),
              updated: String(step.result.updated),
              unchanged: String(step.result.unchanged),
              categories: String(step.result.categoriesCreated),
            })}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild>
              <Link href="/catalog">{t('catalog.scan.toProducts')}</Link>
            </Button>
            <Button variant="outline" onClick={reset}>
              {t('catalog.scan.scanAnother')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function UploadStep({
  files,
  error,
  onAdd,
  onRemove,
  onStart,
}: {
  files: readonly File[];
  error: string | null;
  onAdd: (files: FileList | null) => void;
  onRemove: (index: number) => void;
  onStart: () => void;
}) {
  const t = useT();
  const picker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const previews = useMemo(
    () => files.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null)),
    [files],
  );
  useEffect(() => () => previews.forEach((u) => u && URL.revokeObjectURL(u)), [previews]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    onAdd(e.dataTransfer.files);
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center gap-4 rounded-xl border-2 border-dashed bg-card px-6 py-12 text-center transition-colors',
          over && 'border-primary bg-accent',
        )}
        data-testid="scan-drop"
      >
        <div className="flex size-14 items-center justify-center rounded-full bg-muted">
          <ScanText aria-hidden className="size-7 text-primary" />
        </div>
        <p className="text-lg font-medium">{t('catalog.scan.drop')}</p>
        <p className="text-sm text-muted-foreground">
          {t('catalog.scan.formats', { max: String(MAX_SCAN_PAGES) })}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="outline" onClick={() => picker.current?.click()}>
            <FileUp aria-hidden />
            {t('catalog.scan.choose')}
          </Button>
          <Button variant="outline" className="md:hidden" onClick={() => camera.current?.click()}>
            <Camera aria-hidden />
            {t('catalog.scan.camera')}
          </Button>
        </div>
        <input
          ref={picker}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-label={t('catalog.scan.choose')}
          onChange={(e) => {
            onAdd(e.target.files);
            e.target.value = '';
          }}
          data-testid="scan-files"
        />
        <input
          ref={camera}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          tabIndex={-1}
          aria-label={t('catalog.scan.camera')}
          onChange={(e) => {
            onAdd(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      {files.length > 0 && (
        <>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {files.map((file, index) => (
              <li
                key={`${file.name}-${index}`}
                className="relative flex flex-col overflow-hidden rounded-lg border bg-card"
              >
                <div className="flex aspect-[3/4] items-center justify-center bg-muted">
                  {previews[index] ? (
                    // A local object URL: next/image adds nothing.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={previews[index]} alt="" className="size-full object-cover" />
                  ) : (
                    <FileText aria-hidden className="size-10 text-muted-foreground" />
                  )}
                </div>
                <p className="truncate px-2 py-1.5 text-xs" title={file.name}>
                  {file.name}
                </p>
                <Button
                  variant="outline"
                  size="icon"
                  className="absolute top-1 right-1 size-9 bg-card"
                  aria-label={t('catalog.scan.remove', { name: file.name })}
                  onClick={() => onRemove(index)}
                >
                  <X aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-col items-start gap-2">
            <Button onClick={onStart} data-testid="scan-start">
              <ScanText aria-hidden />
              {t('catalog.scan.start')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('catalog.scan.firstUse')}</p>
          </div>
        </>
      )}
    </div>
  );
}

function ReadingStep({
  progress,
  onCancel,
}: {
  progress: OcrProgress | null;
  onCancel: () => void;
}) {
  const t = useT();
  const percent = progress
    ? Math.round(((progress.page - 1 + progress.progress) / progress.pages) * 100)
    : 0;
  return (
    <div
      className="flex flex-col items-center gap-4 rounded-xl border bg-card px-6 py-12 text-center"
      data-testid="scan-reading"
    >
      <ScanText aria-hidden className="size-10 animate-pulse text-primary" />
      <p className="font-medium" role="status">
        {progress
          ? t('catalog.scan.reading', {
              page: String(progress.page),
              pages: String(progress.pages),
            })
          : t('catalog.scan.preparing')}
      </p>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 w-full max-w-md overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <Button variant="outline" onClick={onCancel}>
        {t('catalog.scan.cancel')}
      </Button>
    </div>
  );
}

/** Per-browser draft; storage may be missing or full, so every access is guarded. */
function readDraft(key: string): Board | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const board = JSON.parse(raw) as Board;
    const valid =
      Array.isArray(board?.categories) &&
      typeof board.products === 'object' &&
      typeof board.defaults?.food === 'string' &&
      board.categories.length > 0;
    return valid ? board : null;
  } catch {
    return null;
  }
}

function writeDraft(key: string, board: Board) {
  try {
    if (board.categories.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(board));
  } catch {
    // No storage: the draft just doesn't survive a reload.
  }
}

function clearDraft(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing stored.
  }
}
