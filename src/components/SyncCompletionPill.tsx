export function SyncCompletionPill({ completed }: { completed: boolean }) {
  return (
    <span
      className={
        completed
          ? 'shrink-0 inline-flex items-center rounded-full bg-tertiary-container px-3 py-1 text-xs font-bold text-on-tertiary-container'
          : 'shrink-0 inline-flex items-center rounded-full bg-surface-container-high px-3 py-1 text-xs font-bold text-on-surface-variant'
      }
    >
      {completed ? 'Completed' : 'Not completed'}
    </span>
  );
}
