-- Alternate spellings / variants for students scoped to a group.
-- Match key is normalized in app code (normalizePersonNameKey) and stored as normalized_key.

CREATE TABLE IF NOT EXISTS student_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    normalized_key TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT student_aliases_group_key_unique UNIQUE (group_id, normalized_key)
);

CREATE INDEX IF NOT EXISTS student_aliases_student_id_idx ON student_aliases (student_id);
CREATE INDEX IF NOT EXISTS student_aliases_group_id_idx ON student_aliases (group_id);

ALTER TABLE student_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "student_aliases_all" ON public.student_aliases;
CREATE POLICY "student_aliases_all" ON public.student_aliases FOR ALL USING (true) WITH CHECK (true);
