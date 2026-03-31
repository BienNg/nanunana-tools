-- Teacher employment / roster visibility: active (default) or inactive.
ALTER TABLE public.teachers
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'inactive'));
