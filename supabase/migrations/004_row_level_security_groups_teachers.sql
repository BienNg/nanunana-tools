ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_teachers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "groups_all" ON public.groups;
DROP POLICY IF EXISTS "teachers_all" ON public.teachers;
DROP POLICY IF EXISTS "course_teachers_all" ON public.course_teachers;

CREATE POLICY "groups_all" ON public.groups FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "teachers_all" ON public.teachers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "course_teachers_all" ON public.course_teachers FOR ALL USING (true) WITH CHECK (true);
