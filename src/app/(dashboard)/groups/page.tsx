import Link from 'next/link';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function GroupsPage() {
  const supabase = getSupabaseAdmin();
  const { data: groups, error } = await supabase
    .from('groups')
    .select('id, name')
    .order('name');

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
          <Link href={`/groups/${group.id}`} key={group.id} className="block group cursor-pointer">
            <div className="bg-surface-container-lowest border border-outline-variant/10 rounded-2xl p-6 shadow-sm hover:shadow-md transition-all group-hover:-translate-y-1 group-hover:border-primary/30 h-full flex flex-col justify-between">
              <div>
                <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mb-4 text-primary group-hover:bg-primary group-hover:text-white transition-colors">
                  <span className="material-symbols-outlined">workspaces</span>
                </div>
                <h3 className="text-xl font-bold text-on-surface mb-2">
                  {group.name}
                </h3>
              </div>
              <p className="text-sm text-primary font-medium flex items-center gap-1 mt-4">
                View Details
                <span className="material-symbols-outlined text-sm group-hover:translate-x-1 transition-transform">arrow_forward</span>
              </p>
            </div>
          </Link>
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
