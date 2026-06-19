# Issue 146 Plan: MRT Redis Backfill

## Problem

`pendingJobCount` for MRT queues can drop to `0` after Redis is flushed, even when
`manual_review_tool.job_creations` still contains rows for those jobs in Postgres.

That leaves the dashboard showing an empty queue while there are still recoverable
jobs in the durable store.

## What The Repo Is Doing Today

- Jobs are enqueued into BullMQ/Redis first.
- The same enqueue is logged to Postgres in `manual_review_tool.job_creations`.
- The dashboard reads `pendingJobCount` from BullMQ via `queue.count()`.
- Recovery is already supported by `server/bin/recover-mrt-queue.ts`, which can
  rebuild jobs from Postgres and warehouse data.

## Why The Bug Happens

Redis is the live queue. Postgres is the durable history.

When Redis is cleared, the live queue disappears, but the Postgres rows remain.
Nothing automatically reconciles those two stores, so the UI sees "0 pending"
even though there are still jobs that can be recovered.

Issue comments confirmed the intended fix: a **backfill/recovery script** that
re-enqueues missing jobs into Redis. This is meant to be a manual or periodic
operator tool, not a UI warning feature.

We also want retry state to persist across scheduled runs, and once an item
exhausts its retries it should move into a durable failure record with status
`PENDING` when it is being retried again later.

That retry state should live in a new MRT-specific Postgres table, separate from
`manual_review_tool.job_creations`, so recovery metadata can move between
`PENDING` and terminal failure without mutating the enqueue history.

The recovery job should be configurable for:

- run interval
- number of retries
- how far back to look in `job_creations`

These settings should live in environment-based config, matching the rest of
the server's runtime configuration.

Default schedule: once per day.

## Relevant Files

- `server/services/manualReviewToolService/modules/MrtRecoveryOperations.ts`
- `server/services/manualReviewToolService/manualReviewToolService.ts`
- `server/graphql/modules/manualReviewTool.ts`
- `client/src/webpages/dashboard/mrt/ManualReviewQueuesDashboard.tsx`
- `server/bin/recover-mrt-queue.ts`
- `server/bin/recoverMrtQueueLib.ts`
- `server/workers_jobs/`
- `server/iocContainer/services/workersAndJobs.ts`
- `server/bin/run-worker-or-job.ts`

## Suggested Fix Direction

Extend the existing recovery flow so it can scan Postgres, find missing Redis
jobs, and restore them.

This is better than changing `pendingJobCount` or adding a dashboard warning,
because the actual problem is missing queue state, not just missing visibility.

The periodic execution should live as a scheduled job in `server/workers_jobs/`
and be launched by the deployment layer on a cron-like schedule. The repo
already treats `workers_jobs` as the home for scheduled jobs, and
`run-worker-or-job.ts` is the shared entrypoint for them.

## Implementation Plan

1. Reuse the existing recovery script entrypoint.
   - `server/bin/recover-mrt-queue.ts` already does the high-level recovery
     orchestration.
   - Extend it, or its helper library, so it can be used as a general backfill
     for Redis-orphaned MRT jobs.
   - Keep the script dry-run by default and writable only with `--apply`.
   - Expose the runtime knobs needed by the periodic job: interval, retry
     count, and lookback window.

2. Make the recovery scan safe and idempotent.
   - Read candidate jobs from `manual_review_tool.job_creations`.
   - Check whether the matching BullMQ job already exists.
   - Re-enqueue only the missing ones.
   - Skip decided jobs and anything that can no longer be recovered.
   - Use retry state that persists across runs so the same bad row does not get
     retried forever from scratch.

3. Keep the workflow operator-driven.
   - Dry-run by default.
   - `--apply` does the actual write.
   - Preserve the existing guardrails around queue choice, report history, and
     item rehydration.

4. Make skipped items auditable.
   - Keep structured logs/traces for operators.
   - Persist a durable recovery-failure record once an item exhausts retries.
   - Allow manual reset/retry through an admin command that accepts an array
     of job ids and sets the matching failure records back to `PENDING`.
   - Follow the repo's existing pattern of "log + trace + durable state" for
     important failures.

5. Wire the periodic job into runtime execution.
   - Add a job entry under `server/workers_jobs/` that runs the recovery logic.
   - Register it in `server/iocContainer/services/workersAndJobs.ts` so it can
     be launched via `server/bin/run-worker-or-job.ts`.
   - Make the deployment layer start it on the configured cron schedule.
   - Default the schedule to once per day, with env-based overrides.

6. Add regression tests.
   - Test the mismatch case where Redis is empty but `job_creations` still has
     rows.
   - Test that the recovery path re-enqueues only missing jobs.
   - Test that already-decided jobs remain skipped.
   - Test that skipped items transition to durable failure state after retry
     exhaustion.
   - Test that manual reset returns the durable failure state to `PENDING`.

## Mental Model

Think of Coop MRT as two layers:

- Redis = the live "jobs waiting right now" queue.
- Postgres = the durable record of what was ever enqueued.

The issue happens when the live layer disappears but the durable layer does not.
The backfill script rebuilds the live layer from the durable layer.

The recovery retry state should live separately from `job_creations`, so the
enqueue history stays clean and the backfill state can move between `PENDING`
and failed without mutating the original source rows.

## Success Criteria

- The dashboard no longer silently shows an empty queue when recoverable jobs
  still exist.
- Operators can run a backfill to restore missing MRT jobs.
- Existing healthy queues still behave exactly as before.
- Skipped items are captured in a durable, auditable way.
- Retry state survives across periodic runs.
- Failed items can be manually reset back to `PENDING` via an admin command
  that takes an array of job ids.
- Interval, retries, and lookback are configurable.
- The recovery job runs automatically once per day by default.
