# Student Merge QA Checklist

This checklist covers the new merge semantics where shorter-name students are consumed by longer-name students when alias linking resolves two existing student records.

## Automated checks run

- `npm run lint -- "src/lib/students/studentMerge.ts" "src/app/api/students/aliases/route.ts" "src/lib/sync/googleSheetStudentSync.ts" "src/components/StudentAliasesManager.tsx"`
- `npx tsc --noEmit` (known unrelated pre-existing failures in `src/components/CourseActionsMenu.tsx`; no merge-related TypeScript errors)

## Manual scenarios

1. Manual merge from Students page:
   - Pick student A (shorter name) and student B (longer name) in alias manager.
   - Click Merge.
   - Verify A row is removed, B remains, A name appears as alias under B.

2. Reverse manual selection:
   - Pick student A (longer name) and B (shorter name).
   - Click Merge.
   - Verify longer-name student is kept regardless of which side was selected.

3. Equal-length tie in Students page:
   - Pick two students with equal character counts.
   - Verify UI blocks merge until a winner radio option is selected.
   - Merge and verify selected winner remains; loser becomes alias.

4. Cross-group merge support:
   - Attempt to merge students from different groups.
   - Verify merge succeeds, winner remains, loser is deleted, and foreign-key references move to winner id.

5. Referential integrity:
   - Before merge, note course enrollments and attendance counts for both students.
   - After merge, verify counts are preserved under winner id and loser id no longer appears in `course_students` / `attendance_records`.

6. Import alias resolution merge:
   - Trigger reviewed import with `studentAliasResolutions` where alias key currently maps to a different existing student id.
   - Verify merge occurs, cache remaps to winner, and sync continues without creating duplicate students.

7. Import tie handling:
   - Provide a resolution that maps two equal-length canonical names with no `tieWinnerStudentId`.
   - Verify sync fails with actionable error requiring `tieWinnerStudentId`.

8. Idempotency on retries:
   - Re-run same import payload after successful merge.
   - Verify no duplicate student rows and alias mapping remains stable.
