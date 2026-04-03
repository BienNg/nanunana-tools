'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';

type ChartData = {
  ym: string;
  label: string;
  minutes: number;
  hours: number;
  sessions?: number;
  groups?: number;
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

export default function HoursTaughtChartClient({ data }: { data: ChartData[] }) {
  const [mounted, setMounted] = useState(false);
  const [metric, setMetric] = useState<'hours' | 'sessions' | 'groups'>('hours');

  useEffect(() => {
    setMounted(true);
  }, []);

  const peakValue = Math.max(
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
  const formatValue = (value: number) => (metric === 'hours' ? formatHours(value) : formatSessions(value));
  const metricLabel = metric === 'hours' ? 'Hours' : metric === 'sessions' ? 'Sessions' : 'Groups';
  const metricTitle =
    metric === 'hours' ? 'Total Hours Taught' : metric === 'sessions' ? 'Total Sessions Taught' : 'Total Groups Taught';

  return (
    <div className="bg-surface-container-low rounded-[1rem] p-6 lg:p-8 flex flex-col border border-outline-variant/10 shadow-sm w-full h-full animate-fade-up">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-xl font-bold font-headline text-on-surface">{metricTitle}</h3>
          <p className="text-sm text-on-surface-variant font-medium mt-1">
            Across all courses · Last 6 months
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-outline-variant/20 bg-surface-container px-1 py-1">
          <button
            type="button"
            onClick={() => setMetric('hours')}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
              metric === 'hours'
                ? 'bg-primary text-primary-foreground'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
          >
            Hours
          </button>
          <button
            type="button"
            onClick={() => setMetric('sessions')}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
              metric === 'sessions'
                ? 'bg-primary text-primary-foreground'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
          >
            Sessions
          </button>
          <button
            type="button"
            onClick={() => setMetric('groups')}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
              metric === 'groups'
                ? 'bg-primary text-primary-foreground'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
          >
            Groups
          </button>
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
              ({ ym, label, hours, sessions = 0, groups = 0, classTypeHours, classTypeSessions = [], classTypeGroups = [] }, i) => {
              const barTrackPx = 200;
              const value = metric === 'hours' ? hours : metric === 'sessions' ? sessions : groups;
              const rawBarPx = yAxisMax > 0 ? (value / yAxisMax) * barTrackPx : 0;
              const barPx = value > 0 ? Math.max(rawBarPx, 8) : 0;
              const valueStr = formatValue(value);
              const nonZeroClassTypeValues =
                metric === 'hours'
                  ? classTypeHours
                      .map((entry) => ({ classType: entry.classType, value: entry.hours }))
                      .filter((entry) => entry.value > 0)
                  : metric === 'sessions'
                    ? classTypeSessions
                      .map((entry) => ({ classType: entry.classType, value: entry.sessions }))
                      .filter((entry) => entry.value > 0)
                    : classTypeGroups
                      .map((entry) => ({ classType: entry.classType, value: entry.groups }))
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
                      <div className="bg-inverse-surface text-inverse-on-surface text-[10px] font-bold px-2 py-1 rounded-md shadow-md whitespace-nowrap min-w-[120px]">
                        <div className="mb-1">
                          {valueStr} {metric === 'hours' ? 'hrs' : metricLabel.toLowerCase()} total
                        </div>
                        {nonZeroClassTypeValues.length > 0 ? (
                          nonZeroClassTypeValues.map(({ classType, value: typeValue }) => (
                            <div key={`${ym}-${classType}`} className="flex items-center justify-between gap-2 font-semibold">
                              <span>{classType}</span>
                              <span>
                                {formatValue(typeValue)}
                                {metric === 'hours' ? 'h' : ''}
                              </span>
                            </div>
                          ))
                        ) : (
                          <div className="font-semibold opacity-80">No classes</div>
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
                          ease: [0.25, 1, 0.5, 1] 
                        }}
                        className="w-full rounded-t-[8px] shadow-sm shadow-primary/20 group-hover:brightness-110 transition-all cursor-pointer overflow-hidden flex flex-col justify-end"
                      >
                        {nonZeroClassTypeValues.map(({ classType, value: typeValue }, index) => {
                          const segmentPct = value > 0 ? (typeValue / value) * 100 : 0;
                          return (
                            <div
                              key={`${ym}-${classType}`}
                              className={`${CLASS_TYPE_STYLES[classType]} ${index === 0 ? 'rounded-t-[8px]' : ''}`}
                              style={{
                                height: `${segmentPct}%`,
                                minHeight: segmentPct > 0 ? 2 : 0,
                              }}
                              title={`${classType}: ${formatValue(typeValue)}${metric === 'hours' ? 'h' : ''}`}
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
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
