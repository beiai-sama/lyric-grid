import { pinyin } from 'pinyin-pro';
import { ParsedLyricLine, PronunciationToken, parseLyricLine } from './phonetics';

const BLICK_PER_QUARTER = 705_600_000;

type RawNote = {
  onset?: number;
  duration?: number;
  lyrics?: string;
  phonemes?: string;
  pitch?: number;
  musicalType?: string;
};

type RawGroup = {
  uuid?: string;
  name?: string;
  notes?: RawNote[];
};

type RawGroupReference = {
  groupID?: string;
  blickOffset?: number;
  blickAbsoluteBegin?: number;
  blickAbsoluteEnd?: number;
  isInstrumental?: boolean;
  database?: { language?: string; phoneset?: string };
};

type RawTrack = {
  name?: string;
  mainGroup?: RawGroup;
  mainRef?: RawGroupReference;
  groups?: RawGroupReference[];
};

type RawProject = {
  version?: number;
  time?: { tempo?: Array<{ position?: number; bpm?: number }> };
  library?: RawGroup[];
  tracks?: RawTrack[];
};

export type SvpTempo = { position: number; bpm: number };

export type SvpNote = {
  id: string;
  lyric: string;
  phonemes: string;
  onset: number;
  end: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  pitch: number;
  groupId: string;
  role: 'normal' | 'hold' | 'syllable' | 'breath';
};

export type SvpTrack = {
  id: string;
  name: string;
  language: string;
  phoneset: string;
  detectedLanguage: 'zh' | 'ja' | 'latin' | 'mixed';
  notes: SvpNote[];
  durationSeconds: number;
};

export type SvpProject = {
  version: number;
  tempos: SvpTempo[];
  tracks: SvpTrack[];
};

export type SvpLineMeta = {
  version: number;
  trackName: string;
  language: string;
  notes: SvpNote[];
};

export type SvpImportedLine = ParsedLyricLine & {
  start: number;
  end: number;
  target: string[];
  svp: SvpLineMeta;
};

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeTempos(raw: RawProject): SvpTempo[] {
  const tempos = (raw.time?.tempo ?? [])
    .map((tempo) => ({ position: finiteNumber(tempo.position), bpm: Math.max(1, finiteNumber(tempo.bpm, 120)) }))
    .sort((left, right) => left.position - right.position);
  if (!tempos.length || tempos[0].position > 0) tempos.unshift({ position: 0, bpm: 120 });
  return tempos;
}

export function blickToSeconds(position: number, tempos: SvpTempo[]): number {
  const target = Math.max(0, position);
  let seconds = 0;
  let previousPosition = 0;
  let bpm = tempos[0]?.bpm ?? 120;

  for (const tempo of tempos) {
    if (tempo.position <= previousPosition) {
      bpm = tempo.bpm;
      continue;
    }
    if (tempo.position >= target) break;
    seconds += ((tempo.position - previousPosition) / BLICK_PER_QUARTER) * (60 / bpm);
    previousPosition = tempo.position;
    bpm = tempo.bpm;
  }

  return seconds + ((target - previousPosition) / BLICK_PER_QUARTER) * (60 / bpm);
}

function noteRole(lyric: string): SvpNote['role'] {
  const normalized = lyric.trim().toLowerCase();
  if (normalized === '-' || normalized === '=') return 'hold';
  if (normalized === '+') return 'syllable';
  if (normalized === 'br' || normalized === 'sil' || normalized === 'pau') return 'breath';
  return 'normal';
}

function detectTrackLanguage(notes: SvpNote[]): SvpTrack['detectedLanguage'] {
  const lyrics = notes.filter((note) => note.role === 'normal').map((note) => note.lyric);
  if (!lyrics.length) return 'mixed';
  const han = lyrics.filter((lyric) => /\p{Script=Han}/u.test(lyric)).length;
  const kana = lyrics.filter((lyric) => /[\u3040-\u30ff]/.test(lyric)).length;
  const latin = lyrics.filter((lyric) => /[A-Za-z]/.test(lyric)).length;
  if (han > lyrics.length * 0.2 && latin > lyrics.length * 0.2) return 'mixed';
  if (han > lyrics.length * 0.5 && kana < lyrics.length * 0.1) return 'zh';
  if (kana > lyrics.length * 0.2) return 'ja';
  if (latin > lyrics.length * 0.5) return 'latin';
  return 'mixed';
}

