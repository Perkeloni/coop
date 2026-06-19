#!/usr/bin/env node
import _ from 'lodash';

import getBottle, { type Dependencies } from '../iocContainer/index.js';
import { logErrorJson } from '../utils/logging.js';
import { type GlobalWithOpenTelemetrySdk } from '../utils/opentelemetry.js';
import { type WorkerOrJob } from '../workers_jobs/index.js';

const { container } = await getBottle();

const workerOrJobName = process.argv[2];
const workerOrJob = container[
  workerOrJobName as keyof Dependencies
] as WorkerOrJob;
const controller = new AbortController();

async function runWorkerOrJob() {
  if (workerOrJob.type !== 'Job') {
    await workerOrJob.run(controller.signal);
    return;
  }

  await container.Tracer.addActiveSpan(
    {
      operation: 'runWorkerOrJob',
      resource: workerOrJobName,
      attributes: { 'worker_or_job.name': workerOrJobName },
    },
    async () => workerOrJob.run(controller.signal),
  );
}

async function flushOpenTelemetry() {
  const sdk = (globalThis as GlobalWithOpenTelemetrySdk).__coopOpenTelemetrySdk;
  if (sdk == null) return;

  try {
    await Promise.race([
      sdk.shutdown(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('OpenTelemetry shutdown timed out')),
          5000,
        ),
      ),
    ]);
  } catch (e) {
    // eslint-disable-next-line no-restricted-syntax
    logErrorJson({
      message: 'failed to flush OpenTelemetry before worker/job exit',
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }
}

// When the worker/job finishes naturally (which only applies to jobs, as
// workers are meant to run forever), or when it throws an error, or when it
// gets shutdown by kubernetes, we run this function to cleanup gracefully.
// We call shutdown here, rather than in an `abort` listener on the signal so
// that we can await shutdown() finishing.
const onFinish = _.once((errorWhileRunningJobOrWorker?: Error) => {
  let exitWithFailure = Boolean(errorWhileRunningJobOrWorker);

  if (errorWhileRunningJobOrWorker) {
    // eslint-disable-next-line no-restricted-syntax
    logErrorJson({
      message: 'shutdown worker/job after encountering error during run',
      error: errorWhileRunningJobOrWorker,
    });
  }

  try {
    controller.abort();
  } catch (e) {
    exitWithFailure = true;
    // eslint-disable-next-line no-restricted-syntax
    logErrorJson({
      message: 'graceful shutdown failed while running abort signal listeners',
      error: e,
    });
  }

  workerOrJob.shutdown().then(
    async () => {
      await flushOpenTelemetry();
      process.exit(exitWithFailure ? 1 : 0);
    },
    async (e) => {
      // eslint-disable-next-line no-restricted-syntax
      logErrorJson({
        message: 'graceful shutdown failed with error',
        error: e,
      });
      await flushOpenTelemetry();
      process.exit(1);
    },
  );
});

runWorkerOrJob().then(
  // For jobs -- but not workers --- shut down when run()'s returned promise
  // is settled. Workers, meanwhile, only shut down if there's actually an error.
  workerOrJob.type === 'Job' ? () => onFinish() : () => {},
  onFinish,
);

process.on('uncaughtException', (err, _) => {
  // eslint-disable-next-line no-restricted-syntax
  logErrorJson({
    message: 'UncaughtException',
    error: err,
  });
  process.exit(1);
});

// Log but don't exit; a stray rejection shouldn't kill the worker.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-restricted-syntax
  logErrorJson({
    message: 'UnhandledRejection',
    error: reason instanceof Error ? reason : new Error(String(reason)),
  });
});

process.once('SIGTERM', onFinish);
process.once('SIGINT', onFinish);
