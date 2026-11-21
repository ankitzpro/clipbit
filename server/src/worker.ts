/** Worker process: recorder supervisor + BullMQ workers (ingest, analyze, render, upload, maintenance). */
import { Worker, type Job } from 'bullmq';
import { config } from './config.js';
import { migrate, waitForDb } from './db/migrate.js';
import { pool, q } from './db/pool.js';
import { logger, errMsg } from './lib/log.js';
import { ensureDirs } from './lib/storage.js';
import { onGeminiHealth } from './services/ai/gemini.js';
import { getSettings, recordAiHealth } from './settings.js';
import { connection, queues, QUEUE } from './queues.js';
import { startRecorderSupervisor } from './workers/recorder.js';
import { processIngest } from './workers/ingest.js';
import { processAnalyze } from './workers/analyze.js';
import { processRender } from './workers/render.js';
import { processUpload } from './workers/upload.js';
import { processMaintenance } from './workers/maintenance.js';

const log = logger('worker');

async function main() {
  await waitForDb();
  await migrate();
  await ensureDirs();
  await getSettings(); // loads the Gemini model override
  let lastHealthWrite = 0;
  let lastOk: boolean | null = null;
  onGeminiHealth((h) => {
    if (h.ok === lastOk && Date.now() - lastHealthWrite < 60_000) return;
    lastOk = h.ok;
    lastHealthWrite = Date.now();
    void recordAiHealth(h).catch(() => {});
  });

  const lockDuration = 10 * 60 * 1000; // long ffmpeg jobs
  const workers = [
    new Worker(QUEUE.ingest, processIngest, { connection: connection(), concurrency: 1, lockDuration }),
    new Worker(QUEUE.analyze, processAnalyze, { connection: connection(), concurrency: config.concurrency.analyze, lockDuration }),
    new Worker(QUEUE.render, processRender, { connection: connection(), concurrency: config.concurrency.render, lockDuration }),
    new Worker(QUEUE.upload, processUpload, { connection: connection(), concurrency: config.concurrency.upload, lockDuration: 30 * 60 * 1000 }),
    new Worker(QUEUE.maintenance, processMaintenance, { connection: connection(), concurrency: 1 }),
  ];
  for (const w of workers) {
    w.on('failed', async (job: Job | undefined, err: Error) => {
      if (!job || err?.name === 'DelayedError') return;
      log.warn(`${w.name} job ${job.id} failed (attempt ${job.attemptsMade}): ${errMsg(err)}`);
      if (w.name === QUEUE.ingest && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        await q(`UPDATE streams SET status = 'error', last_error = $2, updated_at = now() WHERE id = $1`, [job.data.streamId, errMsg(err).slice(0, 500)]).catch(() => {});
      }
    });
    w.on('error', (err) => log.error(`${w.name} worker error`, err));
  }

  await queues.maintenance.upsertJobScheduler('stats-every-6h', { every: 6 * 60 * 60 * 1000 }, { name: 'stats' });
  await queues.maintenance.upsertJobScheduler('cleanup-hourly', { every: 60 * 60 * 1000 }, { name: 'cleanup' });

  const stopRecorders = startRecorderSupervisor();
  log.info('workers started');

  const shutdown = async (sig: string) => {
    log.info(`${sig} received, shutting down`);
    await stopRecorders().catch(() => {});
    await Promise.allSettled(workers.map((w) => w.close()));
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  log.error('worker failed to start', e);
  process.exit(1);
});
