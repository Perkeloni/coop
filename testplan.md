# MRT Recovery Test Plan

## Goal

Verify the new MRT recovery flow end to end:

- the recovery state table works
- the scheduled job loads and runs
- missing Redis jobs are restored from Postgres
- failed items persist across runs
- the admin reset mutation works

## How We’ll Test It

- I will spin up the necessary services.
- I will run the automated/manual commands and paste the command output.
- For anything visible in the UI or logs, I will tell you exactly what to open and what to look for.
- If a step depends on a screenshot-worthy state, I will stop and ask you to confirm it before moving on.

## 1. Start Dependencies

1. Start the backing services:

```bash
docker compose up -d postgres redis clickhouse scylla
```

2. Apply migrations:

```bash
docker compose run --rm migrations
```

3. Record the output of both commands.

4. Tell me if you want me to check the container logs next, or if you want to inspect them yourself.

## 2. Verify the Recovery Table

1. I will confirm the new MRT recovery table exists.

2. Command:

```bash
docker compose exec postgres psql -U postgres -d api-server -c "\dt manual_review_tool.*"
```

3. Expected output:

- `manual_review_tool.mrt_queue_recovery_state` is listed.

4. If you want to verify it manually, inspect the database listing yourself.

## 3. Run the Recovery-State Unit Test

1. Run the focused test:

```bash
cd server
NODE_OPTIONS="--no-warnings --loader ts-node/esm --require dotenv/config" \
  jest --runInBand --no-cache --forceExit \
  server/services/manualReviewToolService/modules/MrtRecoveryOperations.test.ts
```

2. I will record the full output.

3. Expected result:

- retry count increments
- failed state persists
- reset returns the row to `PENDING`

## 4. Load the Scheduled Job

1. Run the job entrypoint:

```bash
cd server
npm run runWorkerOrJob RecoverMrtQueueJob
```

2. I will record the output.

3. Expected result:

- no import/runtime error
- config values load from env
- the job exits cleanly when there is nothing to recover

4. If you want to inspect logs yourself, watch the console output from that command.

## 5. Manual Recovery Check in the UI

1. Seed or identify an MRT queue with known `job_creations` rows.

2. Clear the live Redis queue for that org/queue.

3. Open the MRT dashboard in the UI.

4. Look at the queue’s pending count before recovery.

5. Run the recovery job again:

```bash
cd server
npm run runWorkerOrJob RecoverMrtQueueJob
```

6. Look at the dashboard again.

7. What you should see:

- pending count increases after recovery
- the queue is no longer empty if recoverable jobs exist
- already-decided jobs do not come back

8. I will not assume this is correct until you confirm what you see in the UI.

## 6. Watch the Logs for Recovery Behavior

1. While the recovery job runs, watch the server/job logs.

2. Look for these signals:

- loaded candidate rows from `manual_review_tool.job_creations`
- deduped candidates
- skipped decided jobs
- successful re-enqueues
- persisted failures after retries are exhausted

3. I will paste the relevant command output, and you can compare it with the log stream.

## 7. Test Failure Persistence

1. Create or identify a job that cannot be rebuilt.

2. Run the recovery job repeatedly until the retry limit is hit.

3. Check the UI or the database state after each run.

4. Expected result:

- `retryCount` increases across runs
- the row becomes `FAILED` at the retry limit
- later runs skip the failed row

5. If you want, I can pause here and wait for you to inspect the state between runs.

## 8. Test the Admin Reset Mutation

1. Log in as an org admin.

2. Use GraphQL to call:

```graphql
mutation ResetMrtRecoveryJobs($jobIds: [ID!]!) {
  resetMrtRecoveryJobs(jobIds: $jobIds) {
    ... on ResetMrtRecoveryJobsSuccessResponse {
      success
    }
  }
}
```

3. I will record the response.

4. Then inspect the row again.

5. Expected result:

- `FAILED` becomes `PENDING`
- `retryCount` resets to `0`
- `lastError` clears

6. Also try the same call as a non-admin if you want to verify access control.

## 9. Final Sanity Checks

1. If the schema changed, run codegen verification:

```bash
npm run generate
docker compose run --rm codegen-check
```

2. Run the broader server check if you want extra confidence:

```bash
cd server
npm run test:prepush -- --runInBand
```

3. Record the output.

4. For local Jaeger trace verification, disable metrics export because the local
   collector only needs traces:

From the `server/` directory:

```bash
OTEL_METRICS_EXPORTER=none \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4317 \
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4317 \
node --require ../nodejs-instrumentation/transpiled/autoinstrumentation.js \
  ./transpiled/bin/run-worker-or-job.js RecoverMrtQueueJob
```

5. Expected result:

- Jaeger shows `runWorkerOrJob:RecoverMrtQueueJob`
- no metrics export warning is logged

## What I’ll Report Back

- the exact commands I ran
- the output of each command
- what I saw in the UI
- what I saw in logs
- whether recovery, retry persistence, and reset all behaved as expected
