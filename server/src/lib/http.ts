import fs from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { storage } from './storage.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export const bad = (msg: string) => new HttpError(400, msg);
export const notFound = (what = 'Not found') => new HttpError(404, what);

/** Stream a stored media object with HTTP Range support (video seeking). */
export async function sendMedia(req: FastifyRequest, reply: FastifyReply, key: string, contentType: string, downloadName?: string) {
  const signed = await storage.signedUrl(key, downloadName);
  if (signed) return reply.redirect(signed);
  const file = await storage.localPath(key);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw notFound('media file missing');
  }
  reply.header('Accept-Ranges', 'bytes').header('Content-Type', contentType).header('Cache-Control', 'private, max-age=60');
  if (downloadName) reply.header('Content-Disposition', `attachment; filename="${downloadName.replace(/"/g, '')}"`);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : stat.size - 1;
      if (!m[1] && m[2]) {
        start = Math.max(0, stat.size - Number(m[2]));
        end = stat.size - 1;
      }
      end = Math.min(end, stat.size - 1);
      if (start > end || start >= stat.size) return reply.code(416).header('Content-Range', `bytes */${stat.size}`).send();
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${stat.size}`).header('Content-Length', end - start + 1);
      return reply.send(fs.createReadStream(file, { start, end }));
    }
  }
  reply.header('Content-Length', stat.size);
  return reply.send(fs.createReadStream(file));
}

export function sendLocalFile(req: FastifyRequest, reply: FastifyReply, file: string, contentType: string) {
  const stat = fs.statSync(file);
  reply.header('Accept-Ranges', 'bytes').header('Content-Type', contentType);
  const m = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (m) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = Math.min(m[2] ? Number(m[2]) : stat.size - 1, stat.size - 1);
    reply.code(206).header('Content-Range', `bytes ${start}-${end}/${stat.size}`).header('Content-Length', end - start + 1);
    return reply.send(fs.createReadStream(file, { start, end }));
  }
  reply.header('Content-Length', stat.size);
  return reply.send(fs.createReadStream(file));
}
