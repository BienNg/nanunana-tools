-- One student row per (group, name). Courses link via course_students (many-to-many).

CREATE TABLE IF NOT EXISTS course_students (
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    PRIMARY KEY (course_id, student_id)
);

ALTER TABLE course_students ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "course_students_all" ON public.course_students;
CREATE POLICY "course_students_all" ON public.course_students FOR ALL USING (true) WITH CHECK (true);

INSERT INTO course_students (course_id, student_id)
SELECT course_id, id FROM students
ON CONFLICT DO NOTHING;

ALTER TABLE students ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES groups(id) ON DELETE CASCADE;

UPDATE students s
SET group_id = c.group_id
FROM courses c
WHERE c.id = s.course_id AND s.group_id IS NULL;

-- Merge duplicate (group_id, name) into one student: repoint attendance and enrollments, then delete extras.
CREATE TEMP TABLE student_merge_map (loser_id UUID PRIMARY KEY, keeper_id UUID NOT NULL);

INSERT INTO student_merge_map (loser_id, keeper_id)
SELECT s.id, k.keeper_id
FROM students s
INNER JOIN (
    SELECT group_id, name, (array_agg(id ORDER BY id))[1] AS keeper_id
    FROM students
    WHERE group_id IS NOT NULL
    GROUP BY group_id, name
) k ON k.group_id = s.group_id AND k.name = s.name
WHERE s.group_id IS NOT NULL AND s.id <> k.keeper_id;

UPDATE attendance_records ar
SET student_id = m.keeper_id
FROM student_merge_map m
WHERE ar.student_id = m.loser_id;

INSERT INTO course_students (course_id, student_id)
SELECT DISTINCT cs.course_id, m.keeper_id
FROM course_students cs
INNER JOIN student_merge_map m ON cs.student_id = m.loser_id
ON CONFLICT DO NOTHING;

DELETE FROM course_students cs
USING student_merge_map m
WHERE cs.student_id = m.loser_id;

DELETE FROM students s
USING student_merge_map m
WHERE s.id = m.loser_id;

ALTER TABLE students DROP CONSTRAINT IF EXISTS students_course_id_name_key;
ALTER TABLE students DROP COLUMN course_id;

-- Multiple (NULL, same name) allowed (NULL ≠ NULL for uniqueness); one row per non-null group + name.
CREATE UNIQUE INDEX IF NOT EXISTS students_group_id_name_key ON students (group_id, name);
