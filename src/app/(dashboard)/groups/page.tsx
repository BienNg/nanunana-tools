import { getSupabaseAdmin } from '@/lib/supabase/admin';
import GroupCard from './GroupCard';

export const dynamic = 'force-dynamic';

export default async function GroupsPage() {
  const supabase = getSupabaseAdmin();
  const { data: groups, error } = await supabase
    .from('groups')
    .select('id, name, spreadsheet_url')
    .order('name', { ascending: false });

  if (error) {
    console.error('Error fetching groups:', error);
  }

  return (
    <div className="pt-24 px-10 pb-12 animate-fade-up">
      <div className="mb-12">
        <h2 className="text-4xl font-extrabold text-on-surface tracking-tight mb-2 font-headline">
          Groups
        </h2>
        <p className="text-on-surface-variant max-w-md">
          Manage and view all your student groups and their respective courses.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {groups?.map((group) => (
          <GroupCard
            key={group.id}
            id={group.id}
            name={group.name}
            spreadsheetUrl={group.spreadsheet_url}
          />
        ))}
        {(!groups || groups.length === 0) && (
          <div className="col-span-full p-12 text-center bg-surface-container-lowest border border-outline-variant/10 rounded-2xl flex flex-col items-center justify-center min-h-[200px]">
             <span className="material-symbols-outlined text-4xl text-outline mb-2">inbox</span>
            <p className="text-on-surface-variant">No groups found. Import data to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}
