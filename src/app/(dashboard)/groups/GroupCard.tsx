'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { attachGroupSpreadsheet } from '@/app/actions/attachGroupSpreadsheet';
import { deleteGroupAndRelatedData } from '@/app/actions/deleteGroup';
import { GoogleSheetsLogo } from '@/components/icons/GoogleSheetsLogo';
import { SyncCompletionPill } from '@/components/SyncCompletionPill';

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
