# Issue 146 Smoke Results

Scope: MRT recovery stack on `maco/ISSUE-146/mrt-redis-recovery`.

Environment used: local Postgres, Redis, Scylla, ClickHouse, and the MRT recovery env vars from the repo templates.

## Results

| Requirement | Check | Status | Notes |
| --- | --- | --- | --- |
| Enqueue failures persist recovery state | `npm run test:ci -- --testNamePattern='persists meaningful enqueue failures for later recovery' services/manualReviewToolService/manualReviewToolService.test.ts` | PASS | Verified the enqueue failure path stores `mrt_queue_recovery_state` with the expected identifiers, retry count, and error text. |
| Retry state increments and resets | `npm run test:ci -- --testNamePattern='tracks retries and reset state' services/manualReviewToolService/modules/MrtRecoveryOperations.test.ts` | PASS | Verified retry counting, failure transition, org-scoped reset, and per-org isolation. |
| Reset mutation validates and scopes by org | `npm run test:ci -- graphql/modules/manualReviewTool.resetMrtRecoveryJobs.test.ts` | PASS | Verified empty input, invalid job IDs, and org-scoped reset behavior. |
| Worker boots and runs the recovery flow | `npm run runWorkerOrJob RecoverMrtQueueJob` | PASS | Initial run exposed malformed recovery IDs in local data; the worker was updated to skip malformed IDs and the rerun completed successfully. It loaded candidates, processed org buckets, and exited without a runtime error. |

## Edge Cases Observed

- `REDIS_USE_CLUSTER=false` is required for the local smoke environment.
- `SCYLLA_USERNAME` / `SCYLLA_PASSWORD` are required for service startup.
- `CLICKHOUSE_*` env vars are required for the worker runtime.
- Some legacy recovery `job_id`s in the local database are malformed; the worker now skips them instead of crashing.

## Conclusion

The MRT recovery flow is working as expected in the smoke environment after the malformed-id guard was added. All requested requirements passed.
