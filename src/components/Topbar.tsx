'use client';

import ClearDatabaseButton from '@/components/ClearDatabaseButton';
import { useSidebar } from '@/components/sidebar-context';

type TopbarProps = {
  showClearDatabase?: boolean;
};

export default function Topbar({ showClearDatabase = false }: TopbarProps) {
  const { open, toggle, widthPx } = useSidebar();

  return (
    <header
      className="fixed top-0 right-0 z-[45] flex h-16 items-center justify-between bg-slate-50/80 px-8 shadow-sm backdrop-blur-md transition-[left] duration-300 ease-out"
      style={{ left: open ? widthPx : 0 }}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-blue-50"
          aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
          aria-expanded={open}
        >
          <span className="material-symbols-outlined">menu</span>
        </button>
      </div>
      <div className="flex items-center space-x-6">
        {showClearDatabase ? <ClearDatabaseButton /> : null}
        <div className="flex items-center space-x-4">
          <button className="relative p-2 text-slate-600 hover:bg-blue-50 rounded-full transition-colors">
            <span className="material-symbols-outlined">notifications</span>
            <span className="absolute top-2 right-2 w-2 h-2 bg-error rounded-full border-2 border-white"></span>
          </button>
        </div>
        <div className="h-8 w-px bg-slate-200"></div>
        <div className="flex items-center space-x-3">
          <span className="text-sm font-semibold text-slate-700">Dr. Julian Vance</span>
          <div className="w-10 h-10 rounded-full object-cover ring-2 ring-primary/10 bg-slate-300 overflow-hidden">
             <img src="https://ui-avatars.com/api/?name=Julian+Vance&background=0D8ABC&color=fff" alt="User profile" />
          </div>
        </div>
      </div>
    </header>
  );
}
