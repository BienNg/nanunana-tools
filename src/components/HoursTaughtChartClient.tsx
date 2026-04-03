'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';

type ChartData = {
  ym: string;
  label: string;
  minutes: number;
  hours: number;
  sessions?: number;
  groups?: number;
  courseStudentStacks?: Array<{ stackKey: string; students: number }>;
  classTypeHours: Array<{
    classType: 'Online_DE' | 'Online_VN' | 'Offline' | 'M' | 'A' | 'P' | 'Unknown';
    minutes: number;
    hours: number;
  }>;
  classTypeSessions?: Array<{
    classType: 'Online_DE' | 'Online_VN' | 'Offline' | 'M' | 'A' | 'P' | 'Unknown';
    sessions: number;
  }>;
  classTypeGroups?: Array<{
    classType: 'Online_DE' | 'Online_VN' | 'Offline' | 'M' | 'A' | 'P' | 'Unknown';
    groups: number;
  }>;
};

const CLASS_TYPE_STYLES: Record<ChartData['classTypeHours'][number]['classType'], string> = {
  Online_DE: 'bg-sky-500',
  Online_VN: 'bg-indigo-500',
  Offline: 'bg-emerald-500',
  M: 'bg-amber-500',
  A: 'bg-fuchsia-500',
  P: 'bg-rose-500',
  Unknown: 'bg-slate-500',
};

type ChartMetric = 'hours' | 'sessions' | 'groups' | 'students';

const METRIC_OPTIONS: { id: ChartMetric; label: string }[] = [
  { id: 'hours', label: 'Hours' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'groups', label: 'Groups' },
  { id: 'students', label: 'Students' },
];

const COURSE_STACK_SEGMENT_COLORS = [
  'bg-sky-500',
  'bg-indigo-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-fuchsia-500',
  'bg-rose-500',
  'bg-violet-500',
  'bg-teal-500',
  'bg-orange-500',
  'bg-cyan-500',
  'bg-lime-600',
  'bg-pink-500',
] as const;

