'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';

type ChartData = {
  ym: string;
  label: string;
  minutes: number;
  hours: number;
  classTypeHours: Array<{
    classType: 'Online_DE' | 'Online_VN' | 'Offline' | 'M' | 'A' | 'P' | 'Unknown';
    minutes: number;
    hours: number;
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

  useEffect(() => {
    setMounted(true);
  }, []);

  const peakHours = Math.max(0, ...data.map((d) => d.hours));
  const yAxisMax = Math.max(1, Math.ceil(peakHours));
  const yMid = yAxisMax / 2;

  // Formatting hours to 2 decimal places max
  const formatHours = (hours: number) => {
    const rounded = Math.round(hours * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toString();
  };

  return (
    <div className="bg-surface-container-low rounded-[1rem] p-6 lg:p-8 flex flex-col border border-outline-variant/10 shadow-sm w-full h-full animate-fade-up">
      <div className="mb-8">
        <h3 className="text-xl font-bold font-headline text-on-surface">Total Hours Taught</h3>
        <p className="text-sm text-on-surface-variant font-medium mt-1">
          Across all courses · Last 6 months
        </p>
      </div>

      <div className="flex-1 flex gap-4 items-end min-h-[280px]">
        {/* Y-Axis */}
        <div className="flex flex-col justify-between h-[200px] shrink-0 mb-8 text-xs font-semibold text-on-surface-variant tabular-nums text-right pr-2 w-12 border-r border-outline-variant/15">
          <span>{yAxisMax}h</span>
          <span>{yMid % 1 === 0 ? yMid : yMid.toFixed(1)}h</span>
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
            {data.map(({ ym, label, hours, classTypeHours }, i) => {
              const barTrackPx = 200;
              const rawBarPx = yAxisMax > 0 ? (hours / yAxisMax) * barTrackPx : 0;
              const barPx = hours > 0 ? Math.max(rawBarPx, 8) : 0;
              const hoursStr = formatHours(hours);
              const nonZeroClassTypeHours = classTypeHours.filter((entry) => entry.hours > 0);

              return (
                <div key={ym} className="flex flex-col items-center flex-1 min-w-0 justify-end gap-3 group">
                  <div
                    className="w-full max-w-[48px] mx-auto flex flex-col items-center justify-end relative"
                    style={{ height: barTrackPx }}
                  >
                    {/* Tooltip / Value Label */}
                    <div className="absolute -top-8 opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none flex flex-col items-center z-20">
                      <div className="bg-inverse-surface text-inverse-on-surface text-[10px] font-bold px-2 py-1 rounded-md shadow-md whitespace-nowrap min-w-[120px]">
                        <div className="mb-1">{hoursStr} hrs total</div>
                        {nonZeroClassTypeHours.length > 0 ? (
                          nonZeroClassTypeHours.map(({ classType, hours: typeHours }) => (
                            <div key={`${ym}-${classType}`} className="flex items-center justify-between gap-2 font-semibold">
                              <span>{classType}</span>
                              <span>{formatHours(typeHours)}h</span>
                            </div>
                          ))
                        ) : (
                          <div className="font-semibold opacity-80">No classes</div>
                        )}
                      </div>
                      <div className="w-2 h-2 bg-inverse-surface rotate-45 -mt-1" />
                    </div>

                    {hours > 0 ? (
                      <span className="text-[11px] font-bold tabular-nums text-on-surface mb-2 leading-none">
                        {hoursStr}
                        <span className="text-on-surface-variant font-semibold text-[9px] ml-0.5">h</span>
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
                        {nonZeroClassTypeHours.map(({ classType, hours: typeHours }, index) => {
                          const segmentPct = hours > 0 ? (typeHours / hours) * 100 : 0;
                          return (
                            <div
                              key={`${ym}-${classType}`}
                              className={`${CLASS_TYPE_STYLES[classType]} ${index === 0 ? 'rounded-t-[8px]' : ''}`}
                              style={{
                                height: `${segmentPct}%`,
                                minHeight: segmentPct > 0 ? 2 : 0,
                              }}
                              title={`${classType}: ${formatHours(typeHours)}h`}
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
