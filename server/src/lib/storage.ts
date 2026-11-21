/**
 * Object storage for finished media (clips, thumbnails).
 * - local: files under DATA_DIR/media (default; a Docker volume)
 * - s3:    any S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, ...)
 * Raw stream recordings always stay on local disk (they are large and short-lived).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';

export interface Storage {
  put(localFile: string, key: string, contentType: string): Promise<void>;
  /** Returns a local filesystem path for the object (downloads to cache for s3). */
  localPath(key: string): Promise<string>;
  /** Signed URL for direct browser access, or null when served by the API. */
  signedUrl(key: string, downloadName?: string): Promise<string | null>;
  remove(key: string): Promise<void>;
  /** Delete every object under a prefix (e.g. "clips/<id>/" = all versions of a clip); returns bytes freed when known. */
  removePrefix(prefix: string): Promise<number>;
}

/** Total size of a file or folder on local disk (0 if missing). */
export async function diskSize(p: string): Promise<number> {
  const st = await fsp.stat(p).catch(() => null);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of await fsp.readdir(p)) total += await diskSize(path.join(p, e));
  return total;
}

const safeKey = (key: string) => {
  const norm = path.posix.normalize(key).replace(/^\/+/, '');
  if (norm.startsWith('..')) throw new Error('invalid storage key');
  return norm;
};

class LocalStorage implements Storage {
  private abs(key: string) {
    return path.join(config.dirs.media, safeKey(key));
  }
  async put(localFile: string, key: string) {
    const dest = this.abs(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (path.resolve(localFile) === dest) return;
    try {
      await fsp.rename(localFile, dest);
    } catch {
      await fsp.copyFile(localFile, dest);
    }
  }
  async localPath(key: string) {
    return this.abs(key);
  }
  async signedUrl() {
    return null;
  }
  async remove(key: string) {
    await fsp.rm(this.abs(key), { force: true });
  }
  async removePrefix(prefix: string) {
    const dir = path.resolve(this.abs(prefix));
    if (!prefix.trim() || dir === path.resolve(config.dirs.media)) throw new Error('refusing to delete the whole media folder');
    const bytes = await diskSize(dir);
    await fsp.rm(dir, { recursive: true, force: true });
    return bytes;
  }
}

class S3Storage implements Storage {
  private clientP: Promise<any>;
  constructor() {
    this.clientP = import('@aws-sdk/client-s3').then(
      ({ S3Client }) =>
        new S3Client({
          region: config.storage.region,
          endpoint: config.storage.endpoint || undefined,
          forcePathStyle: !!config.storage.endpoint,
          credentials: config.storage.accessKeyId
            ? { accessKeyId: config.storage.accessKeyId, secretAccessKey: config.storage.secretAccessKey }
            : undefined,
        }),
    );
  }
  async put(localFile: string, key: string, contentType: string) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.clientP;
    const stat = await fsp.stat(localFile);
    await client.send(
      new PutObjectCommand({
        Bucket: config.storage.bucket,
        Key: safeKey(key),
        Body: fs.createReadStream(localFile),
        ContentLength: stat.size,
        ContentType: contentType,
      }),
    );
    // keep a cached local copy so rendering/upload doesn't need to re-download
    const cache = path.join(config.dirs.cache, safeKey(key));
    await fsp.mkdir(path.dirname(cache), { recursive: true });
    await fsp.rename(localFile, cache).catch(() => fsp.copyFile(localFile, cache));
  }
  async localPath(key: string) {
    const cache = path.join(config.dirs.cache, safeKey(key));
    if (fs.existsSync(cache)) return cache;
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.clientP;
    const res = await client.send(new GetObjectCommand({ Bucket: config.storage.bucket, Key: safeKey(key) }));
    await fsp.mkdir(path.dirname(cache), { recursive: true });
    await pipeline(res.Body as NodeJS.ReadableStream, fs.createWriteStream(cache));
    return cache;
  }
  async signedUrl(key: string, downloadName?: string) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const client = await this.clientP;
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: config.storage.bucket,
        Key: safeKey(key),
        ResponseContentDisposition: downloadName ? `attachment; filename="${downloadName}"` : undefined,
      }),
      { expiresIn: 3600 },
    );
  }
  async remove(key: string) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.clientP;
    await client.send(new DeleteObjectCommand({ Bucket: config.storage.bucket, Key: safeKey(key) }));
    await fsp.rm(path.join(config.dirs.cache, safeKey(key)), { force: true });
  }
  async removePrefix(prefix: string) {
    const p = safeKey(prefix).replace(/\/?$/, '/');
    if (p === '/') throw new Error('refusing to delete the whole bucket');
    const { ListObjectsV2Command, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.clientP;
    let bytes = 0;
    let token: string | undefined;
    do {
      const page: any = await client.send(new ListObjectsV2Command({ Bucket: config.storage.bucket, Prefix: p, ContinuationToken: token }));
      for (const o of page.Contents || []) {
        bytes += Number(o.Size || 0);
        await client.send(new DeleteObjectCommand({ Bucket: config.storage.bucket, Key: o.Key }));
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    await fsp.rm(path.join(config.dirs.cache, p), { recursive: true, force: true });
    return bytes;
  }
}

export const storage: Storage = config.storage.driver === 's3' ? new S3Storage() : new LocalStorage();

export async function ensureDirs() {
  for (const d of Object.values(config.dirs)) await fsp.mkdir(d, { recursive: true });
}
