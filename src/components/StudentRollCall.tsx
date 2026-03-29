import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase/client';

type StudentWithStats = {
  id: string;
  name: string;
  courseLabel: string;
  performance: number;
  recentStatus: string;
  recentFeedback: string;
};

export default function StudentRollCall() {
  const [students, setStudents] = useState<StudentWithStats[]>([]);

  const fetchStudents = async () => {
    // Fetch students
    const { data: studentsData } = await supabase.from('students').select(
      `*,
      courses (
        name,
        groups ( name )
      )`
    );
    if (!studentsData) return;

    // Fetch all attendance records
    const { data: attendanceData } = await supabase
      .from('attendance_records')
      .select('*, lessons(date, start_time)')
      .order('created_at', { ascending: false });

    if (!attendanceData) {
      setStudents(
        studentsData.map((s) => {
          const c = s.courses as { name?: string; groups?: { name?: string } | null } | null;
          const courseLabel = [c?.groups?.name, c?.name].filter(Boolean).join(' · ') || 'Course';
          return {
            id: s.id,
            name: s.name,
            courseLabel,
            performance: 0,
            recentStatus: 'Unknown',
            recentFeedback: '',
          };
        })
      );
      return;
    }

    const processedStudents = studentsData.map((student) => {
      const c = student.courses as { name?: string; groups?: { name?: string } | null } | null;
      const courseLabel = [c?.groups?.name, c?.name].filter(Boolean).join(' · ') || 'Course';
      const studentRecords = attendanceData.filter((a) => a.student_id === student.id);
      
      let performance = 0;
      let recentStatus = 'Unknown';
      let recentFeedback = '';

      if (studentRecords.length > 0) {
        const presentCount = studentRecords.filter(r => r.status === 'Present').length;
        performance = Math.round((presentCount / studentRecords.length) * 100);
        
        // Assuming the most recent record is first due to descending order by created_at or lesson date
        const recentRecord = studentRecords[0];
        recentStatus = recentRecord.status;
        recentFeedback = recentRecord.feedback;
      }

      return {
        id: student.id,
        name: student.name,
        courseLabel,
        performance,
        recentStatus,
        recentFeedback,
      };
    });

    setStudents(processedStudents);
  };

  useEffect(() => {
    fetchStudents();

    const channel = supabase
      .channel('schema-db-changes-attendance')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance_records' }, () => {
        fetchStudents();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <div className="bg-surface-container-low rounded-[1rem] p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h3 className="text-2xl font-black font-headline tracking-tight text-on-surface">Student Roll Call</h3>
          <p className="text-sm text-on-surface-variant">Live tracking and recent feedback</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-tertiary"></span>
            <span className="text-xs font-bold text-on-surface-variant">Present</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-error"></span>
            <span className="text-xs font-bold text-on-surface-variant">Absent</span>
          </div>
        </div>
      </div>
      
      <div className="space-y-4">
        {students.map((student) => (
          <div key={student.id} className="bg-surface-container-lowest rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:shadow-md transition-shadow">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-surface-container-high flex items-center justify-center text-primary font-bold shrink-0">
                {student.name.substring(0, 2).toUpperCase()}
              </div>
              <div>
                <h4 className="font-bold text-on-surface">{student.name}</h4>
                <p className="text-[10px] font-bold uppercase tracking-wider text-primary/80">{student.courseLabel}</p>
                <p className="text-xs text-on-surface-variant font-medium truncate max-w-[200px]" title={student.recentFeedback}>
                  {student.recentFeedback || 'No recent feedback'}
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-6 md:gap-12">
              <div className="text-right flex-1 md:flex-none">
                <p className="text-[10px] font-bold text-on-surface-variant/50 uppercase tracking-widest">Performance</p>
                <div className="flex items-center justify-end gap-2 mt-1">
                  <div className="w-24 h-2 bg-surface-container rounded-full overflow-hidden hidden md:block">
                    <div 
                      className={`h-full ${student.performance >= 50 ? 'bg-tertiary' : 'bg-error'}`} 
                      style={{ width: `${student.performance}%` }}
                    ></div>
                  </div>
                  <span className={`text-xs font-black ${student.performance >= 50 ? 'text-tertiary' : 'text-error'}`}>
                    {student.performance}%
                  </span>
                </div>
              </div>
              
              <span className={`px-4 py-1.5 rounded-full text-xs font-bold w-20 text-center ${
                student.recentStatus === 'Present' 
                  ? 'bg-tertiary-container text-on-tertiary-fixed' 
                  : student.recentStatus === 'Absent'
                    ? 'bg-error-container text-on-error-container'
                    : 'bg-surface-container-high text-on-surface-variant'
              }`}>
                {student.recentStatus}
              </span>
            </div>
          </div>
        ))}

        {students.length === 0 && (
          <div className="text-center text-on-surface-variant py-8">
            No students found.
          </div>
        )}
      </div>
    </div>
  );
}
