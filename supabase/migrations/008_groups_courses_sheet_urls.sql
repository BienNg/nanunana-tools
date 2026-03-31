-- Canonical Google Sheets workbook URL per group; per-tab link per course (gid hash URL).

ALTER TABLE groups ADD COLUMN IF NOT EXISTS spreadsheet_url TEXT;

ALTER TABLE courses ADD COLUMN IF NOT EXISTS sheet_url TEXT;
