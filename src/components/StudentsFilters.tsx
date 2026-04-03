'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

const SEARCH_DEBOUNCE_MS = 300;

type GroupOption = { id: string; name: string };

export default function StudentsFilters({ groups }: { groups: GroupOption[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const qFromUrl = searchParams.get('q') ?? '';
  const groupFromUrl = searchParams.get('group') ?? '';

  const [draft, setDraft] = useState(qFromUrl);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setDraft(qFromUrl);
  }, [qFromUrl]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const replaceUrl = useCallback(
    (q: string, group: string, resetPage: boolean) => {
      const params = new URLSearchParams();
      const qt = q.trim();
      if (qt) params.set('q', qt);
      if (group) params.set('group', group);
      if (!resetPage) {
        const p = searchParams.get('page');
        if (p) {
          const n = Number.parseInt(p, 10);
          if (Number.isFinite(n) && n > 1) params.set('page', String(n));
        }
      }
      const qs = params.toString();
      const href = qs ? `${pathname}?${qs}` : pathname;
      startTransition(() => {
        router.replace(href);
      });
    },
    [pathname, router, searchParams]
  );

  const commitSearch = useCallback(
    (q: string, group: string) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
      replaceUrl(q, group, true);
    },
    [replaceUrl]
  );

  const scheduleSearch = useCallback(
    (q: string, group: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        replaceUrl(q, group, true);
      }, SEARCH_DEBOUNCE_MS);
    },
    [replaceUrl]
  );

  const onSearchChange = (value: string) => {
    setDraft(value);
    scheduleSearch(value, groupFromUrl);
  };

  const onSearchBlur = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    if (draft.trim() === qFromUrl.trim()) return;
    replaceUrl(draft, groupFromUrl, true);
  };

  const onGroupChange = (nextGroup: string) => {
    commitSearch(draft, nextGroup);
  };

  const hasFilters = Boolean(qFromUrl.trim() || groupFromUrl);

  return (
    <div className="mb-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <div className="w-full md:max-w-md">
          <label
            htmlFor="students-search"
            className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-500"
          >
            Search
          </label>
          <input
            id="students-search"
            type="search"
            value={draft}
            onChange={(e) => onSearchChange(e.target.value)}
            onBlur={onSearchBlur}
            placeholder="Search students by name..."
            autoComplete="off"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <div className="w-full md:max-w-xs">
          <label
            htmlFor="students-group"
            className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-500"
          >
            Filter by group
          </label>
          <select
            id="students-group"
            value={groupFromUrl}
            onChange={(e) => onGroupChange(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            <option value="">All groups</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </div>
        {hasFilters ? (
          <Link
            href="/students"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Clear
          </Link>
        ) : null}
      </div>
    </div>
  );
}
