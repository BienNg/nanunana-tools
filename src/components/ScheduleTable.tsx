import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';

type Lesson = {
  id: string;
  slide_id: string;
  content: string;
  notes: string;
  slides_checked: boolean;
  is_done: boolean;
  date: string;
  start_time: string;
  end_time: string;
  teacher: string;
  messages: string;
  courses: {
    name: string;
    groups: { name: string } | null;
  } | null;
};

export default function ScheduleTable() {
  const [lessons, setLessons] = useState<Lesson[]>([]);

  const fetchLessons = async () => {
    const { data } = await supabase
      .from('lessons')
      .select(
        `*,
        courses (
          name,
          groups ( name )
        )`
      )
      .order('date', { ascending: true })
      .order('start_time', { ascending: true });
    
    if (data) setLessons(data);
  };

  useEffect(() => {
    fetchLessons();

    const channel = supabase
      .channel('schema-db-changes-lessons')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lessons' }, () => {
        fetchLessons();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <div className="bg-surface-container-lowest rounded-[1rem] p-1 shadow-sm border border-outline-variant/5 overflow-hidden">
      <div className="overflow-x-auto no-scrollbar">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-surface-container-low/50">
              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">Kurs / Folien & Inhalt</th>
              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">Notizen</th>
              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70 text-center">Folien gecheckt</th>
              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70 text-center">gemacht</th>
              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">Datum & Zeit</th>
              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">Lehrer</th>
              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">Nachrichten</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant/10">
            {lessons.map((lesson, idx) => (
              <tr key={lesson.id} className="hover:bg-surface-container-low transition-colors group">
                <td className="px-6 py-6">
                  <div className="flex items-center gap-3">
                    <div className={`w-2 h-8 rounded-full group-hover:h-10 transition-all ${lesson.is_done ? 'bg-primary' : 'bg-secondary-container'}`}></div>
                    <div>
                      {(lesson.courses?.groups?.name || lesson.courses?.name) && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-primary block mb-0.5">
                          {[lesson.courses?.groups?.name, lesson.courses?.name].filter(Boolean).join(' · ')}
                        </span>
                      )}
                      <span className="font-bold text-sm block">{lesson.slide_id}</span>
                      <span className="text-xs text-on-surface-variant block">{lesson.content}</span>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-6 text-sm text-on-surface-variant max-w-[200px] truncate" title={lesson.notes}>{lesson.notes}</td>
                <td className="px-6 py-6 text-center">
                  {lesson.slides_checked ? (
                    <span className="material-symbols-outlined text-tertiary" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                  ) : (
                    <span className="material-symbols-outlined text-outline">radio_button_unchecked</span>
                  )}
                </td>
                <td className="px-6 py-6 text-center">
                  {lesson.is_done ? (
                    <span className="material-symbols-outlined text-tertiary">task_alt</span>
                  ) : (
                    <span className="material-symbols-outlined text-outline">pending</span>
                  )}
                </td>
                <td className="px-6 py-6 text-sm">
                  <div className="font-medium">{lesson.date ? new Date(lesson.date).toLocaleDateString() : 'TBA'}</div>
                  {lesson.start_time && (
                    <div className="text-xs text-on-surface-variant">
                      <span className="text-on-surface font-bold">{lesson.start_time.slice(0, 5)}</span>
                      <span className="text-outline mx-1">-</span>
                      <span className="text-on-surface font-bold">{lesson.end_time?.slice(0, 5) || '?'}</span>
                    </div>
                  )}
                </td>
                <td className="px-6 py-6">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center text-[10px] font-bold text-blue-700">
                      {lesson.teacher?.substring(0, 2).toUpperCase() || 'TBA'}
                    </div>
                    <span className="text-sm font-semibold">{lesson.teacher || 'TBA'}</span>
                  </div>
                </td>
                <td className="px-6 py-6">
                  {lesson.messages && (
                    <span className="text-xs bg-surface-container-high px-3 py-1 rounded-full text-on-surface-variant max-w-[150px] inline-block truncate" title={lesson.messages}>
                      {lesson.messages}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {lessons.length === 0 && (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center text-on-surface-variant">
                  No schedule data available. Import a Google Sheet to begin.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
