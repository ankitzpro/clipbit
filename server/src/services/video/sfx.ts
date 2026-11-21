/**
 * Sound effects library.
 *   DATA_DIR/sfx/<type>/*.wav|mp3|ogg   — your own (royalty-free) effects, any folder name becomes a type
 *   DATA_DIR/sfx/_builtin/<type>.wav    — simple synthesized effects generated on first use (whoosh, boom, ding, riser, pop)
 * User files always take priority over built-ins of the same type.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { ffmpeg } from '../../lib/proc.js';

export const sfxDir = () => path.join(config.dataDir, 'sfx');

const BUILTIN: Record<string, string[]> = {
  whoosh: ['-f', 'lavfi', '-i', 'anoisesrc=c=pink:d=0.6:a=0.9', '-af', 'highpass=f=500,lowpass=f=6000,afade=t=in:d=0.3:curve=qsin,afade=t=out:st=0.3:d=0.3:curve=qsin,volume=1.4'],
  boom: ['-f', 'lavfi', '-i', 'aevalsrc=0.9*sin(2*PI*(70-40*t)*t)*exp(-3.2*t)+0.25*(random(0)-0.5)*exp(-18*t):d=1.3:s=48000', '-af', 'lowpass=f=900,volume=1.6'],
  ding: ['-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*1318*t)*exp(-4*t)+0.25*sin(2*PI*1975*t)*exp(-5*t):d=1.0:s=48000'],
  riser: ['-f', 'lavfi', '-i', 'aevalsrc=0.35*sin(2*PI*(180*t+260*t*t))*(t/1.4):d=1.4:s=48000', '-af', 'afade=t=out:st=1.3:d=0.1'],
  pop: ['-f', 'lavfi', '-i', 'aevalsrc=0.7*sin(2*PI*(900-500*t)*t)*exp(-38*t):d=0.18:s=48000'],
};

let builtinsReady: Promise<void> | null = null;

export function ensureBuiltinSfx() {
  builtinsReady ||= (async () => {
    const dir = path.join(sfxDir(), '_builtin');
    await fs.mkdir(dir, { recursive: true });
    for (const [name, args] of Object.entries(BUILTIN)) {
      const out = path.join(dir, `${name}.wav`);
      try {
        await fs.access(out);
      } catch {
        await ffmpeg([...args, '-ac', '2', '-ar', '48000', out]);
      }
    }
    await fs.writeFile(
      path.join(sfxDir(), 'README.txt'),
      'Put your own royalty-free sound effects here, one folder per type, e.g.\n' +
        '  sfx/laugh/laugh1.mp3\n  sfx/airhorn/horn.wav\n  sfx/whoosh/swish.mp3   (overrides the built-in whoosh)\n' +
        'The AI editor will use any type it finds. Only use sounds you have the rights to.\n',
    ).catch(() => {});
  })().catch((e) => {
    builtinsReady = null;
    throw e;
  });
  return builtinsReady;
}

/** type -> candidate files (user files first) */
export async function listSfx(): Promise<Record<string, string[]>> {
  await ensureBuiltinSfx();
  const out: Record<string, string[]> = {};
  const root = sfxDir();
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '_builtin') continue;
    const files = (await fs.readdir(path.join(root, entry.name)))
      .filter((f) => /\.(wav|mp3|ogg|m4a|flac)$/i.test(f))
      .map((f) => path.join(root, entry.name, f));
    if (files.length) out[entry.name.toLowerCase()] = files;
  }
  for (const f of await fs.readdir(path.join(root, '_builtin'))) {
    const type = f.replace(/\.wav$/, '');
    if (!out[type]) out[type] = [path.join(root, '_builtin', f)];
  }
  return out;
}

/** Deterministic pick so re-renders sound the same. */
export function pickSfx(lib: Record<string, string[]>, type: string, seed: string) {
  const files = lib[type];
  if (!files?.length) return null;
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return files[h % files.length];
}
