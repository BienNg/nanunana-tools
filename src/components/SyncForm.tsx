'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import ScanPreviewModal from './ScanPreviewModal';
import SheetSyncProgressOverlay from './SheetSyncProgressOverlay';
import type {
  ScanGoogleSheetResult,
  SkippedAttendanceCellsBySheet,
  SkippedRowsBySheet,
  TeacherAliasResolution,
  WorkbookClassType,
  SyncGoogleSheetResult,
} from '@/lib/sync/googleSheetSync';
import type { StudentAliasResolution } from '@/lib/sync/googleSheetStudentSync';

type SyncResult = SyncGoogleSheetResult;

type NdjsonLine =
  | { kind: 'progress-status'; message: string }
  | { kind: 'progress-sheet'; title: string; current: number; total: number }
  | { kind: 'progress-db'; message: string }
  | { kind: 'done'; result: ScanGoogleSheetResult }
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
    return { kind: 'done', result: msg.result as ScanGoogleSheetResult };
  }
  return null;
}

async function streamSheetScan(
  source: { url?: string; file?: File | null },
  onProgress: (message: string, currentTab?: number, totalTabs?: number) => void,
  options?: { startMessage?: string; signal?: AbortSignal }
): Promise<ScanGoogleSheetResult | null> {
  onProgress(options?.startMessage ?? 'Scanning starting…');
  const signal = options?.signal;
  const req =
    source.file != null
      ? (() => {
          const formData = new FormData();
          formData.set('file', source.file);
          return { method: 'POST' as const, body: formData, ...(signal ? { signal } : {}) };
        })()
      : {
          method: 'POST' as const,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: source.url ?? '' }),
          ...(signal ? { signal } : {}),
        };
  const res = await fetch('/api/sync-sheet/scan', req);

  if (!res.ok) {
    let errText = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) errText = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(errText);
  }

  if (!res.body) {
    throw new Error('No response from server');
  }

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
      if (parsed.kind === 'progress-sheet') {
        onProgress(`Tab ${parsed.current}/${parsed.total}: ${parsed.title}`, parsed.current, parsed.total);
      }
      if (parsed.kind === 'done') finalResult = parsed.result;
    }
  }
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) {
    const parsed = parseSyncNdjsonLine(tail);
    if (parsed) {
      if (parsed.kind === 'progress-status') onProgress(parsed.message);
      if (parsed.kind === 'progress-sheet') {
        onProgress(`Tab ${parsed.current}/${parsed.total}: ${parsed.title}`, parsed.current, parsed.total);
      }
      if (parsed.kind === 'done') finalResult = parsed.result;
    }
  }

  return finalResult;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export default function SyncForm({ onSyncComplete }: { onSyncComplete: () => void }) {
  const router = useRouter();
  const loadAbortRef = useRef<AbortController | null>(null);
  const [mounted, setMounted] = useState(false);
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState('');
  const [progressMessage, setProgressMessage] = useState('');
  const [sheetProgressTab, setSheetProgressTab] = useState(0);
  const [sheetProgressTotal, setSheetProgressTotal] = useState(1);

  const [scanResult, setScanResult] = useState<Extract<ScanGoogleSheetResult, { success: true }> | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [previewScanError, setPreviewScanError] = useState('');
  const [importDbLog, setImportDbLog] = useState<string[]>([]);
  const [importRequiresResync, setImportRequiresResync] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const applyScanProgress = (msg: string, currentTab?: number, totalTabs?: number) => {
    setProgressMessage(msg);
    if (currentTab !== undefined) setSheetProgressTab(currentTab);
    if (totalTabs !== undefined) setSheetProgressTotal(totalTabs);
  };

  const handleLoadOverlayClose = () => {
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    setIsScanning(false);
    setIsImporting(false);
    setProgressMessage('');
    setSheetProgressTab(0);
    setSheetProgressTotal(1);
  };

  const handleScan = async () => {
    if (!url && !file) return;
    loadAbortRef.current?.abort();
    const ac = new AbortController();
    loadAbortRef.current = ac;
    setIsScanning(true);
    setError('');
    setPreviewScanError('');
    setSheetProgressTab(0);
    setSheetProgressTotal(1);
    try {
      const finalResult = await streamSheetScan({ url, file }, applyScanProgress, { signal: ac.signal });
      if (finalResult?.success) {
        setScanResult(finalResult as Extract<ScanGoogleSheetResult, { success: true }>);
        setImportRequiresResync(false);
        setIsModalOpen(true);
      } else if (finalResult) {
        setError((finalResult as { success: false; error: string }).error || 'Failed to scan');
      } else {
        setError('Scan finished without a result');
      }
    } catch (err: unknown) {
      if (isAbortError(err)) {
        setError('');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to scan');
      }
    } finally {
      setIsScanning(false);
      setProgressMessage('');
      setSheetProgressTab(0);
      setSheetProgressTotal(1);
      loadAbortRef.current = null;
    }
  };

  const handleResync = async () => {
    if (!url && !file) return;
    loadAbortRef.current?.abort();
    const ac = new AbortController();
    loadAbortRef.current = ac;
    setIsScanning(true);
    setPreviewScanError('');
    setError('');
    setSheetProgressTab(0);
    setSheetProgressTotal(1);
    try {
      const finalResult = await streamSheetScan({ url, file }, applyScanProgress, {
        startMessage: 'Rescanning sheet…',
        signal: ac.signal,
      });
      if (finalResult?.success) {
        setScanResult(finalResult as Extract<ScanGoogleSheetResult, { success: true }>);
        setImportRequiresResync(false);
      } else if (finalResult) {
        setPreviewScanError((finalResult as { success: false; error: string }).error || 'Failed to scan');
      } else {
        setPreviewScanError('Scan finished without a result');
      }
    } catch (err: unknown) {
      if (!isAbortError(err)) {
        setPreviewScanError(err instanceof Error ? err.message : 'Failed to scan');
      }
    } finally {
      setIsScanning(false);
      setProgressMessage('');
      setSheetProgressTab(0);
      setSheetProgressTotal(1);
      loadAbortRef.current = null;
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
    loadAbortRef.current?.abort();
    const ac = new AbortController();
    loadAbortRef.current = ac;
    setIsImporting(true);
    setError('');
    setImportDbLog([]);
    setProgressMessage('Importing starting…');
    setSheetProgressTab(0);
    setSheetProgressTotal(1);
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
        signal: ac.signal,
      });

      if (!res.ok) {
        let errText = res.statusText;
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error) errText = j.error;
        } catch {
          /* ignore */
        }
        setError(errText);
        setIsImporting(false);
        return;
      }

      if (!res.body) {
        setError('No response from server');
        setIsImporting(false);
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
            setSheetProgressTab(parsed.current);
            setSheetProgressTotal(parsed.total);
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
            setSheetProgressTab(parsed.current);
            setSheetProgressTotal(parsed.total);
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
        onSyncComplete();
      } else if (finalResult) {
        setError(finalResult.error || 'Failed to sync');
      } else {
        setError('Sync finished without a result');
      }
    } catch (err: unknown) {
      if (!isAbortError(err)) {
        setError(err instanceof Error ? err.message : 'Failed to sync');
      }
    } finally {
      setIsImporting(false);
      setProgressMessage('');
      setSheetProgressTab(0);
      setSheetProgressTotal(1);
      loadAbortRef.current = null;
    }
  };

  const isLoading = isScanning || isImporting;
  const sheetProgressPercent =
    sheetProgressTotal > 0 ? Math.min(100, (sheetProgressTab / sheetProgressTotal) * 100) : 0;

  return (
    <>
      {mounted && isLoading ? (
        <SheetSyncProgressOverlay
          mounted={mounted}
          title="Google Sheets sync"
          headline={isImporting ? 'Importing changes…' : 'Scanning workbook…'}
          progressPercent={sheetProgressPercent}
          statusLine={progressMessage}
          onClose={handleLoadOverlayClose}
        />
      ) : null}
      <div className="flex flex-col gap-2 min-w-[420px]">
        <div className="bg-surface-container-low p-5 rounded-2xl flex items-center space-x-4 shadow-sm relative">
          <div className="bg-white p-3 rounded-xl shadow-sm">
            <span className="material-symbols-outlined text-green-600">table_chart</span>
          </div>
          <div className="flex-1 min-w-0">
            <label className="block text-[10px] uppercase tracking-widest font-bold text-on-surface-variant mb-1">
              Google Sheets Source
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (e.target.value.trim()) setFile(null);
              }}
              placeholder="Google Sheets URL (or select .xlsx below)"
              disabled={isLoading}
              className="w-full bg-transparent border-none p-0 text-sm focus:ring-0 placeholder:text-slate-400 focus:outline-none disabled:opacity-60"
            />
            <input
              type="file"
              accept=".xlsx"
              disabled={isLoading}
              onChange={(e) => {
                const picked = e.target.files?.[0] ?? null;
                setFile(picked);
                if (picked) setUrl('');
              }}
              className="mt-2 block w-full text-xs text-on-surface-variant file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-2 file:py-1 file:text-primary disabled:opacity-60"
            />
          </div>
          <button
            type="button"
            onClick={handleScan}
            disabled={isLoading || (!url && !file)}
            className="shrink-0 bg-primary text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-primary-container transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Sync
          </button>
          {error && (
            <div className="absolute -bottom-6 left-0 text-xs font-bold text-error">
              {error}
            </div>
          )}
        </div>
      </div>

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
    </>
  );
}
