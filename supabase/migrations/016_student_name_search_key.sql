-- Accent-insensitive student name search (e.g. "cuong" matches "Cường").
-- Apply in Supabase SQL Editor or via `supabase db push`.

CREATE EXTENSION IF NOT EXISTS unaccent;

ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS name_search_key text;

UPDATE public.students
SET name_search_key = lower(unaccent(trim(name)))
WHERE name_search_key IS NULL OR name_search_key = '';

CREATE OR REPLACE FUNCTION public.students_set_name_search_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.name_search_key := lower(unaccent(trim(COALESCE(NEW.name, ''))));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS students_name_search_key_trigger ON public.students;
CREATE TRIGGER students_name_search_key_trigger
  BEFORE INSERT OR UPDATE OF name ON public.students
  FOR EACH ROW
  EXECUTE PROCEDURE public.students_set_name_search_key();

CREATE INDEX IF NOT EXISTS students_name_search_key_idx ON public.students (name_search_key);
