'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { deleteGroupAndRelatedData } from '@/app/actions/deleteGroup';
import { GoogleSheetsLogo } from '@/components/icons/GoogleSheetsLogo';

export default function GroupCard({
  id,
  name,
  spreadsheetUrl,
}: {
  id: string;
  name: string;
  spreadsheetUrl: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
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

  return (
    <div
      className="bg-surface-container-lowest border border-outline-variant/10 rounded-2xl p-6 shadow-sm hover:shadow-md transition-all hover:-translate-y-1 hover:border-primary/30 h-full flex flex-col justify-between group cursor-pointer"
      onClick={openDetails}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openDetails();
        }
      }}
      role="link"
      tabIndex={0}
      aria-label={`Open group ${name}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 pr-2">
          <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mb-4 text-primary group-hover:bg-primary group-hover:text-white transition-colors">
            <span className="material-symbols-outlined">workspaces</span>
          </div>
          <h3 className="text-xl font-bold text-on-surface mb-2">{name}</h3>
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
            <p className="text-xs text-on-surface-variant/70 mt-1">No Google Sheet URL</p>
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
                onClick={onDelete}
                disabled={pending}
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

      <p className="text-sm text-primary font-medium flex items-center gap-1 mt-4">
        View Details
        <span className="material-symbols-outlined text-sm group-hover:translate-x-1 transition-transform">
          arrow_forward
        </span>
      </p>
    </div>
  );
}
