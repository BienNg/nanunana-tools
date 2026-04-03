# Feedback Work Queue - Operator Guide

This page explains how to use the Feedback queue in daily operations.

## Queue views

- `Active queue`: students currently actionable now.
- `Snoozed`: students temporarily hidden from active work until snooze expires.

## Why a student appears

A student appears when at least one condition is true:

- More than 1 `Absent` attendance record since `feedback_sent_at`.
- `feedback_sent_at` is missing or older than 7 days.

Additional eligibility gates:

- Student must have enrollment activity in the last 30 days.
- New students are hidden until 7 days after the first session date of their latest course.

## Actions

- `Done`
  - Sets `feedback_done_at = now`.
  - Sets `feedback_sent_at = now`.
  - Clears `feedback_snoozed_until`.
- `Snooze 7d`
  - Sets `feedback_snoozed_until = now + 7 days`.
  - Moves student out of Active queue into Snoozed view.
- `Unsnooze`
  - Clears `feedback_snoozed_until`.
  - Returns student to Active queue if they still match queue rules.

## Notes

- Queue evaluation is DB-only.
- Completed-course status is not used in queue detection.
- One row represents one student with combined course context.
