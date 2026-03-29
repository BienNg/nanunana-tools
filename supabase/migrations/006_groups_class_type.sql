-- Add class_type to track whether a group is Online_DE, Online_VN, or Offline.
-- Detected automatically from the Google Sheets workbook title during sync.
ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS class_type TEXT
    CHECK (class_type IN ('Online_DE', 'Online_VN', 'Offline'));
