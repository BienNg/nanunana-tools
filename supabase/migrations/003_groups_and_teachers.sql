-- Groups: one row per Google Spreadsheet (e.g. G98 Online DE workbook).
-- Courses belong to a group; each sheet tab is one course.
-- Teachers are normalized; course_teachers links courses to all teachers who teach that course.

CREATE TABLE IF NOT EXISTS groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    spreadsheet_id TEXT UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS teachers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS course_teachers (
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    teacher_id UUID NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    PRIMARY KEY (course_id, teacher_id)
);

ALTER TABLE courses ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES groups(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS courses_group_id_name_key
    ON courses (group_id, name)
    WHERE group_id IS NOT NULL;