export function parseSvpProject(value: string): SvpProject {
  const sanitized = value.replace(/^\uFEFF/, '').replace(/\u0000+$/g, '').trim();
  const raw = JSON.parse(sanitized) as RawProject;
  if (!raw || !Array.isArray(raw.tracks)) throw new Error('这不是可识别的 SVP 工程');

  const version = finiteNumber(raw.version);
  const tempos = normalizeTempos(raw);
  const library = new Map((raw.library ?? []).filter((group) => group.uuid).map((group) => [group.uuid as string, group]));

  const tracks = raw.tracks.map((track, trackIndex): SvpTrack | undefined => {
    const instances: Array<{ group?: RawGroup; reference: RawGroupReference; key: string }> = [
      { group: track.mainGroup, reference: track.mainRef ?? {}, key: `track-${trackIndex}-main` },
      ...(track.groups ?? []).map((reference, referenceIndex) => ({
        group: reference.groupID ? library.get(reference.groupID) : undefined,
        reference,
        key: `track-${trackIndex}-ref-${referenceIndex}`,
      })),
    ];

    const notes = instances.flatMap(({ group, reference, key }) => {
      const offset = finiteNumber(reference.blickOffset);
      const clipStart = finiteNumber(reference.blickAbsoluteBegin, Number.NEGATIVE_INFINITY);
      const rawClipEnd = finiteNumber(reference.blickAbsoluteEnd, -1);
      const clipEnd = rawClipEnd < 0 ? Number.POSITIVE_INFINITY : rawClipEnd;
      return (group?.notes ?? []).flatMap((note, noteIndex): SvpNote[] => {
        if (note.musicalType && note.musicalType !== 'singing') return [];
        const onset = finiteNumber(note.onset) + offset;
        const duration = Math.max(0, finiteNumber(note.duration));
        const end = onset + duration;
        if (!duration || end <= clipStart || onset >= clipEnd) return [];
        const clippedOnset = Math.max(onset, clipStart);
        const clippedEnd = Math.min(end, clipEnd);
        const lyric = String(note.lyrics ?? '').trim() || 'a';
        const startSeconds = blickToSeconds(clippedOnset, tempos);
        const endSeconds = blickToSeconds(clippedEnd, tempos);
        return [{
          id: `${key}-${noteIndex}`,
          lyric,
          phonemes: String(note.phonemes ?? '').trim(),
          onset: clippedOnset,
          end: clippedEnd,
          startSeconds,
          endSeconds,
          durationSeconds: Math.max(0, endSeconds - startSeconds),
          pitch: finiteNumber(note.pitch, 60),
          groupId: key,
          role: noteRole(lyric),
        }];
      });
    }).sort((left, right) => left.onset - right.onset || left.pitch - right.pitch);

    if (!notes.length) return undefined;
    const database = track.mainRef?.database
      ?? (track.groups ?? []).find((reference) => reference.database)?.database
      ?? {};
    return {
      id: `svp-track-${trackIndex}`,
      name: track.name?.trim() || `轨道 ${trackIndex + 1}`,
      language: database.language?.trim().toLowerCase() || 'unknown',
      phoneset: database.phoneset?.trim().toLowerCase() || 'unknown',
      detectedLanguage: detectTrackLanguage(notes),
      notes,
      durationSeconds: Math.max(0, notes[notes.length - 1].endSeconds - notes[0].startSeconds),
    };
  }).filter((track): track is SvpTrack => Boolean(track));

  if (!tracks.length) throw new Error('工程里没有可读取的歌唱音符');
  return { version, tempos, tracks };
}

function noteAddsSyllable(note: SvpNote): boolean {
  return note.role === 'normal' || note.role === 'syllable';
}

export function splitSvpTrack(track: SvpTrack, maximumSyllables = 18): SvpNote[][] {
  const phrases: SvpNote[][] = [];
  let current: SvpNote[] = [];
  let syllables = 0;

  track.notes.forEach((note) => {
    const previous = current[current.length - 1];
    const gap = previous ? Math.max(0, note.startSeconds - previous.endSeconds) : 0;
    const groupChanged = Boolean(previous && previous.groupId !== note.groupId);
    const hardBreak = Boolean(previous && syllables >= 3 && (gap >= 0.55 || groupChanged));
    const softBreak = Boolean(previous && syllables >= 8 && gap >= 0.16);
    const lengthBreak = Boolean(previous && syllables >= maximumSyllables && (gap >= 0.04 || syllables >= maximumSyllables + 4));

    if (current.length && (hardBreak || softBreak || lengthBreak)) {
      phrases.push(current);
      current = [];
      syllables = 0;
    }

    current.push(note);
    if (noteAddsSyllable(note)) syllables += 1;
  });

  if (current.length) phrases.push(current);
  return phrases.filter((phrase) => phrase.some(noteAddsSyllable));
}

