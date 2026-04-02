'use client';

import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';

export default function SheetSyncProgressOverlay({
  mounted,
  title,
  headline,
  progressPercent,
  statusLine,
  onClose,
}: {
  mounted: boolean;
  title: string;
  headline: string;
  progressPercent: number;
  statusLine: string;
  onClose: () => void;
}) {
  if (!mounted) return null;

  const pct = Math.min(100, Math.max(0, progressPercent));

  return createPortal(
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-[min(42rem,92vw)] rounded-2xl border border-white/20 bg-white p-6 shadow-2xl">
        <h2 className="text-xl font-bold text-on-surface">{title}</h2>
        <div className="mt-5 flex items-center gap-3">
          <span className="material-symbols-outlined animate-spin text-primary">sync</span>
          <span className="text-sm font-medium text-on-surface-variant">{headline}</span>
        </div>
        <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-surface-variant/30">
          <motion.div
            className="h-full rounded-full bg-primary"
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
          />
        </div>
        <p className="mt-2 text-sm text-on-surface-variant">{statusLine || '…'}</p>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-outline-variant/50 bg-white px-4 py-2 text-sm font-semibold text-on-surface"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