export default function HoursTaughtChartClient({ data }: { data: ChartData[] }) {
  const [mounted, setMounted] = useState(false);
  const [metric, setMetric] = useState<ChartMetric>('hours');

  useEffect(() => {
    setMounted(true);
  }, []);

  const courseStackColorIndex = useMemo(() => {
    const keys = new Set<string>();
    for (const d of data) {
      for (const s of d.courseStudentStacks ?? []) {
        keys.add(s.stackKey);
      }
    }
    return new Map([...keys].sort((a, b) => a.localeCompare(b)).map((k, i) => [k, i]));
  }, [data]);

  const peakValue =
    metric === 'students'
      ? Math.max(
          0,
          ...data.map((d) => (d.courseStudentStacks ?? []).reduce((sum, s) => sum + s.students, 0))
        )
      : Math.max(
          0,
          ...data.map((d) =>
            metric === 'hours' ? d.hours : metric === 'sessions' ? (d.sessions ?? 0) : (d.groups ?? 0)
          )
        );
  const yAxisMax = Math.max(1, Math.ceil(peakValue));
  const yMid = yAxisMax / 2;

  // Formatting hours to 2 decimal places max
  const formatHours = (hours: number) => {
    const rounded = Math.round(hours * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toString();
  };
  const formatSessions = (sessions: number) => String(sessions ?? 0);
  const formatValue = (value: number) =>
    metric === 'students'
      ? String(Math.round(value))
      : metric === 'hours'
        ? formatHours(value)
        : formatSessions(value);
  const metricLabel =
    metric === 'hours'
      ? 'Hours'
      : metric === 'sessions'
        ? 'Sessions'
        : metric === 'groups'
          ? 'Groups'
          : 'Students';
  const metricTitle =
    metric === 'hours'
      ? 'Total Hours Taught'
      : metric === 'sessions'
        ? 'Total Sessions Taught'
        : metric === 'groups'
          ? 'Total Groups Taught'
          : 'Students per month';
  const studentsSubtitle =
    'Distinct students with a present lesson, stacked by course name (same label groups together). Totals sum across courses.';

  return (
    <div className="bg-surface-container-low rounded-[1rem] p-6 lg:p-8 flex flex-col border border-outline-variant/10 shadow-sm w-full h-full animate-fade-up">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-xl font-bold font-headline text-on-surface">{metricTitle}</h3>
          <p className="text-sm text-on-surface-variant font-medium mt-1">
            {metric === 'students' ? studentsSubtitle : 'Across all courses · Last 6 months'}
          </p>
        </div>
        <div
          role="tablist"
          aria-label="Chart metric"
          className="inline-flex w-full max-w-full shrink-0 rounded-xl border border-outline-variant/25 bg-surface-container/80 p-1 shadow-inner shadow-black/[0.03] backdrop-blur-sm sm:w-auto"
        >
          {METRIC_OPTIONS.map(({ id, label }) => {
            const selected = metric === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={selected}
                id={`chart-metric-${id}`}
                onClick={() => setMetric(id)}
                className="relative min-h-9 min-w-0 flex-1 rounded-lg px-2 py-2 text-center font-headline text-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-container-low sm:min-w-[4.25rem] sm:px-3 sm:text-sm"
              >
                {selected ? (
                  <motion.div
                    layoutId="hours-chart-metric-pill"
                    className="absolute inset-0 rounded-lg bg-primary shadow-sm shadow-primary/25"
                    transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                  />
                ) : null}
                <span
                  className={`relative z-10 block whitespace-nowrap ${
                    selected ? 'text-white' : 'text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 flex gap-4 items-end min-h-[280px]">
        {/* Y-Axis */}
        <div className="flex flex-col justify-between h-[200px] shrink-0 mb-8 text-xs font-semibold text-on-surface-variant tabular-nums text-right pr-2 w-12 border-r border-outline-variant/15">
          <span>{metric === 'hours' ? `${yAxisMax}h` : yAxisMax}</span>
          <span>
            {metric === 'hours'
              ? `${yMid % 1 === 0 ? yMid : yMid.toFixed(1)}h`
              : yMid % 1 === 0
                ? yMid
                : yMid.toFixed(1)}
          </span>
          <span>0</span>
        </div>

        {/* Chart Area */}
        <div className="flex-1 relative min-h-[260px] pb-1">
          {/* Grid lines */}
          <div className="absolute inset-x-0 top-0 h-[200px] flex flex-col justify-between pointer-events-none">
            <div className="h-px bg-outline-variant/15" />
            <div className="h-px bg-outline-variant/15" />
            <div className="h-px bg-outline-variant/20" />
          </div>

          {/* Bars */}
          <div className="relative h-full flex items-end justify-around gap-2 sm:gap-4 px-1 pt-2">
            {data.map(
              (
                {
                  ym,
                  label,
                  hours,
                  sessions = 0,
                  groups = 0,
                  courseStudentStacks = [],
                  classTypeHours,
                  classTypeSessions = [],
                  classTypeGroups = [],
                },
                i
              ) => {
                const barTrackPx = 200;
                const value =
                  metric === 'students'
                    ? courseStudentStacks.reduce((sum, s) => sum + s.students, 0)
                    : metric === 'hours'
                      ? hours
                      : metric === 'sessions'
                        ? sessions
                        : groups;
                const rawBarPx = yAxisMax > 0 ? (value / yAxisMax) * barTrackPx : 0;
                const barPx = value > 0 ? Math.max(rawBarPx, 8) : 0;
                const valueStr = formatValue(value);
                const nonZeroClassTypeValues =
                  metric === 'students'
                    ? courseStudentStacks
                        .filter((e) => e.students > 0)
                        .map((e) => ({ key: e.stackKey, value: e.students }))
                    : metric === 'hours'
                      ? classTypeHours
                          .map((entry) => ({ key: entry.classType, value: entry.hours }))
                          .filter((entry) => entry.value > 0)
                      : metric === 'sessions'
                        ? classTypeSessions
                            .map((entry) => ({ key: entry.classType, value: entry.sessions }))
                            .filter((entry) => entry.value > 0)
                        : classTypeGroups
                            .map((entry) => ({ key: entry.classType, value: entry.groups }))
                            .filter((entry) => entry.value > 0);

                return (
                  <div key={ym} className="flex flex-col items-center flex-1 min-w-0 justify-end gap-3 group">
                    <div
                      className="w-full max-w-[48px] mx-auto flex flex-col items-center justify-end relative"
                      style={{ height: barTrackPx }}
                    >
                      {/* Tooltip / Value Label */}
                      <div
                        className="absolute opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none flex flex-col items-center z-20"
                        style={{ bottom: `${barPx + 10}px` }}
                      >
                        <div className="bg-inverse-surface text-inverse-on-surface text-[11px] font-bold px-3 py-2 rounded-md shadow-md flex max-w-[min(720px,94vw)] flex-col gap-1 overflow-x-auto [scrollbar-width:thin]">
                          <div className="min-w-0 shrink-0">
                            {metric === 'students'
                              ? `${valueStr} student${value === 1 ? '' : 's'} total (sum of courses)`
                              : `${valueStr} ${metric === 'hours' ? 'hrs' : metricLabel.toLowerCase()} total`}
                          </div>
                          {nonZeroClassTypeValues.length > 0 ? (
                            nonZeroClassTypeValues.map(({ key, value: typeValue }) => (
                              <div
                                key={`${ym}-${key}`}
                                className="flex w-max min-w-full items-center justify-between gap-6 font-semibold text-left"
                              >
                                <span className="whitespace-nowrap pr-2">{key}</span>
                                <span className="shrink-0 tabular-nums">
                                  {formatValue(typeValue)}
                                  {metric === 'hours' ? 'h' : ''}
                                </span>
                              </div>
                            ))
                          ) : (
                            <div className="font-semibold opacity-80">
                              {metric === 'students' ? 'No attendance' : 'No classes'}
                            </div>
                          )}
                        </div>
                        <div className="w-2 h-2 bg-inverse-surface rotate-45 -mt-1" />
                      </div>

                      {value > 0 ? (
                        <span className="text-[11px] font-bold tabular-nums text-on-surface mb-2 leading-none">
                          {valueStr}
                          {metric === 'hours' ? (
                            <span className="text-on-surface-variant font-semibold text-[9px] ml-0.5">h</span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-[11px] font-semibold tabular-nums text-on-surface-variant/50 mb-2">
                          —
                        </span>
                      )}

                      {mounted ? (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: barPx, opacity: 1 }}
                          transition={{
                            duration: 0.8,
                            delay: i * 0.1,
                            ease: [0.25, 1, 0.5, 1],
                          }}
                          className="w-full rounded-t-[8px] shadow-sm shadow-primary/20 group-hover:brightness-110 transition-all cursor-pointer overflow-hidden flex flex-col justify-end"
                        >
                          {nonZeroClassTypeValues.map(({ key, value: typeValue }, index) => {
                            const segmentPct = value > 0 ? (typeValue / value) * 100 : 0;
                            const segmentClass =
                              metric === 'students'
                                ? COURSE_STACK_SEGMENT_COLORS[
                                    (courseStackColorIndex.get(key) ?? 0) % COURSE_STACK_SEGMENT_COLORS.length
                                  ]
                                : CLASS_TYPE_STYLES[key as keyof typeof CLASS_TYPE_STYLES];
                            return (
                              <div
                                key={`${ym}-${key}`}
                                className={`${segmentClass} ${index === 0 ? 'rounded-t-[8px]' : ''}`}
                                style={{
                                  height: `${segmentPct}%`,
                                  minHeight: segmentPct > 0 ? 2 : 0,
                                }}
                                title={
                                  metric === 'students'
                                    ? `${key}: ${formatValue(typeValue)} students`
                                    : `${key}: ${formatValue(typeValue)}${metric === 'hours' ? 'h' : ''}`
                                }
                              />
                            );
                          })}
                        </motion.div>
                      ) : (
                        <div className="w-full rounded-t-[8px] bg-primary" style={{ height: 0 }} />
                      )}
                    </div>
                    <span className="text-[11px] font-bold text-on-surface-variant shrink-0 tracking-widest uppercase">
                      {label}
                    </span>
                  </div>
                );
              }
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
