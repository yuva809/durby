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
  MAX_PDF_PAGES,
  MAX_SCAN_PAGES,
  type OcrProgress,
  preparePages,
  recognizePages,
  ScanError,
} from '../../../lib/catalog/menu-scan/ocr';
import { parseMenu } from '../../../lib/catalog/menu-scan/parse';
import { parseTextPages } from '../../../lib/catalog/menu-scan/pdf-text';
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
const ACCEPT = 'image/*,application/pdf,.pdf,.jfif,.heic,.heif';

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
  | { kind: 'reading'; progress: OcrProgress | null; preparing: OcrProgress | null }
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
  const [smallWarning, setSmallWarning] = useState<string | null>(null);
  const [exactPdf, setExactPdf] = useState(false);
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
    // Copy now: a FileList is live and empties when the input is cleared right after.
    const added = list ? Array.from(list) : [];
    if (added.length === 0) return;
    setFiles((current) => [...current, ...added]);
    setStep({ kind: 'upload', error: null });
  }

  async function read() {
    const controller = new AbortController();
    abort.current = controller;
    setStep({ kind: 'reading', progress: null, preparing: null });
    try {
      const scanPages = await preparePages(files, (preparing) =>
        setStep({ kind: 'reading', progress: null, preparing }),
      );
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
        (progress) => setStep({ kind: 'reading', progress, preparing: null }),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      // PDF pages with their own text are read exactly; the rest was recognized above.
      const fromText = parseTextPages(
        scanPages.flatMap((p) => (p.text ? [{ number: p.number, items: p.text }] : [])),
      );
      const parsed = [...fromText, ...parseMenu(lines)];
      setExactPdf(fromText.length > 0);
      if (parsed.length === 0) {
        const small = scanPages.find((p) => p.small);
        setStep({
          kind: 'upload',
          error: small
            ? t('catalog.scan.errors.tooSmall', {
                width: String(small.sourceWidth),
                height: String(small.sourceHeight),
              })
            : t('catalog.scan.errors.nothing'),
        });
        return;
      }
      const board = boardFromParsed(parsed, {
        defaults: DEFAULT_RATES,
        uncategorized: t('catalog.scan.uncategorized'),
        newId: () => crypto.randomUUID(),
      });
      dispatch({ type: 'reset', board });
      setRestored(false);
      const small = scanPages.find((p) => p.small);
      setSmallWarning(
        small
          ? t('catalog.scan.smallWarning', {
              width: String(small.sourceWidth),
              height: String(small.sourceHeight),
            })
          : null,
      );
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
        return t('catalog.scan.errors.tooManyPages', {
          max: String(MAX_SCAN_PAGES),
          pdf: String(MAX_PDF_PAGES),
        });
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
    setSmallWarning(null);
    setExactPdf(false);
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

      {step.kind === 'reading' && (
        <ReadingStep progress={step.progress} preparing={step.preparing} onCancel={cancelReading} />
      )}

      {step.kind === 'review' && (
        <>
          {exactPdf && (
            <p
              role="status"
              className="rounded-md bg-accent px-3 py-2 text-sm"
              data-testid="scan-exact"
            >
              {t('catalog.scan.exactPdf')}
            </p>
          )}
          {smallWarning && (
            <p
              role="alert"
              className="rounded-md border border-[var(--table-amber)] bg-[var(--table-amber-soft)] px-3 py-2 text-sm"
              data-testid="scan-small"
            >
              {smallWarning}
            </p>
          )}
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

  const hasFiles = files.length > 0;
  // A menu image copied from a website, chat or screenshot tool: paste it with Ctrl+V.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('input:not([type=file]), textarea, [contenteditable]')) return;
      if (e.clipboardData && e.clipboardData.files.length > 0) {
        e.preventDefault();
        onAdd(e.clipboardData.files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [onAdd]);
  const startButton = useRef<HTMLButtonElement>(null);
  // Files just chosen: bring "Read menu" into view and focus it, so the next step is obvious.
  useEffect(() => {
    if (files.length === 0) return;
    startButton.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    startButton.current?.focus({ preventScroll: true });
  }, [files.length]);

  const inputs = (
    <>
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
    </>
  );
  const pickButtons = (
    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-center">
      <Button variant="outline" onClick={() => picker.current?.click()}>
        <FileUp aria-hidden />
        {t(hasFiles ? 'catalog.scan.addMore' : 'catalog.scan.choose')}
      </Button>
      <Button variant="outline" className="md:hidden" onClick={() => camera.current?.click()}>
        <Camera aria-hidden />
        {t('catalog.scan.camera')}
      </Button>
    </div>
  );

  return (
    <div
      className="flex flex-col gap-4"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={onDrop}
    >
      {inputs}
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      {hasFiles ? (
        <div
          className={cn(
            'flex flex-col gap-4 rounded-xl border bg-card p-4 transition-colors',
            over && 'border-primary bg-accent',
          )}
          data-testid="scan-drop"
        >
          {/* Phones: text, then "Read menu" full width, then the pick buttons; wider: one row. */}
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <div className="flex min-w-0 flex-col md:flex-1">
              <p className="font-medium" role="status">
                {t('catalog.scan.ready', { count: String(files.length) })}
              </p>
              {files.some((f) => !/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') && (
                <p className="text-xs text-muted-foreground">{t('catalog.scan.firstUse')}</p>
              )}
            </div>
            <Button
              ref={startButton}
              onClick={onStart}
              className="w-full md:order-last md:w-auto"
              data-testid="scan-start"
            >
              <ScanText aria-hidden />
              {t('catalog.scan.start')}
            </Button>
            {pickButtons}
          </div>
          <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
            {files.map((file, index) => (
              <li
                key={`${file.name}-${index}`}
                className="relative flex flex-col overflow-hidden rounded-lg border bg-card"
              >
                <div className="flex aspect-[3/4] items-center justify-center bg-muted">
                  {previews[index] ? (
                    // A local object URL: next/image adds nothing.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={previews[index]} alt="" className="size-full object-contain" />
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
        </div>
      ) : (
        <div
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
            {t('catalog.scan.formats', { max: String(MAX_SCAN_PAGES), pdf: String(MAX_PDF_PAGES) })}
          </p>
          {pickButtons}
        </div>
      )}
    </div>
  );
}

function ReadingStep({
  progress,
  preparing,
  onCancel,
}: {
  progress: OcrProgress | null;
  preparing: OcrProgress | null;
  onCancel: () => void;
}) {
  const t = useT();
  const shown = progress ?? preparing;
  const percent = shown ? Math.round(((shown.page - 1 + shown.progress) / shown.pages) * 100) : 0;
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
          : preparing
            ? t('catalog.scan.preparingPage', {
                page: String(preparing.page),
                pages: String(preparing.pages),
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
