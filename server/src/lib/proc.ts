import { spawn, type SpawnOptions } from 'node:child_process';
import { config } from '../config.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class ProcError extends Error {
  constructor(public cmd: string, public code: number, public stderr: string) {
    super(`${cmd} exited with code ${code}: ${stderr.split('\n').filter(Boolean).slice(-6).join(' | ')}`);
  }
}

/** Run a process and collect output. Rejects on non-zero exit unless allowFail. */
export function run(
  cmd: string,
  args: string[],
  opts: SpawnOptions & { allowFail?: boolean; timeoutMs?: number; onStderr?: (chunk: string) => void; onStdout?: (chunk: string) => void; maxBuffer?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    const max = opts.maxBuffer ?? 64 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.stdout!.on('data', (d: Buffer) => {
      const s = d.toString();
      if (stdout.length < max) stdout += s;
      opts.onStdout?.(s);
    });
    child.stderr!.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr = (stderr + s).slice(-max);
      opts.onStderr?.(s);
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const res = { code: code ?? -1, stdout, stderr };
      if (res.code !== 0 && !opts.allowFail) reject(new ProcError(cmd, res.code, stderr));
      else resolve(res);
    });
  });
}

/** Run a process and return raw stdout bytes (for rawvideo frame extraction). */
export function runBuffer(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout!.on('data', (d: Buffer) => chunks.push(d));
    child.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-20000)));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new ProcError(cmd, code ?? -1, stderr))));
  });
}

export const ffmpeg = (args: string[], opts?: Parameters<typeof run>[2]) =>
  run(config.ffmpegBin, ['-hide_banner', '-nostdin', '-y', ...args], opts);

export async function probe(file: string): Promise<{
  duration: number; width: number; height: number; fps: number; hasAudio: boolean; videoCodec: string; audioCodec: string;
}> {
  const { stdout } = await run(config.ffprobeBin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find((s: any) => s.codec_type === 'video') || {};
  const a = (j.streams || []).find((s: any) => s.codec_type === 'audio');
  const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || '30/1').split('/').map(Number);
  return {
    duration: Number(j.format?.duration || v.duration || 0),
    width: Number(v.width || 0),
    height: Number(v.height || 0),
    fps: d ? n / d : 30,
    hasAudio: !!a,
    videoCodec: String(v.codec_name || ''),
    audioCodec: String(a?.codec_name || ''),
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
