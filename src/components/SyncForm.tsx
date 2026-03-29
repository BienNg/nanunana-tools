'use client';

import { useState } from 'react';
import { syncGoogleSheet } from '@/app/actions/syncSheet';

export default function SyncForm({ onSyncComplete }: { onSyncComplete: () => void }) {
  const [url, setUrl] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState('');

  const handleSync = async () => {
    if (!url) return;
    setIsSyncing(true);
    setError('');
    try {
      const result = await syncGoogleSheet(url);
      if (result.success) {
        onSyncComplete();
        setUrl('');
      } else {
        setError(result.error || 'Failed to sync');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div className="bg-surface-container-low p-5 rounded-2xl flex items-center space-x-4 min-w-[420px] shadow-sm relative">
      <div className="bg-white p-3 rounded-xl shadow-sm">
        <span className="material-symbols-outlined text-green-600">table_chart</span>
      </div>
      <div className="flex-1">
        <label className="block text-[10px] uppercase tracking-widest font-bold text-on-surface-variant mb-1">
          Google Sheets Source
        </label>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://docs.google.com/spreadsheets/d/..."
          className="w-full bg-transparent border-none p-0 text-sm focus:ring-0 placeholder:text-slate-400 focus:outline-none"
        />
      </div>
      <button
        onClick={handleSync}
        disabled={isSyncing || !url}
        className="bg-primary text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-primary-container transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
      >
        {isSyncing ? (
          <>
            <span className="material-symbols-outlined animate-spin text-sm">sync</span>
            Syncing...
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
  );
}
