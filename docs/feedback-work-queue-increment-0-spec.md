# Feedback Work Queue - Increment 0 (Spec Freeze)

This document locks the v1 logic before implementation begins. It is intentionally strict so each next increment can be validated against it.

## Confirmed scope

- The app does **not** create the personal feedback message content.
- The app only identifies students who should receive personal feedback and supports queue workflow.
- Future criteria (homework quality, slow learning, etc.) are out of scope for v1.

## Core detection rules (v1)

1. Missing means `attendance_records.status = 'Absent'` only.
2. A student needs feedback attention when they were absent more than once since their last feedback date.
3. Every student has a global feedback date (`feedback_sent_at`) stored on the student record.
4. Weekly cadence:
   - If `feedback_sent_at` is null, treat as never sent.
   - If more than 7 days have passed since `feedback_sent_at`, student becomes due for review.
5. Recency filter:
   - Only students enrolled in the last month are considered.
   - Older/non-recent students should not appear.
6. New enrollment gate:
   - New enrollments with no history are hidden until 7 days have passed from first enrollment date.
   - First enrollment date source: first session date of the student's latest course.
7. One row per student in queue, even if enrolled in multiple courses.
8. Trust DB only; no sheet freshness checks.

## Important correction from product

- **Active course is not part of detection logic.**
- `courses.sync_completed` is not used to decide who appears in this queue.

## Queue behavior (v1 UX intent)

- Feedback tab acts as a work queue with:
  - snooze
  - done
- The queue should show combined context for each student (single row), not one row per enrollment.

## Data model target for next increment

Store globally on `students`:

- `feedback_sent_at` (timestamp, nullable)
- `feedback_status` (optional, enum-like string: `ok` / `needs_attention` / `sent`)
- queue fields for assignee/snooze/done (shape decided in Increment 1 migration)

## Open decisions to resolve before Increment 1

1. "Last month" window definition: rolling last 30 days.
2. First enrollment date source: first session date of the student's latest course.
3. Done action semantics: marking done sets `feedback_sent_at = now`.
4. If student is due by time but has <= 1 absence: include in queue.

## Increment 0 acceptance criteria

- Rules above are approved by product.
- Any unresolved items are explicitly decided and documented before schema work starts.
