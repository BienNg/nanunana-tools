export default function Sidebar() {
  return (
    <aside className="fixed left-0 top-0 h-full w-[280px] z-50 bg-slate-100 flex flex-col p-6 space-y-2">
      <div className="flex items-center space-x-3 px-2 mb-10">
        <div className="w-10 h-10 bg-primary rounded-xl flex items-center justify-center">
          <span className="material-symbols-outlined text-white" style={{ fontVariationSettings: "'FILL' 1" }}>
            school
          </span>
        </div>
        <div>
          <h1 className="font-black text-xl text-slate-900 tracking-tighter">
            The Atelier
          </h1>
          <p className="text-xs text-slate-500 font-medium">Academic Curator</p>
        </div>
      </div>
      <nav className="flex-1 space-y-1">
        <a
          href="#"
          className="flex items-center space-x-3 px-4 py-3 bg-white text-blue-700 shadow-sm rounded-xl transition-all ease-out"
        >
          <span className="material-symbols-outlined">dashboard</span>
          <span className="font-headline text-sm font-semibold">Dashboard</span>
        </a>
        <a
          href="#"
          className="flex items-center space-x-3 px-4 py-3 text-slate-500 hover:text-slate-900 hover:translate-x-1 transition-all duration-300"
        >
          <span className="material-symbols-outlined">calendar_month</span>
          <span className="font-headline text-sm font-medium">Schedule</span>
        </a>
        <a
          href="#"
          className="flex items-center space-x-3 px-4 py-3 text-slate-500 hover:text-slate-900 hover:translate-x-1 transition-all duration-300"
        >
          <span className="material-symbols-outlined">rule</span>
          <span className="font-headline text-sm font-medium">Attendance</span>
        </a>
        <a
          href="#"
          className="flex items-center space-x-3 px-4 py-3 text-slate-500 hover:text-slate-900 hover:translate-x-1 transition-all duration-300"
        >
          <span className="material-symbols-outlined">group</span>
          <span className="font-headline text-sm font-medium">Students</span>
        </a>
        <a
          href="#"
          className="flex items-center space-x-3 px-4 py-3 text-slate-500 hover:text-slate-900 hover:translate-x-1 transition-all duration-300"
        >
          <span className="material-symbols-outlined">grid_on</span>
          <span className="font-headline text-sm font-medium">Integrations</span>
        </a>
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
          <span className="material-symbols-outlined">help</span>
          <span className="font-headline text-sm font-medium">Support</span>
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
