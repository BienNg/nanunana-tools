'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

type AliasItem = { id: string; alias: string };
type StudentOption = { id: string; name: string };

export default function StudentAliasesManager({
  studentId,
  studentName,
  aliases,
  studentOptions,
}: {
  studentId: string;
  studentName: string;
  aliases: AliasItem[];
  studentOptions: StudentOption[];
}) {
  const router = useRouter();
  const [filterText, setFilterText] = useState('');
  const [selectedTargetStudentId, setSelectedTargetStudentId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const filteredStudents = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    return studentOptions.filter((s) => {
      if (s.id === studentId) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q);
    });
  }, [filterText, studentId, studentOptions]);

  const linkCurrentNameAsAlias = async () => {
    if (!selectedTargetStudentId || pending) return;
    setPending(true);
    setError('');
    try {
      const res = await fetch('/api/students/aliases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: selectedTargetStudentId, alias: studentName }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(json.error ?? 'Failed to link alias');
        return;
      }
      setSelectedTargetStudentId('');
      setFilterText('');
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
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Filter students..."
          disabled={pending}
          className="w-40 rounded border border-slate-300 px-2 py-1 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
        />
        <select
          value={selectedTargetStudentId}
          onChange={(e) => setSelectedTargetStudentId(e.target.value)}
          disabled={pending}
          className="max-w-48 rounded border border-slate-300 px-2 py-1 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          aria-label={`Select canonical student for ${studentName}`}
        >
          <option value="">Select student...</option>
          {filteredStudents.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void linkCurrentNameAsAlias()}
          disabled={pending || !selectedTargetStudentId}
          className="rounded bg-primary px-2 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          Link name
        </button>
      </div>
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
