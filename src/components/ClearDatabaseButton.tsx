'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { clearAllDatabaseEntries } from '@/app/actions/clearDatabase';

export default function ClearDatabaseButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function onClick() {
    if (
      !window.confirm(
        'Delete ALL courses, students, lessons, and attendance from the database? This cannot be undone.'
      )
    ) {
      return;
    }
    setMessage(null);
    startTransition(async () => {
      const result = await clearAllDatabaseEntries();
      if (result.ok) {
        setMessage('Database cleared.');
        router.refresh();
      } else {
        setMessage(result.error);
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-800 shadow-sm transition-colors hover:bg-red-100 disabled:opacity-50"
      >
        {pending ? 'Clearing…' : 'Clear DB (dev)'}
      </button>
      {message ? (
        <span className="max-w-[200px] truncate text-xs text-slate-600" title={message}>
          {message}
        </span>
      ) : null}
    </div>
  );
}
