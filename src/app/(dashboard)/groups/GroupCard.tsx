'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { attachGroupSpreadsheet } from '@/app/actions/attachGroupSpreadsheet';
import { deleteGroupAndRelatedData } from '@/app/actions/deleteGroup';
import { GoogleSheetsLogo } from '@/components/icons/GoogleSheetsLogo';
import ScanPreviewModal from '@/components/ScanPreviewModal';
import { SyncCompletionPill } from '@/components/SyncCompletionPill';
import type {
  ScanGoogleSheetResult,
  SkippedAttendanceCellsBySheet,
  SkippedRowsBySheet,
  TeacherAliasResolution,
  WorkbookClassType,
} from '@/lib/sync/googleSheetSync';
import type { StudentAliasResolution } from '@/lib/sync/googleSheetStudentSync';

type SyncResult = { success: true; message: string } | { success: false; error: string };

type NdjsonLine =
  | { kind: 'progress-status'; message: string }
  | { kind: 'progress-sheet'; title: string; current: number; total: number }
  | { kind: 'progress-db'; message: string }
  | { kind: 'done'; result: ScanGoogleSheetResult | SyncResult }
  | null;

function parseSyncNdjsonLine(line: string): NdjsonLine {
  if (!line) return null;
  let msg: {
    event?: string;
    type?: string;
    message?: string;
    title?: string;
    current?: number;
    total?: number;
    result?: unknown;
  };
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    return null;
  }
  if (msg.event === 'progress' && msg.type === 'status' && msg.message) {
    return { kind: 'progress-status', message: msg.message };
  }
  if (
    msg.event === 'progress' &&
    msg.type === 'sheet' &&
    msg.title != null &&
    msg.current != null &&
    msg.total != null
  ) {
    return { kind: 'progress-sheet', title: msg.title, current: msg.current, total: msg.total };
  }
  if (msg.event === 'progress' && msg.type === 'db' && msg.message) {
    return { kind: 'progress-db', message: msg.message };
  }
  if (msg.event === 'done' && msg.result) {
    return { kind: 'done', result: msg.result as ScanGoogleSheetResult | SyncResult };
  }
  return null;
}

async function streamSheetScan(url: string, onProgress: (message: string) => void): Promise<ScanGoogleSheetResult | null> {
  onProgress('Scanning starting…');
  const res = await fetch('/api/sync-sheet/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    let errText = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) errText = j.error;
    } catch {
      // ignore parse fallback
    }
    throw new Error(errText);
  }
  if (!res.body) throw new Error('No response from server');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult: ScanGoogleSheetResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      const parsed = parseSyncNdjsonLine(line);
      if (!parsed) continue;
      if (parsed.kind === 'progress-status') onProgress(parsed.message);
      if (parsed.kind === 'progress-sheet') onProgress(`Tab ${parsed.current}/${parsed.total}: ${parsed.title}`);
      if (parsed.kind === 'done') finalResult = parsed.result as ScanGoogleSheetResult;
    }
  }

  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) {
    const parsed = parseSyncNdjsonLine(tail);
    if (parsed) {
      if (parsed.kind === 'progress-status') onProgress(parsed.message);
      if (parsed.kind === 'progress-sheet') onProgress(`Tab ${parsed.current}/${parsed.total}: ${parsed.title}`);
      if (parsed.kind === 'done') finalResult = parsed.result as ScanGoogleSheetResult;
    }
  }

  return finalResult;
}

