-- Per-group default lesson minutes for non-fixed class types (e.g. M, A, P).
ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS default_lesson_minutes INTEGER
    CHECK (default_lesson_minutes IS NULL OR default_lesson_minutes > 0);

