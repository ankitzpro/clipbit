export interface Word { start: number; end: number; word: string }
export interface Segment { start: number; end: number; text: string; words?: Word[] }

export interface Signals {
  /** per-second momentary loudness in LUFS (session time = offset + index) */
  loudness: number[];
  /** per-second visual activity 0..1 */
  activity: number[];
  offset: number;
  /** seconds (session time) with notable spikes, strongest first */
  peaks: { t: number; strength: number; kind: 'audio' | 'visual' | 'speech' }[];
}

export interface MomentCandidate {
  start: number; // session seconds
  end: number;
  peak: number;
  title: string;
  description: string;
  category: string;
  score: number; // 0-100
  hashtags: string[];
  keywords: string[];
  transcript: string;
  detector: 'gemini' | 'ollama' | 'heuristic';
}

export interface LearningProfile {
  totalReviewed: number;
  categoryApproval: Record<string, { approved: number; rejected: number; rate: number }>;
  approvedExamples: string[];
  rejectedExamples: { title: string; reason?: string }[];
  topPerformers: { title: string; views: number; category?: string }[];
  categoryPerformance: Record<string, number>; // avg views per category
}
