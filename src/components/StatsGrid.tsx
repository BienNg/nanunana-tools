import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';

export default function StatsGrid({
  bodyRefreshKey = 0,
  onUpdateAll,
}: {
  bodyRefreshKey?: number;
  onUpdateAll?: () => void;
}) {
  const [stats, setStats] = useState({
    totalStudents: 0,
    activeCourses: 0,
  });

  useEffect(() => {
    async function fetchStats() {
      // Very basic fetch
      const { count: totalStudents } = await supabase
        .from('students')
        .select('*', { count: 'exact', head: true });

      const { count: activeCourses } = await supabase
        .from('courses')
        .select('*', { count: 'exact', head: true })
        .or('sync_completed.is.false,sync_completed.is.null');

      setStats({
        totalStudents: totalStudents || 0,
        activeCourses: activeCourses || 0,
      });
    }

    fetchStats();

    // Listen to changes
    const channel = supabase
      .channel('schema-db-changes')
      .on('postgres_changes', { event: '*', schema: 'public' }, () => {
        fetchStats();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [bodyRefreshKey]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12 animate-fade-up">
      <div className="bg-surface-container-lowest p-6 rounded-[1rem] shadow-sm flex flex-col justify-between h-48 group hover:translate-y-[-4px] transition-transform">
        <div className="flex justify-between items-start">
          <span className="material-symbols-outlined text-primary bg-primary/10 p-2 rounded-lg">
            person_search
          </span>
        </div>
        <div>
          <div className="text-4xl font-black text-on-surface font-headline">{stats.totalStudents}</div>
          <div className="text-sm font-medium text-on-surface-variant">Total Students</div>
        </div>
      </div>

      <div className="bg-gradient-to-br from-primary to-primary-container p-6 rounded-[1rem] shadow-md flex flex-col justify-between h-48 text-white group hover:scale-[1.02] transition-transform">
        <div className="flex justify-between items-start">
          <span className="material-symbols-outlined text-white/50">pending_actions</span>
          <button
            type="button"
            onClick={() => onUpdateAll?.()}
            disabled={!onUpdateAll || stats.activeCourses === 0}
            className="rounded-md border border-white/40 bg-white/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white hover:bg-white/20 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            Update all
          </button>
        </div>
        <div>
          <div className="text-4xl font-black font-headline leading-none">{stats.activeCourses}</div>
          <div className="text-sm font-medium opacity-90 mt-2">Active courses</div>
          <div className="text-xs opacity-70 mt-1">Courses not marked as completed</div>
        </div>
      </div>
    </div>
  );
}
