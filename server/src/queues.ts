import { Queue, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';

export const connection = (): ConnectionOptions =>
  new Redis(config.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false }) as unknown as ConnectionOptions;

export const QUEUE = {
  ingest: 'ingest', // VOD download / file import -> chunks
  analyze: 'analyze', // chunk -> transcript + signals + moments
  render: 'render', // moment/clip -> vertical short
  upload: 'upload', // approved clip -> YouTube
  maintenance: 'maintenance', // stats refresh, disk cleanup
} as const;

export interface IngestJob { streamId: string }
export interface AnalyzeJob { chunkId: string }
export interface RenderJob { clipId: string; version: number }
export interface UploadJob { publicationId: string }

const shared = connection();
const defaults = { removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 7 * 86400 } };

export const queues = {
  ingest: new Queue<IngestJob>(QUEUE.ingest, { connection: shared, defaultJobOptions: { ...defaults, attempts: 2, backoff: { type: 'exponential', delay: 30000 } } }),
  analyze: new Queue<AnalyzeJob>(QUEUE.analyze, { connection: shared, defaultJobOptions: { ...defaults, attempts: 3, backoff: { type: 'exponential', delay: 15000 } } }),
  render: new Queue<RenderJob>(QUEUE.render, { connection: shared, defaultJobOptions: { ...defaults, attempts: 2, backoff: { type: 'fixed', delay: 20000 } } }),
  upload: new Queue<UploadJob>(QUEUE.upload, { connection: shared, defaultJobOptions: { ...defaults, attempts: 3, backoff: { type: 'exponential', delay: 60000 } } }),
  maintenance: new Queue(QUEUE.maintenance, { connection: shared, defaultJobOptions: defaults }),
};

export async function queueCounts() {
  const out: Record<string, Record<string, number>> = {};
  for (const [name, qu] of Object.entries(queues)) {
    out[name] = await qu.getJobCounts('active', 'waiting', 'delayed', 'failed', 'completed');
  }
  return out;
}
