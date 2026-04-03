'use client';

import { SidebarProvider, useSidebar } from '@/components/sidebar-context';
import Sidebar from '@/components/Sidebar';
import Topbar from '@/components/Topbar';

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { open, widthPx, setOpen } = useSidebar();

  return (
    <>
      <Sidebar />
      {open ? (
        <button
          type="button"
          aria-label="Close sidebar"
          className="fixed inset-0 z-30 bg-slate-900/20 backdrop-blur-[1px] md:hidden"
          onClick={() => setOpen(false)}
        />
      ) : null}
      <main
        className="min-h-screen transition-[margin] duration-300 ease-out"
        style={{ marginLeft: open ? widthPx : 0 }}
      >
        <Topbar />
        {children}
      </main>
    </>
  );
}

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <DashboardShellInner>
        {children}
      </DashboardShellInner>
    </SidebarProvider>
  );
}
