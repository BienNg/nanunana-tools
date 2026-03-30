'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

export type TeacherMonthOption = { value: string; label: string };

export default function TeacherMonthDropdown({
  teacherId,
  months,
  selectedValue,
  selectedLabel,
}: {
  teacherId: string;
  months: TeacherMonthOption[];
  selectedValue: string;
  selectedLabel: string;
}) {
  const [open, setOpen] = useState(false);
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

  const hrefForMonth = (value: string) =>
    `/teachers/${teacherId}?month=${encodeURIComponent(value)}`;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-2 text-sm font-semibold text-primary rounded-lg hover:bg-primary/5 transition-colors"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Select month"
      >
        <span className="material-symbols-outlined text-base" aria-hidden>
          calendar_today
        </span>
        {selectedLabel}
        <span className="material-symbols-outlined text-base" aria-hidden>
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>
      {open ? (
        <ul
          className="absolute right-0 mt-1 min-w-[220px] max-h-64 overflow-y-auto rounded-xl border border-outline-variant/20 bg-surface-container-lowest py-1 shadow-lg z-50"
          role="listbox"
        >
          {months.length === 0 ? (
            <li className="px-3 py-2 text-sm text-on-surface-variant">
              No months with lessons yet
            </li>
          ) : (
            months.map((m) => (
              <li key={m.value} role="presentation">
                <Link
                  href={hrefForMonth(m.value)}
                  onClick={() => setOpen(false)}
                  role="option"
                  aria-selected={m.value === selectedValue}
                  className={`block px-3 py-2 text-sm font-medium hover:bg-surface-container-low transition-colors ${
                    m.value === selectedValue
                      ? 'bg-primary/10 text-primary font-bold'
                      : 'text-on-surface'
                  }`}
                >
                  {m.label}
                </Link>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