export default function GroupCard({
  id,
  name,
  spreadsheetUrl,
  syncCompleted,
}: {
  id: string;
  name: string;
  spreadsheetUrl: string | null;
  syncCompleted: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [sheetPanelOpen, setSheetPanelOpen] = useState(false);
  const [sheetUrlInput, setSheetUrlInput] = useState('');
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sheetMismatches, setSheetMismatches] = useState<string[]>([]);
  const [sheetPending, startSheetTransition] = useTransition();
  const [isScanning, setIsScanning] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [progressMessage, setProgressMessage] = useState('');
  const [scanResult, setScanResult] = useState<Extract<ScanGoogleSheetResult, { success: true }> | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [previewScanError, setPreviewScanError] = useState('');
  const [importDbLog, setImportDbLog] = useState<string[]>([]);
  const [importRequiresResync, setImportRequiresResync] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  const openDetails = () => {
    if (isModalOpen) return;
    router.push(`/groups/${id}`);
  };

  const onDelete = () => {
    setOpen(false);
    if (!window.confirm(`Delete group "${name}" and all its sessions? This cannot be undone.`)) {
      return;
    }
    startTransition(async () => {
      const result = await deleteGroupAndRelatedData(id);
      if (!result.ok) {
        window.alert(result.error);
        return;
      }
      router.refresh();
    });
  };

  const scanFromGroupUrl = async () => {
    const url = spreadsheetUrl?.trim();
    if (!url) {
      setActionError('This group has no linked Google Sheet URL yet.');
      return;
    }
    setActionError('');
    setPreviewScanError('');
    setOpen(false);
    setIsScanning(true);
    setImportDbLog([]);
    try {
      const finalResult = await streamSheetScan(url, setProgressMessage);
      if (finalResult?.success) {
        setScanResult(finalResult as Extract<ScanGoogleSheetResult, { success: true }>);
        setImportRequiresResync(false);
        setIsModalOpen(true);
      } else if (finalResult) {
        setActionError((finalResult as { success: false; error: string }).error || 'Failed to scan');
      } else {
        setActionError('Scan finished without a result');
      }
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to scan');
    } finally {
      setIsScanning(false);
      setProgressMessage('');
    }
  };

  const handleResync = async () => {
    const url = spreadsheetUrl?.trim();
    if (!url) return;
    setIsScanning(true);
    setPreviewScanError('');
    setActionError('');
    setImportDbLog([]);
    try {
      const finalResult = await streamSheetScan(url, setProgressMessage);
      if (finalResult?.success) {
        setScanResult(finalResult as Extract<ScanGoogleSheetResult, { success: true }>);
        setImportRequiresResync(false);
      } else if (finalResult) {
        setPreviewScanError((finalResult as { success: false; error: string }).error || 'Failed to scan');
      } else {
        setPreviewScanError('Scan finished without a result');
      }
    } catch (err: unknown) {
      setPreviewScanError(err instanceof Error ? err.message : 'Failed to scan');
    } finally {
      setIsScanning(false);
      setProgressMessage('');
    }
  };

  const handleImport = async (
    skippedRowsBySheet: SkippedRowsBySheet,
    skippedAttendanceCellsBySheet: SkippedAttendanceCellsBySheet,
    teacherAliasResolutions: TeacherAliasResolution[],
    studentAliasResolutions: StudentAliasResolution[],
    newTeacherCreateAcknowledgements: string[],
    workbookClassType?: WorkbookClassType
  ) => {
    if (!scanResult) return;
    setIsImporting(true);
    setActionError('');
    setImportDbLog([]);
    setProgressMessage('Importing starting…');
    let finalResult: SyncResult | null = null;

    try {
      const reviewSnapshot =
        typeof structuredClone === 'function'
          ? structuredClone(scanResult)
          : JSON.parse(JSON.stringify(scanResult));
      const res = await fetch('/api/sync-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewSnapshot,
          skippedRowsBySheet,
          skippedAttendanceCellsBySheet,
          teacherAliasResolutions,
          newTeacherCreateAcknowledgements,
          studentAliasResolutions,
          ...(workbookClassType != null ? { workbookClassType } : {}),
        }),
      });
      if (!res.ok) {
        let errText = res.statusText;
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error) errText = j.error;
        } catch {
          // ignore parse fallback
        }
        setActionError(errText);
        return;
      }
      if (!res.body) {
        setActionError('No response from server');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const nl = buffer.indexOf('\n');
          if (nl < 0) break;
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          const parsed = parseSyncNdjsonLine(line);
          if (!parsed) continue;
          if (parsed.kind === 'progress-status') setProgressMessage(parsed.message);
          if (parsed.kind === 'progress-sheet') {
            setProgressMessage(`Tab ${parsed.current}/${parsed.total}: ${parsed.title}`);
          }
          if (parsed.kind === 'progress-db') {
            setImportDbLog((prev) => [...prev, parsed.message]);
          }
          if (parsed.kind === 'done') finalResult = parsed.result as SyncResult;
        }
      }

      buffer += decoder.decode();
      const tail = buffer.trim();
      if (tail) {
        const parsed = parseSyncNdjsonLine(tail);
        if (parsed) {
          if (parsed.kind === 'progress-status') setProgressMessage(parsed.message);
          if (parsed.kind === 'progress-sheet') {
            setProgressMessage(`Tab ${parsed.current}/${parsed.total}: ${parsed.title}`);
          }
          if (parsed.kind === 'progress-db') {
            setImportDbLog((prev) => [...prev, parsed.message]);
          }
          if (parsed.kind === 'done') finalResult = parsed.result as SyncResult;
        }
      }

      if (finalResult?.success) {
        setImportRequiresResync(true);
        router.refresh();
      } else if (finalResult) {
        setActionError(finalResult.error || 'Failed to sync');
      } else {
        setActionError('Sync finished without a result');
      }
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to sync');
    } finally {
      setIsImporting(false);
      setProgressMessage('');
    }
  };

  return (
    <div
      className="bg-surface-container-lowest border border-outline-variant/10 rounded-2xl p-6 shadow-sm hover:shadow-md transition-all hover:-translate-y-1 hover:border-primary/30 h-full flex flex-col justify-between group cursor-pointer"
      onClick={openDetails}
      onKeyDown={(event) => {
        if (isModalOpen) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openDetails();
        }
      }}
      role="link"
      tabIndex={0}
      aria-label={`Open group ${name}, ${syncCompleted ? 'import completed' : 'import not completed'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 pr-2">
          <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mb-4 text-primary group-hover:bg-primary group-hover:text-white transition-colors">
            <span className="material-symbols-outlined">workspaces</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <h3 className="text-xl font-bold text-on-surface">{name}</h3>
            <SyncCompletionPill completed={syncCompleted} />
          </div>
          {spreadsheetUrl ? (
            <a
              href={spreadsheetUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              className="inline-flex items-center justify-center h-9 w-9 rounded-lg border border-outline-variant/20 hover:bg-green-50/80 hover:border-green-200/60 dark:hover:bg-green-950/30 dark:hover:border-green-800/50 transition-colors mt-2 p-1.5"
              aria-label={`Open Google Sheet for ${name}`}
              title={spreadsheetUrl}
            >
              <GoogleSheetsLogo className="h-[22px] w-[22px] shrink-0" />
            </a>
          ) : (
            <div
              className="mt-2 space-y-2"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {!sheetPanelOpen ? (
                <button
                  type="button"
                  onClick={() => {
                    setSheetError(null);
                    setSheetMismatches([]);
                    setSheetPanelOpen(true);
                  }}
                  className="text-xs font-semibold text-primary hover:underline underline-offset-2 rounded-md py-1 -my-1 px-0 text-left"
                >
                  Add Google Sheet URL
                </button>
              ) : (
                <form
                  className="space-y-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    setSheetError(null);
                    setSheetMismatches([]);
                    startSheetTransition(async () => {
                      const result = await attachGroupSpreadsheet(id, sheetUrlInput);
                      if (!result.ok) {
                        setSheetError(result.error);
                        setSheetMismatches(result.mismatches ?? []);
                        return;
                      }
                      setSheetPanelOpen(false);
                      setSheetUrlInput('');
                      router.refresh();
                    });
                  }}
                >
                  <label className="sr-only" htmlFor={`group-sheet-url-${id}`}>
                    Google Sheets URL for {name}
                  </label>
                  <input
                    id={`group-sheet-url-${id}`}
                    type="url"
                    name="spreadsheetUrl"
                    value={sheetUrlInput}
                    onChange={(event) => setSheetUrlInput(event.target.value)}
                    placeholder="https://docs.google.com/spreadsheets/d/…"
                    disabled={sheetPending}
                    className="w-full rounded-lg border border-outline-variant/25 bg-surface-container-low px-3 py-2 text-xs text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/40"
                    autoComplete="off"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="submit"
                      disabled={sheetPending || !sheetUrlInput.trim()}
                      className="rounded-lg bg-primary text-on-primary px-3 py-1.5 text-xs font-semibold disabled:opacity-50 hover:opacity-90 transition-opacity"
                    >
                      {sheetPending ? 'Linking…' : 'Link spreadsheet'}
                    </button>
                    <button
                      type="button"
                      disabled={sheetPending}
                      onClick={() => {
                        setSheetPanelOpen(false);
                        setSheetError(null);
                        setSheetMismatches([]);
                        setSheetUrlInput('');
                      }}
                      className="text-xs font-medium text-on-surface-variant hover:text-on-surface px-2 py-1.5 rounded-lg"
                    >
                      Cancel
                    </button>
                  </div>
                  <p className="text-[11px] leading-snug text-on-surface-variant/80">
                    The file title must match <span className="font-medium text-on-surface-variant">{name}</span>.
                    If this group has courses, each course needs a visible tab with the same name (case and spacing
                    normalized). Extra tabs in the workbook are ignored.
                  </p>
                  {sheetError ? (
                    <div className="rounded-lg border border-red-200/80 dark:border-red-900/50 bg-red-50/60 dark:bg-red-950/25 px-2.5 py-2 space-y-1.5" role="alert">
                      <p className="text-[11px] font-semibold leading-snug text-red-800 dark:text-red-300">
                        {sheetError}
                      </p>
                      {sheetMismatches.length > 0 ? (
                        <ul className="text-[11px] leading-snug text-red-800/90 dark:text-red-200/90 list-disc pl-4 space-y-1">
                          {sheetMismatches.map((line, i) => (
                            <li key={i}>{line}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                </form>
              )}
            </div>
          )}
        </div>

        <div className="relative" ref={rootRef}>
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setOpen((v) => !v);
            }}
            disabled={pending}
            className="h-9 w-9 rounded-lg border border-outline-variant/20 text-on-surface-variant hover:bg-surface-container-low transition-colors disabled:opacity-50 inline-flex items-center justify-center"
            aria-label={`Open actions for group ${name}`}
            aria-haspopup="menu"
            aria-expanded={open}
          >
            <span className="material-symbols-outlined text-[18px]">more_vert</span>
          </button>

          {open ? (
            <div
              className="absolute right-0 mt-2 min-w-[160px] rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-lg z-50 p-1"
              role="menu"
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              <button
                type="button"
                onClick={() => {
                  void scanFromGroupUrl();
                }}
                disabled={pending || isScanning || isImporting || !spreadsheetUrl}
                className="w-full rounded-lg px-3 py-2 text-left text-sm font-semibold text-on-surface hover:bg-surface-container-low disabled:opacity-50 inline-flex items-center gap-2"
                role="menuitem"
              >
                <span className="material-symbols-outlined text-[16px]">sync</span>
                {isScanning ? 'Scanning…' : 'Resync group'}
              </button>
              <button
                type="button"
                onClick={onDelete}
                disabled={pending || isScanning || isImporting}
                className="w-full rounded-lg px-3 py-2 text-left text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50 inline-flex items-center gap-2"
                role="menuitem"
              >
                <span className="material-symbols-outlined text-[16px]">delete</span>
                {pending ? 'Deleting…' : 'Delete group'}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {actionError ? (
        <p className="mt-3 text-xs font-semibold text-error" onClick={(event) => event.stopPropagation()}>
          {actionError}
        </p>
      ) : null}

      <p className="text-sm text-primary font-medium flex items-center gap-1 mt-4">
        View Details
        <span className="material-symbols-outlined text-sm group-hover:translate-x-1 transition-transform">
          arrow_forward
        </span>
      </p>

      <ScanPreviewModal
        isOpen={isModalOpen}
        scanResult={scanResult}
        onClose={() => {
          setPreviewScanError('');
          setIsModalOpen(false);
        }}
        onConfirm={handleImport}
        isImporting={isImporting}
        importProgressMessage={isImporting ? progressMessage : ''}
        importDbLog={importDbLog}
        onResync={handleResync}
        isResyncing={isScanning}
        resyncProgressMessage={progressMessage}
        resyncError={previewScanError}
        importRequiresResync={importRequiresResync}
      />
    </div>
  );
}
