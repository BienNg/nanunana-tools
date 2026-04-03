-- Remove feedback snooze: column and index no longer used.

DROP INDEX IF EXISTS public.students_feedback_snoozed_until_idx;

ALTER TABLE public.students
  DROP COLUMN IF EXISTS feedback_snoozed_until;
