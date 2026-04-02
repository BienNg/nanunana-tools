'use client';

import { type MouseEvent, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { deleteCourseAndOrphans } from '@/app/actions/deleteCourse';
import { updateCourseSyncCompleted } from '@/app/actions/updateCourseSyncCompleted';

export default function CourseActionsMenu({
  courseId,
  courseName,
  syncCompleted,
}: {
  courseId: string;
  courseName: string;
  syncCompleted: boolean;
}) {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [pendingAction, setPendingAction] = useState<'toggle-completion' | 'delete' | null>(null);

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

  function onDelete(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setOpen(false);
    if (!window.confirm(`Delete course "${courseName}" and related sessions? This cannot be undone.`)) {
      return;
    }
    startTransition(async () => {
      setPendingAction('delete');
      const result = await deleteCourseAndOrphans(courseId);
      setPendingAction(null);
      if (!result.ok) {
        window.alert(result.error);
        return;
      }
      router.refresh();
    });
  }

  function onToggleCompletion(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setOpen(false);
    startTransition(async () => {
      setPendingAction('toggle-completion');
      const result = await updateCourseSyncCompleted(courseId, !syncCompleted);
      setPendingAction(null);
      if (!result.ok) {
        window.alert(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div
      className="relative"
      ref={rootRef}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={pending}
        className="h-9 w-9 rounded-lg border border-outline-variant/20 text-on-surface-variant hover:bg-surface-container-low transition-colors disabled:opacity-50 inline-flex items-center justify-center"
        aria-label={`Open actions for course ${courseName}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="material-symbols-outlined text-[18px]">more_vert</span>
      </button>
      {open ? (
        <div
          className="absolute right-0 mt-2 min-w-[160px] rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-lg z-50 p-1"
          role="menu"
        >
          <button
            type="button"
            onClick={onToggleCompletion}
            disabled={pending}
            className="w-full rounded-lg px-3 py-2 text-left text-sm font-semibold text-on-surface hover:bg-surface-container-low disabled:opacity-50 inline-flex items-center gap-2"
            role="menuitem"
          >
            <span className="material-symbols-outlined text-[16px]">
              {syncCompleted ? 'unpublished' : 'task_alt'}
            </span>
            {pendingAction === 'toggle-completion'
              ? 'Updating…'
              : syncCompleted
                ? 'Mark as not completed'
                : 'Mark as completed'}
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={pending}
            className="w-full rounded-lg px-3 py-2 text-left text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50 inline-flex items-center gap-2"
            role="menuitem"
          >
            <span className="material-symbols-outlined text-[16px]">delete</span>
            {pendingAction === 'delete' ? 'Deleting…' : 'Delete course'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
