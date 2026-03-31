-- Default false until a sheet sync evaluates the group; then true only when no future tabs were skipped and no course had skipped sessions.
ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS sync_completed BOOLEAN NOT NULL DEFAULT false;

-- Default false until this course is imported; then true only when that import had no skipped session rows (preview skip, future date, or missing date when Datum exists).
ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS sync_completed BOOLEAN NOT NULL DEFAULT false;
