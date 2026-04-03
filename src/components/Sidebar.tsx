'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSidebar } from '@/components/sidebar-context';

const navInactive =
  'flex items-center space-x-3 px-4 py-3 text-slate-500 hover:text-slate-900 hover:translate-x-1 transition-all duration-300 rounded-xl';
const navActive =
  'flex items-center space-x-3 px-4 py-3 bg-white text-blue-700 shadow-sm rounded-xl transition-all ease-out';

export default function Sidebar() {
  const pathname = usePathname();
  const { open, setOpen, widthPx } = useSidebar();
  const dashboardActive = pathname === '/';
  const groupsActive = pathname.startsWith('/groups');
  const teachersActive = pathname.startsWith('/teachers');
  const studentsActive = pathname.startsWith('/students');
  const feedbackActive = pathname.startsWith('/feedback');

  return (
    <aside
      className={`fixed left-0 top-0 z-50 flex h-full flex-col space-y-2 bg-slate-100 p-6 shadow-sm transition-transform duration-300 ease-out md:shadow-none ${
        open ? 'translate-x-0' : '-translate-x-full'
      }`}
      style={{ width: widthPx }}
      aria-hidden={!open}
    >
      <div className="mb-10 flex items-center justify-between gap-2 px-2">
        <div className="flex min-w-0 items-center space-x-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary">
            <span className="material-symbols-outlined text-white" style={{ fontVariationSettings: "'FILL' 1" }}>
              school
            </span>
          </div>
          <div className="min-w-0">
            <h1 className="truncate font-black text-xl tracking-tighter text-slate-900">
              The Atelier
            </h1>
            <p className="text-xs font-medium text-slate-500">Academic Curator</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-white hover:text-slate-900"
          aria-label="Collapse sidebar"
        >
          <span className="material-symbols-outlined text-xl">left_panel_close</span>
        </button>
      </div>
      <nav className="flex-1 space-y-1">
        <Link href="/" className={dashboardActive ? navActive : navInactive}>
          <span className="material-symbols-outlined">dashboard</span>
          <span
            className={`font-headline text-sm ${dashboardActive ? 'font-semibold' : 'font-medium'}`}
          >
            Dashboard
          </span>
        </Link>
        <Link href="/groups" className={groupsActive ? navActive : navInactive}>
          <span className="material-symbols-outlined">workspaces</span>
          <span
            className={`font-headline text-sm ${groupsActive ? 'font-semibold' : 'font-medium'}`}
          >
            Groups
          </span>
        </Link>
        <Link href="/teachers" className={teachersActive ? navActive : navInactive}>
          <span className="material-symbols-outlined">badge</span>
          <span
            className={`font-headline text-sm ${teachersActive ? 'font-semibold' : 'font-medium'}`}
          >
            Teachers
          </span>
        </Link>
        <Link href="/students" className={studentsActive ? navActive : navInactive}>
          <span className="material-symbols-outlined">group</span>
          <span
            className={`font-headline text-sm ${studentsActive ? 'font-semibold' : 'font-medium'}`}
          >
            Students
          </span>
        </Link>
        <Link href="/feedback" className={feedbackActive ? navActive : navInactive}>
          <span className="material-symbols-outlined">feedback</span>
          <span
            className={`font-headline text-sm ${feedbackActive ? 'font-semibold' : 'font-medium'}`}
          >
            Feedback
          </span>
        </Link>
      </nav>
      <div className="mt-auto pt-6 border-t border-slate-200/50 space-y-1">
        <a
          href="#import-sheets"
          className="w-full flex items-center justify-center space-x-2 py-3 px-4 bg-gradient-to-br from-primary to-primary-container text-white rounded-full font-semibold text-sm shadow-md hover:opacity-90 transition-opacity mb-4"
        >
          <span className="material-symbols-outlined text-sm">upload_file</span>
          <span>Import Sheets</span>
        </a>
        <a
          href="#"
          className="flex items-center space-x-3 px-4 py-3 text-slate-500 hover:text-slate-900 transition-all"
        >
          <span className="material-symbols-outlined">logout</span>
          <span className="font-headline text-sm font-medium">Logout</span>
        </a>
      </div>
    </aside>
  );
}
