import ClearDatabaseButton from '@/components/ClearDatabaseButton';

type TopbarProps = {
  showClearDatabase?: boolean;
};

export default function Topbar({ showClearDatabase = false }: TopbarProps) {
  return (
    <header className="fixed top-0 right-0 w-[calc(100%-280px)] h-16 z-40 bg-slate-50/80 backdrop-blur-md shadow-sm flex items-center justify-between px-8">
      <div className="flex items-center flex-1 max-w-xl">
        <div className="relative w-full">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
            search
          </span>
          <input
            type="text"
            placeholder="Search curated data..."
            className="w-full pl-10 pr-4 py-2 bg-surface-container-low border-none rounded-full text-sm focus:ring-2 focus:ring-primary/20 transition-all"
          />
        </div>
      </div>
      <div className="flex items-center space-x-6">
        {showClearDatabase ? <ClearDatabaseButton /> : null}
        <div className="flex items-center space-x-4">
          <button className="relative p-2 text-slate-600 hover:bg-blue-50 rounded-full transition-colors">
            <span className="material-symbols-outlined">notifications</span>
            <span className="absolute top-2 right-2 w-2 h-2 bg-error rounded-full border-2 border-white"></span>
          </button>
          <button className="p-2 text-slate-600 hover:bg-blue-50 rounded-full transition-colors">
            <span className="material-symbols-outlined">settings</span>
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
