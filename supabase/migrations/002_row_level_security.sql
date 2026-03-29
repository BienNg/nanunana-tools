-- Optional: run after 001 if you use the anon key from the server and need explicit policies.
-- Service role (SUPABASE_SERVICE_ROLE_KEY) bypasses RLS and does not require these policies.

ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "courses_all" ON public.courses;
DROP POLICY IF EXISTS "students_all" ON public.students;
DROP POLICY IF EXISTS "lessons_all" ON public.lessons;
DROP POLICY IF EXISTS "attendance_all" ON public.attendance_records;

CREATE POLICY "courses_all" ON public.courses FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "students_all" ON public.students FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "lessons_all" ON public.lessons FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "attendance_all" ON public.attendance_records FOR ALL USING (true) WITH CHECK (true);
