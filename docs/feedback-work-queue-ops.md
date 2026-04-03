# Feedback Work Queue - Operator Guide

This page explains how to use the Feedback queue in daily operations.

## Queue

- Single actionable queue: students who match the current detection rules.

## Why a student appears

A student appears when at least one condition is true:

- More than 1 `Absent` attendance record since `feedback_sent_at` (within configured session and course scope).
- `feedback_sent_at` is missing or older than 7 days.

Additional eligibility gates are implemented in code (recently started courses, first-session delay, etc.).

## Actions

- `Done`
  - Sets `feedback_done_at = now`.
  - Sets `feedback_sent_at = now`.

## Notes

- Queue evaluation is DB-only.
- Completed-course status is not used in queue detection.
- One row represents one student with combined course context.
