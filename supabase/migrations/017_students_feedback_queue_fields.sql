-- Feedback work queue (Increment 1): schema only, no behavior changes.
-- Stores global per-student queue state for future Feedback tab actions.

ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS feedback_sent_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS feedback_snoozed_until TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS feedback_done_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS students_feedback_sent_at_idx
  ON public.students (feedback_sent_at);

CREATE INDEX IF NOT EXISTS students_feedback_snoozed_until_idx
  ON public.students (feedback_snoozed_until);

CREATE INDEX IF NOT EXISTS students_feedback_done_at_idx
  ON public.students (feedback_done_at);
