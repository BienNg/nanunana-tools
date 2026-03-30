'use client';

import { useState } from 'react';
import ScanPreviewModal from './ScanPreviewModal';
import type { ScanGoogleSheetResult } from '@/lib/sync/googleSheetSync';

type SyncResult = { success: true; message: string } | { success: false; error: string };

type NdjsonLine =
  | { kind: 'progress-status'; message: string }
  | { kind: 'progress-sheet'; title: string; current: number; total: number }
  | { kind: 'progress-db'; message: string }
  | { kind: 'done'; result: any }
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
    return { kind: 'done', result: msg.result };
  }
  return null;
}

async function streamSheetScan(
  url: string,
  onProgress: (message: string) => void,
  options?: { startMessage?: string }
): Promise<ScanGoogleSheetResult | null> {
  onProgress(options?.startMessage ?? 'Scanning starting…');
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
        onProgress(`Tab ${parsed.current}/${parsed.total}: ${parsed.title}`);
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
        onProgress(`Tab ${parsed.current}/${parsed.total}: ${parsed.title}`);
      }
      if (parsed.kind === 'done') finalResult = parsed.result;
    }
  }

  return finalResult;
}

export default function SyncForm({ onSyncComplete }: { onSyncComplete: () => void }) {
  const [url, setUrl] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState('');
  const [progressMessage, setProgressMessage] = useState('');

  const [scanResult, setScanResult] = useState<Extract<ScanGoogleSheetResult, { success: true }> | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [previewScanError, setPreviewScanError] = useState('');
  const [importDbLog, setImportDbLog] = useState<string[]>([]);

  const handleScan = async () => {
    if (!url) return;
    setIsScanning(true);
    setError('');
    setPreviewScanError('');
    try {
      const finalResult = await streamSheetScan(url, setProgressMessage);
      if (finalResult?.success) {
        setScanResult(finalResult as Extract<ScanGoogleSheetResult, { success: true }>);
        setIsModalOpen(true);
      } else if (finalResult) {
        setError((finalResult as { success: false; error: string }).error || 'Failed to scan');
      } else {
        setError('Scan finished without a result');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to scan');
    } finally {
      setIsScanning(false);
      setProgressMessage('');
    }
  };

  const handleResync = async () => {
    if (!url) return;
    setIsScanning(true);
    setPreviewScanError('');
    setError('');
    try {
      const finalResult = await streamSheetScan(url, setProgressMessage, {
        startMessage: 'Rescanning sheet…',
      });
      if (finalResult?.success) {
        setScanResult(finalResult as Extract<ScanGoogleSheetResult, { success: true }>);
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

  const handleImport = async () => {
    if (!url) return;
    setIsImporting(true);
    setError('');
    setImportDbLog([]);
    setProgressMessage('Importing starting…');
    let finalResult: SyncResult | null = null;

    try {
      const res = await fetch('/api/sync-sheet', {
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
        onSyncComplete();
        setUrl('');
        setIsModalOpen(false);
        setScanResult(null);
      } else if (finalResult) {
        setError(finalResult.error || 'Failed to sync');
      } else {
        setError('Sync finished without a result');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to sync');
    } finally {
      setIsImporting(false);
      setProgressMessage('');
    }
  };

  const isLoading = isScanning || isImporting;

  return (
    <>
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
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              disabled={isLoading}
              className="w-full bg-transparent border-none p-0 text-sm focus:ring-0 placeholder:text-slate-400 focus:outline-none disabled:opacity-60"
            />
          </div>
          <button
            type="button"
            onClick={handleScan}
            disabled={isLoading || !url}
            className="shrink-0 bg-primary text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-primary-container transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isScanning ? (
              <>
                <span className="material-symbols-outlined animate-spin text-sm">sync</span>
                Scanning…
              </>
            ) : (
              'Sync'
            )}
          </button>
          {error && (
            <div className="absolute -bottom-6 left-0 text-xs font-bold text-error">
              {error}
            </div>
          )}
        </div>
        {isLoading && progressMessage && (
          <p
            className="text-xs text-on-surface-variant font-medium truncate px-1"
            role="status"
            aria-live="polite"
          >
            {progressMessage}
          </p>
        )}
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
      />
    </>
  );
}
