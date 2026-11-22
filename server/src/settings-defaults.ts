export type ReframeMode = 'smart' | 'blur' | 'center' | 'split';
export type ContentStyle = 'funny' | 'action' | 'unexpected' | 'reactions' | 'commentary' | 'viral_only';

export interface AppSettings {
  contentContext: string;
  styles: ContentStyle[];
  minScore: number; // moments below this are discarded
  autoClip: boolean; // render clips automatically for good moments
  autoClipMinScore: number;
  maxMomentsPerChunk: number;
  chunkSeconds: number;
  clipMin: number;
  clipMax: number;
  transcription: 'whisper' | 'gemini' | 'none';
  language: string; // auto | en | hi | ...
  geminiModel: string;
  aiProvider: { detect: 'ollama' | 'gemini'; edit: 'gemini' | 'ollama' }; // preferred provider per job (the other is the fallback)
  ollamaModel: string;
  heuristicFallback: boolean; // create basic "signal" moments when Gemini is unavailable (placeholder titles)
  aiBudget: { prefilter: boolean; minPeakStrength: number }; // skip Gemini for quiet chunks to save quota
  missionShort: { targetSeconds: number; maxSeconds: number; maxParts: number };
  reframeMode: ReframeMode;
  captions: {
    enabled: boolean;
    animated: boolean;
    uppercase: boolean;
    fontName: string;
    fontSize: number;
    color: string;
    highlightColor: string;
    keywordColor: string;
    position: number; // 0 = top, 1 = bottom (fraction of height for the caption baseline)
    maxWordsPerLine: number;
  };
  deadAir: { enabled: boolean; minSilence: number; noiseDb: number };
  aiEdit: {
    hook: boolean; // bold hook banner for the first seconds
    hookSeconds: number;
    smartCaptions: boolean; // AI fixes transcription mistakes + picks highlight words
    sfx: boolean; // sound effects at AI-chosen moments
    sfxVolume: number; // 0..1
    maxSfx: number;
  };
  video: { crf: number; preset: string; fps: number; blurBackground: boolean; punchIn?: boolean };
  branding: { intro: { enabled: boolean; file: string }; outro: { enabled: boolean; file: string } };
  publish: { defaultPrivacy: 'private' | 'unlisted' | 'public'; appendShortsTag: boolean; defaultHashtags: string[]; categoryId: string };
  retention: { keepRecordingsHours: number };
}

export const defaultSettings: AppSettings = {
  contentContext: 'GTA 6 gameplay live stream',
  styles: ['funny', 'action', 'unexpected', 'reactions'],
  minScore: 35, // evidence-based scale (scoring.ts): routine ≈ 10-25, decent 35-60, great 75+
  autoClip: true,
  autoClipMinScore: 65,
  maxMomentsPerChunk: 2,
  chunkSeconds: 60,
  clipMin: 20,
  clipMax: 60,
  transcription: 'whisper',
  language: 'auto',
  geminiModel: '',
  aiProvider: { detect: 'ollama', edit: 'gemini' },
  ollamaModel: '',
  heuristicFallback: false,
  aiBudget: { prefilter: true, minPeakStrength: 2.2 },
  missionShort: { targetSeconds: 60, maxSeconds: 170, maxParts: 6 },
  reframeMode: 'smart',
  captions: {
    enabled: true,
    animated: true,
    uppercase: true,
    fontName: 'DejaVu Sans',
    fontSize: 78,
    color: '#FFFFFF',
    highlightColor: '#FFE600',
    keywordColor: '#3CFF6B',
    position: 0.68,
    maxWordsPerLine: 4,
  },
  deadAir: { enabled: true, minSilence: 1.2, noiseDb: -38 },
  aiEdit: { hook: true, hookSeconds: 2.8, smartCaptions: true, sfx: true, sfxVolume: 0.55, maxSfx: 4 },
  video: { crf: 20, preset: 'veryfast', fps: 30, blurBackground: true, punchIn: true }, // punchIn: small zoom on beats (smart/center framing)
  branding: { intro: { enabled: false, file: '' }, outro: { enabled: false, file: '' } },
  publish: { defaultPrivacy: 'private', appendShortsTag: true, defaultHashtags: ['#GTA6', '#Shorts', '#Gaming'], categoryId: '20' },
  retention: { keepRecordingsHours: 48 },
};

