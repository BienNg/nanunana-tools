'use client';

import { useEffect, useRef, ReactNode, useState } from 'react';
import gsap from 'gsap';
import ActiveCoursesPanel from './ActiveCoursesPanel';
import SyncForm from './SyncForm';
import StatsGrid from './StatsGrid';
import BulkActiveCoursesSyncModal from './BulkActiveCoursesSyncModal';

export default function DashboardContent({ hoursTaughtChart }: { hoursTaughtChart?: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isBulkModalOpen, setIsBulkModalOpen] = useState(false);
  /** Bumps client-side Supabase refetches (stats + active courses); router.refresh alone does not update them. */
  const [bodyRefreshKey, setBodyRefreshKey] = useState(0);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.from('.animate-fade-up', {
        y: 40,
        opacity: 0,
        duration: 0.8,
        stagger: 0.1,
        ease: 'power3.out',
      });
    }, containerRef);
    return () => ctx.revert();
  }, []);

  return (
    <section ref={containerRef} className="pt-24 px-10 pb-12">
      {/* Hero Header & Import */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8 mb-12 animate-fade-up">
        <div>
          <h2 className="text-4xl font-extrabold text-on-surface tracking-tight mb-2 font-headline">
            Academic Overview
          </h2>
          <p className="text-on-surface-variant max-w-md">
            Your curated exhibition of classroom performance and logistical scheduling for the current semester.
          </p>
        </div>
        <div id="import-sheets" className="scroll-mt-28 shrink-0">
          <SyncForm
            onSyncComplete={() => {
              setBodyRefreshKey((k) => k + 1);
            }}
          />
        </div>
      </div>

      {/* Bento Stats Grid */}
      <StatsGrid bodyRefreshKey={bodyRefreshKey} onUpdateAll={() => setIsBulkModalOpen(true)} />

      {hoursTaughtChart && (
        <div className="mt-8">
          {hoursTaughtChart}
        </div>
      )}

      <div className="mt-8">
        <ActiveCoursesPanel bodyRefreshKey={bodyRefreshKey} />
      </div>
      <BulkActiveCoursesSyncModal
        isOpen={isBulkModalOpen}
        onClose={() => setIsBulkModalOpen(false)}
        onSyncComplete={() => {
          setBodyRefreshKey((k) => k + 1);
        }}
      />
    </section>
  );
}
