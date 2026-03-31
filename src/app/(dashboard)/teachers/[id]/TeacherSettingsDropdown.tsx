'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { updateTeacherStatus, type TeacherStatus } from '@/app/actions/updateTeacherStatus';

export default function TeacherSettingsDropdown({
  teacherId,
  status,
}: {
  teacherId: string;
  status: TeacherStatus;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const nextStatus: TeacherStatus = status === 'active' ? 'inactive' : 'active';
  const actionLabel = status === 'active' ? 'Inactive' : 'Active';

  const onToggleStatus = () => {
    setError(null);
    startTransition(async () => {
      const result = await updateTeacherStatus(teacherId, nextStatus);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-center w-10 h-10 rounded-xl border border-outline-variant/15 bg-surface-container-lowest text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface transition-colors shadow-sm"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Teacher settings"
      >
        <span className="material-symbols-outlined text-[22px]" aria-hidden>
          settings
        </span>
      </button>
      {open ? (
        <div
          className="absolute right-0 mt-2 min-w-[220px] rounded-xl border border-outline-variant/20 bg-surface-container-lowest py-2 shadow-lg z-50"
          role="menu"
        >
          <div className="px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-on-surface-variant border-b border-outline-variant/10 mb-2">
            Status:{' '}
            <span className="text-on-surface normal-case font-bold">
              {status === 'active' ? 'Active' : 'Inactive'}
            </span>
          </div>
          <button
            type="button"
            role="menuitem"
            disabled={pending}
            onClick={onToggleStatus}
            className="w-full text-left px-3 py-2 text-sm font-semibold text-on-surface hover:bg-surface-container-low transition-colors disabled:opacity-50"
          >
            {pending ? 'Saving…' : actionLabel}
          </button>
          {error ? (
            <p className="px-3 pt-1 text-xs text-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