function tokenFromLabel(label: string, id: string, durationSeconds: number, source: PronunciationToken['source']): PronunciationToken {
  const normalized = label.toLowerCase();
  const absorbed = normalized === 'n' || normalized === 'q' || normalized === 'cl' || normalized === 'っ';
  const long = !absorbed && (durationSeconds >= 0.72 || /[āīūēōː:]$/.test(normalized));
  return {
    id,
    label,
    kind: absorbed ? 'absorbed' : long ? 'long' : 'normal',
    counted: !absorbed,
    source,
  };
}

function isHan(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

function displaySource(notes: SvpNote[]): string {
  const lyrics = notes.filter((note) => note.role === 'normal').map((note) => note.lyric);
  const chinese = lyrics.filter(isHan).length > lyrics.length / 2;
  return chinese ? lyrics.join('') : lyrics.join(' ');
}

async function phraseTokensAndTarget(notes: SvpNote[], language: string, chineseContent: boolean, phraseIndex: number): Promise<{ tokens: PronunciationToken[]; target: string[] }> {
  const tokens: PronunciationToken[] = [];
  const target: string[] = [];

  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index];
    if (note.role === 'hold') {
      target.push('—');
      continue;
    }
    if (note.role === 'breath') continue;
    if (note.role === 'syllable') {
      tokens.push(tokenFromLabel('+', `svp-${phraseIndex}-${index}`, note.durationSeconds, 'manual'));
      target.push('');
      continue;
    }

    let plusCount = 0;
    while (notes[index + plusCount + 1]?.role === 'syllable') plusCount += 1;
    const slotCount = plusCount + 1;
    let labels: string[] = [];

    if (note.phonemes) {
      labels = [note.phonemes.replace(/\s+/g, '·')];
    } else if (chineseContent && isHan(note.lyric)) {
      labels = [pinyin(note.lyric, { toneType: 'none' })];
    } else if (slotCount > 1 && /^[A-Za-z'’-]+$/.test(note.lyric)) {
      try {
        const parsed = await parseLyricLine(note.lyric, phraseIndex * 1000 + index);
        labels = parsed.tokens.filter((token) => token.counted).map((token) => token.label);
      } catch {
        labels = [];
      }
    }

    if (!labels.length) labels = [note.lyric];
    while (labels.length < slotCount) labels.push('+');
    labels = labels.slice(0, slotCount);

    labels.forEach((label, slotIndex) => {
      const slotNote = notes[index + slotIndex];
      const source: PronunciationToken['source'] = language === 'japanese' ? 'ja' : language === 'english' ? 'en' : 'manual';
      const token = tokenFromLabel(label, `svp-${phraseIndex}-${index}-${slotIndex}`, slotNote.durationSeconds, source);
      tokens.push(token);
      if (token.counted) {
        const chineseCharacters = slotIndex === 0 ? Array.from(note.lyric).filter(isHan) : [];
        target.push(chineseCharacters[0] ?? '');
      } else {
        target.push('—');
      }
    });
    index += plusCount;
  }

  return { tokens, target };
}

export async function importSvpTrack(project: SvpProject, trackId: string, maximumSyllables = 18): Promise<SvpImportedLine[]> {
  const track = project.tracks.find((candidate) => candidate.id === trackId);
  if (!track) throw new Error('没有找到选择的 SVP 轨道');
  const phrases = splitSvpTrack(track, maximumSyllables);

  return Promise.all(phrases.map(async (notes, phraseIndex) => {
    const source = displaySource(notes);
    const visibleLyrics = notes.filter((note) => note.role === 'normal').map((note) => note.lyric);
    const chineseContent = visibleLyrics.filter(isHan).length > visibleLyrics.length / 2;
    const { tokens, target } = await phraseTokensAndTarget(notes, track.language, chineseContent, phraseIndex);
    const language: ParsedLyricLine['language'] = chineseContent
      ? 'zh'
      : track.language === 'english'
        ? 'en'
        : 'ja';
    return {
      source: source || `SVP 第 ${phraseIndex + 1} 句`,
      kana: track.language === 'japanese' ? tokens.map((token) => token.label).join(' ') : '',
      tokens,
      language,
      uncertain: false,
      start: notes[0].startSeconds,
      end: notes[notes.length - 1].endSeconds,
      target: target.length ? target : Array.from({ length: Math.max(1, tokens.filter((token) => token.counted).length) }, () => ''),
      svp: {
        version: project.version,
        trackName: track.name,
        language: track.language,
        notes,
      },
    };
  }));
}
