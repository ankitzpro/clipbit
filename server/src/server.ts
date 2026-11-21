/** API + dashboard server. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { migrate, waitForDb } from './db/migrate.js';
import { logger } from './lib/log.js';
import { ensureDirs } from './lib/storage.js';
import { onGeminiHealth } from './services/ai/gemini.js';
import { getSettings, recordAiHealth } from './settings.js';
import { apiRoutes } from './routes/api.js';

const log = logger('server');

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

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'warn' }, bodyLimit: 2 * 1024 * 1024, trustProxy: true });
  await app.register(cors, { origin: false });

  // raw uploads are streamed straight to disk
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  // optional password protection (HTTP basic auth, user "admin")
  if (config.appPassword) {
    const expected = Buffer.from(`admin:${config.appPassword}`);
    app.addHook('onRequest', async (req, reply) => {
      const h = req.headers.authorization || '';
      const given = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64') : Buffer.alloc(0);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        return reply.header('WWW-Authenticate', 'Basic realm="ClipBit"').code(401).send({ error: 'authentication required' });
      }
    });
  }

  await app.register(apiRoutes);

  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/', index: ['index.html'] });
  } else {
    app.get('/', async () => ({ ok: true, note: 'web UI not built — run `npm run build` in /web or use `npm run dev` there' }));
  }

  await app.listen({ host: '0.0.0.0', port: config.port });
  log.info(`ClipBit running at ${config.publicUrl}`);
}

main().catch((e) => {
  log.error('server failed to start', e);
  process.exit(1);
});
