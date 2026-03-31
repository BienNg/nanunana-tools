-- Alternate spellings / full names for teachers (e.g. sheet says "Gia Bao", canonical teacher is "Bao").
-- Match key is normalized in app code (normalizePersonNameKey) and stored as normalized_key.

CREATE TABLE IF NOT EXISTS teacher_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id UUID NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    normalized_key TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT teacher_aliases_normalized_key_key UNIQUE (normalized_key)
);

CREATE INDEX IF NOT EXISTS teacher_aliases_teacher_id_idx ON teacher_aliases (teacher_id);

ALTER TABLE teacher_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "teacher_aliases_all" ON public.teacher_aliases;
CREATE POLICY "teacher_aliases_all" ON public.teacher_aliases FOR ALL USING (true) WITH CHECK (true);
