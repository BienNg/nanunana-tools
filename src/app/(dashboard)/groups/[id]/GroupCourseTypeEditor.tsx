'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { updateGroupClassType } from '@/app/actions/updateGroupClassType';
import { updateGroupDefaultDuration } from '@/app/actions/updateGroupDefaultDuration';
import {
  formatMinutesAsHoursInput,
  GROUP_CLASS_TYPE_OPTIONS,
  normalizeGroupClassType,
  usesFixedDurationByClassType,
} from '@/lib/courseDuration';

type Props = {
  groupId: string;
  currentClassType: string | null;
  currentDefaultLessonMinutes: number | null;
};

export default function GroupCourseTypeEditor({
  groupId,
  currentClassType,
  currentDefaultLessonMinutes,
}: Props) {
  const router = useRouter();
  const [pendingClassType, startClassTypeTransition] = useTransition();
  const [pendingDuration, startDurationTransition] = useTransition();
  const [value, setValue] = useState(currentClassType ?? '');
  const [durationHours, setDurationHours] = useState(formatMinutesAsHoursInput(currentDefaultLessonMinutes));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(currentClassType ?? '');
  }, [currentClassType]);

  useEffect(() => {
    setDurationHours(formatMinutesAsHoursInput(currentDefaultLessonMinutes));
  }, [currentDefaultLessonMinutes]);

  const classTypeForRules = normalizeGroupClassType(value);
  const canCustomizeDefaultDuration = !usesFixedDurationByClassType(classTypeForRules);

  const onSelectChange = (next: string) => {
    const serverValue = currentClassType ?? '';
    if (next === serverValue) return;

    setError(null);
    setValue(next);
    startClassTypeTransition(async () => {
      const result = await updateGroupClassType(groupId, next || null);
      if (!result.ok) {
        setError(result.error);
        setValue(serverValue);
        return;
      }
      router.refresh();
    });
  };

  const onSaveDuration = () => {
    setError(null);
    startDurationTransition(async () => {
      const result = await updateGroupDefaultDuration(groupId, durationHours.trim() || null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  const isDurationDirty = durationHours.trim() !== formatMinutesAsHoursInput(currentDefaultLessonMinutes);
  const disableDurationSave = pendingDuration || !isDurationDirty;

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
      <label className="text-sm font-semibold text-on-surface-variant">Course type</label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={value}
          onChange={(e) => onSelectChange(e.target.value)}
          disabled={pendingClassType}
          className="min-w-[160px] rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm font-medium text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
          aria-label="Course type"
        >
          <option value="">Not set</option>
          {GROUP_CLASS_TYPE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {pendingClassType ? (
          <span className="text-xs font-medium text-on-surface-variant" aria-live="polite">
            Saving…
          </span>
        ) : null}
      </div>
      {canCustomizeDefaultDuration ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm font-semibold text-on-surface-variant" htmlFor={`group-duration-${groupId}`}>
            Default duration (hours)
          </label>
          <input
            id={`group-duration-${groupId}`}
            type="number"
            inputMode="decimal"
            min="0.25"
            step="0.25"
            value={durationHours}
            onChange={(e) => setDurationHours(e.target.value)}
            disabled={pendingDuration}
            placeholder={classTypeForRules === 'M' ? '1.25' : 'e.g. 1.5'}
            className="w-28 rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2 text-sm font-medium text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
          />
          <button
            type="button"
            onClick={onSaveDuration}
            disabled={disableDurationSave}
            className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-on-primary disabled:cursor-not-allowed disabled:opacity-55"
          >
            {pendingDuration ? 'Saving…' : 'Save'}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="text-xs text-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
