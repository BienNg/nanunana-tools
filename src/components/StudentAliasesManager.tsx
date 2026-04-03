'use client';

import { createPortal } from 'react-dom';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type AliasItem = { id: string; alias: string };
type StudentOption = { id: string; name: string; groupIds: string[] };

function charLength(value: string): number {
  return [...value.trim()].length;
}

export default function StudentAliasesManager({
  studentId,
  studentName,
  aliases,
  currentStudentGroupIds,
  studentOptions,
}: {
  studentId: string;
  studentName: string;
  aliases: AliasItem[];
  currentStudentGroupIds: string[];
  studentOptions: StudentOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [selectedTargetStudentId, setSelectedTargetStudentId] = useState('');
  const [tieWinnerStudentId, setTieWinnerStudentId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 240 });

  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  const currentGroupSet = useMemo(
    () => new Set(currentStudentGroupIds),
    [currentStudentGroupIds]
  );

  const { sameGroup, other } = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    const candidates = studentOptions.filter((s) => s.id !== studentId);
    const matches = candidates.filter((s) => !q || s.name.toLowerCase().includes(q));

    const same = matches.filter((s) => s.groupIds.some((gid) => currentGroupSet.has(gid)));
    const sameIds = new Set(same.map((s) => s.id));
    const rest = matches.filter((s) => !sameIds.has(s.id));

    same.sort((a, b) => a.name.localeCompare(b.name));
    rest.sort((a, b) => a.name.localeCompare(b.name));
    return { sameGroup: same, other: rest };
  }, [studentId, studentOptions, filterText, currentGroupSet]);

  const selectedLabel = useMemo(() => {
    if (!selectedTargetStudentId) return '';
    return studentOptions.find((s) => s.id === selectedTargetStudentId)?.name ?? '';
  }, [selectedTargetStudentId, studentOptions]);
  const selectedTargetStudent = useMemo(
    () => studentOptions.find((s) => s.id === selectedTargetStudentId) ?? null,
    [selectedTargetStudentId, studentOptions]
  );
  const isNameLengthTie = useMemo(() => {
    if (!selectedTargetStudent) return false;
    return charLength(selectedTargetStudent.name) === charLength(studentName);
  }, [selectedTargetStudent, studentName]);

  const updateMenuPosition = useCallback(() => {
    const el = buttonRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setMenuPos({
      top: rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, 200),
    });
  }, []);

  useLayoutEffect(() => {
    if (open) updateMenuPosition();
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => setOpen(false);
    /** Capture phase sees scrolls from nested scrollers; ignore scroll inside the dropdown list. */
    const onScrollCapture = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScrollCapture, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScrollCapture, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      queueMicrotask(() => filterInputRef.current?.focus());
    }
  }, [open]);

  const mergeStudents = async () => {
    if (!selectedTargetStudentId || pending) return;
    if (isNameLengthTie && !tieWinnerStudentId) {
      setError('Choose which student to keep because both names have the same length.');
      return;
    }
    setPending(true);
    setError('');
    try {
      const res = await fetch('/api/students/aliases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'merge',
          leftStudentId: studentId,
          rightStudentId: selectedTargetStudentId,
          ...(isNameLengthTie ? { tieWinnerStudentId } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok) {
        setError(json.error ?? 'Failed to merge students');
        if (json.code === 'TIE_CHOICE_REQUIRED' && !tieWinnerStudentId) {
          setError('Choose which student to keep because both names have the same length.');
        }
        return;
      }
      setSelectedTargetStudentId('');
      setTieWinnerStudentId('');
      setFilterText('');
      setOpen(false);
      router.refresh();
    } finally {
      setPending(false);
    }
  };

  const removeAlias = async (aliasId: string) => {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const res = await fetch('/api/students/aliases', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId, aliasId }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(json.error ?? 'Failed to remove alias');
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  };

  const pickStudent = (id: string) => {
    setSelectedTargetStudentId(id);
    setTieWinnerStudentId('');
    setOpen(false);
  };

  const toggleOpen = () => {
    if (pending) return;
    setOpen((v) => !v);
  };

  const dropdown =
    open &&
    typeof document !== 'undefined' &&
    createPortal(
      <div
        ref={menuRef}
        className="z-[100] max-h-72 overflow-hidden rounded-md border border-slate-300 bg-white text-left shadow-lg"
        style={{
          position: 'fixed',
          top: menuPos.top,
          left: menuPos.left,
          width: menuPos.width,
        }}
        role="listbox"
        aria-label={`Students to link for ${studentName}`}
      >
        <div className="border-b border-slate-200 p-1.5">
          <input
            ref={filterInputRef}
            type="search"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Filter students..."
            disabled={pending}
            className="w-full rounded border border-slate-300 px-2 py-1 text-xs text-slate-900 outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          />
        </div>
        <ul className="max-h-52 overflow-y-auto py-1">
          {sameGroup.length > 0 ? (
            <>
              <li className="px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                Same group
              </li>
              {sameGroup.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selectedTargetStudentId === s.id}
                    className="w-full px-2 py-1.5 text-left text-xs text-slate-900 hover:bg-slate-100"
                    onClick={() => pickStudent(s.id)}
                  >
                    {s.name}
                  </button>
                </li>
              ))}
            </>
          ) : null}
          {other.length > 0 ? (
            <>
              <li className="px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                Other students
              </li>
              {other.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selectedTargetStudentId === s.id}
                    className="w-full px-2 py-1.5 text-left text-xs text-slate-900 hover:bg-slate-100"
                    onClick={() => pickStudent(s.id)}
                  >
                    {s.name}
                  </button>
                </li>
              ))}
            </>
          ) : null}
          {sameGroup.length === 0 && other.length === 0 ? (
            <li className="px-2 py-3 text-center text-xs text-slate-500">No students match</li>
          ) : null}
        </ul>
      </div>,
      document.body
    );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {aliases.length > 0 ? (
          aliases.map((item) => (
            <span
              key={item.id}
              className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-700"
            >
              {item.alias}
              <button
                type="button"
                onClick={() => void removeAlias(item.id)}
                disabled={pending}
                className="rounded text-slate-500 hover:text-red-600 disabled:opacity-50"
                aria-label={`Remove alias ${item.alias}`}
                title={`Remove alias ${item.alias}`}
              >
                <span className="material-symbols-outlined text-sm leading-none">close</span>
              </button>
            </span>
          ))
        ) : (
          <span className="text-xs text-slate-500">No aliases</span>
        )}
      </div>
      <div className="flex items-start gap-2">
        <div className="relative min-w-[12rem] max-w-xs flex-1">
          <button
            ref={buttonRef}
            type="button"
            disabled={pending}
            onClick={toggleOpen}
            aria-haspopup="listbox"
            aria-expanded={open}
            className="flex w-full items-center justify-between gap-2 rounded border border-slate-300 bg-white px-2 py-1 text-left text-xs text-slate-900 outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
            aria-label={`Select canonical student for ${studentName}`}
          >
            <span className={selectedLabel ? 'text-slate-900' : 'text-slate-500'}>
              {selectedLabel || 'Select student...'}
            </span>
            <span className="material-symbols-outlined text-base text-slate-500" aria-hidden>
              {open ? 'expand_less' : 'expand_more'}
            </span>
          </button>
        </div>
        {dropdown}
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => void mergeStudents()}
            disabled={pending || !selectedTargetStudentId}
            className="rounded bg-primary px-2 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            Merge
          </button>
          {isNameLengthTie && selectedTargetStudent ? (
            <div className="space-y-1 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">
              <p className="font-semibold">Same length names: choose student to keep</p>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name={`tie-winner-${studentId}`}
                  value={studentId}
                  checked={tieWinnerStudentId === studentId}
                  onChange={(e) => setTieWinnerStudentId(e.target.value)}
                  disabled={pending}
                />
                <span>{studentName}</span>
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name={`tie-winner-${studentId}`}
                  value={selectedTargetStudent.id}
                  checked={tieWinnerStudentId === selectedTargetStudent.id}
                  onChange={(e) => setTieWinnerStudentId(e.target.value)}
                  disabled={pending}
                />
                <span>{selectedTargetStudent.name}</span>
              </label>
            </div>
          ) : null}
        </div>
      </div>
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
