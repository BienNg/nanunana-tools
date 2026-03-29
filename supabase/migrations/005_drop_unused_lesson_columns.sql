-- Remove columns that are no longer tracked: notes, slides_checked, is_done, messages.
ALTER TABLE lessons
  DROP COLUMN IF EXISTS notes,
  DROP COLUMN IF EXISTS slides_checked,
  DROP COLUMN IF EXISTS is_done,
  DROP COLUMN IF EXISTS messages;
