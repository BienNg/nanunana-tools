-- Allow manual / specialty class types (M, A, P) in addition to Online_DE, Online_VN, Offline.
ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_class_type_check;

ALTER TABLE groups
  ADD CONSTRAINT groups_class_type_check
  CHECK (
    class_type IS NULL
    OR class_type = ANY (
      ARRAY['Online_DE', 'Online_VN', 'Offline', 'M', 'A', 'P']::text[]
    )
  );
