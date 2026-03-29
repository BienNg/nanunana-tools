'use client';

import { useState } from 'react';

type SyncResult = { success: true; message: string } | { success: false; error: string };

type NdjsonLine =
  | { kind: 'progress-status'; message: string }
  | { kind: 'progress-sheet'; title: string; current: number; total: number }
  | { kind: 'done'; result: SyncResult }
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
    result?: SyncResult;
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
  if (msg.event === 'done' && msg.result) {
    return { kind: 'done', result: msg.result };
  }
  return null;
}

export default function SyncForm({ onSyncComplete }: { onSyncComplete: () => void }) {
  const [url, setUrl] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState('');
  const [progressMessage, setProgressMessage] = useState('');

  const handleSync = async () => {
    if (!url) return;
    setIsSyncing(true);
    setError('');
    setProgressMessage('Starting…');
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
        return;
      }

      if (!res.body) {
        setError('No response from server');
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
          if (parsed.kind === 'done') finalResult = parsed.result;
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
          if (parsed.kind === 'done') finalResult = parsed.result;
        }
      }

      if (finalResult?.success) {
        onSyncComplete();
        setUrl('');
      } else if (finalResult) {
        setError(finalResult.error || 'Failed to sync');
      } else {
        setError('Sync finished without a result');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to sync');
    } finally {
      setIsSyncing(false);
      setProgressMessage('');
    }
  };

  return (
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
            disabled={isSyncing}
            className="w-full bg-transparent border-none p-0 text-sm focus:ring-0 placeholder:text-slate-400 focus:outline-none disabled:opacity-60"
          />
        </div>
        <button
          type="button"
          onClick={handleSync}
          disabled={isSyncing || !url}
          className="shrink-0 bg-primary text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-primary-container transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isSyncing ? (
            <>
              <span className="material-symbols-outlined animate-spin text-sm">sync</span>
              Syncing…
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
      {isSyncing && progressMessage && (
        <p
          className="text-xs text-on-surface-variant font-medium truncate px-1"
          role="status"
          aria-live="polite"
        >
          {progressMessage}
        </p>
      )}
    </div>
  );
}
