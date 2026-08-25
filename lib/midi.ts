import { pinyin } from 'pinyin-pro';
import { ParsedLyricLine, PronunciationToken, parseLyricLine } from './phonetics';

export type MidiTextEncoding = 'auto' | 'utf-8' | 'shift_jis' | 'gb18030';
export type MidiSegmentation = 'conservative' | 'balanced' | 'strict';
export type MidiPolyphonyMode = 'melody' | 'all';
export type MidiLanguageMode = 'auto' | 'ja' | 'en' | 'zh';

type MidiTimebase =
  | { kind: 'ppq'; ticksPerQuarter: number }
  | { kind: 'smpte'; framesPerSecond: number; ticksPerFrame: number };

export type MidiTempo = { tick: number; microsecondsPerQuarter: number; bpm: number };

export type MidiNote = {
  id: string;
  lyric: string;
  onset: number;
  end: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  pitch: number;
  channel: number;
  role: 'normal' | 'hold' | 'syllable' | 'breath';
  phraseBreakBefore: boolean;
};

export type MidiTrack = {
  id: string;
  name: string;
  detectedLanguage: 'zh' | 'ja' | 'latin' | 'mixed';
  notes: MidiNote[];
  embeddedLyricCount: number;
  hasEmbeddedLyrics: boolean;
  maxPolyphony: number;
  channels: number[];
  durationSeconds: number;
};

export type MidiProject = {
  format: number;
  declaredTracks: number;
  timebase: MidiTimebase;
  tempos: MidiTempo[];
  tracks: MidiTrack[];
  durationSeconds: number;
};

export type MidiLineMeta = {
  format: number;
  trackName: string;
  hasEmbeddedLyrics: boolean;
  polyphonyMode: MidiPolyphonyMode;
  languageMode: MidiLanguageMode;
  notes: MidiNote[];
};

export type MidiImportedLine = ParsedLyricLine & {
  start: number;
  end: number;
  target: string[];
  midi: MidiLineMeta;
};

type RawTextEvent = { tick: number; bytes: Uint8Array };
type RawTempo = { tick: number; microsecondsPerQuarter: number };
type RawNote = { id: string; onset: number; end: number; pitch: number; channel: number };
type RawTrack = {
  nameBytes?: Uint8Array;
  lyrics: RawTextEvent[];
  texts: RawTextEvent[];
  tempos: RawTempo[];
  notes: RawNote[];
  channels: Set<number>;
  endTick: number;
};

function readU16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function readU32(data: Uint8Array, offset: number): number {
  return (((data[offset] << 24) >>> 0) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

function readVlq(data: Uint8Array, state: { offset: number }): number {
  let value = 0;
  for (let index = 0; index < 4; index += 1) {
    if (state.offset >= data.length) throw new Error('MIDI 事件长度不完整');
    const byte = data[state.offset++];
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return value;
  }
  return value;
}

function textScore(value: string): number {
  let score = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '\ufffd') score += 100;
    else if (code < 32 && !'\t\r\n'.includes(character)) score += 20;
    else if ('ÃÂ�'.includes(character)) score += 5;
  }
  return score;
}

function decodeMidiText(bytes: Uint8Array | undefined, encoding: MidiTextEncoding): string {
  if (!bytes?.length) return '';
  const encodings = encoding === 'auto' ? ['utf-8', 'shift_jis', 'gb18030', 'windows-1252'] : [encoding];
  const candidates = encodings.map((candidate, index) => {
    try {
      const value = new TextDecoder(candidate).decode(bytes).replace(/\u0000/g, '').trim();
      return { value, score: textScore(value), index };
    } catch {
      return { value: '', score: Number.POSITIVE_INFINITY, index };
    }
  }).sort((left, right) => left.score - right.score || left.index - right.index);
  return candidates[0]?.value ?? '';
}

function parseRawTrack(data: Uint8Array, trackIndex: number): RawTrack {
  const state = { offset: 0 };
  let tick = 0;
  let runningStatus = 0;
  let nameBytes: Uint8Array | undefined;
  const lyrics: RawTextEvent[] = [];
  const texts: RawTextEvent[] = [];
  const tempos: RawTempo[] = [];
  const notes: RawNote[] = [];
  const channels = new Set<number>();
  const active = new Map<string, RawNote[]>();

  while (state.offset < data.length) {
    tick += readVlq(data, state);
    if (state.offset >= data.length) break;
    let status = data[state.offset++];
    let firstData: number | undefined;
    if (status < 0x80) {
      if (!runningStatus) throw new Error(`第 ${trackIndex + 1} 轨的运行状态无效`);
      firstData = status;
      status = runningStatus;
    } else if (status < 0xf0) {
      runningStatus = status;
    }

    if (status === 0xff) {
      runningStatus = 0;
      if (state.offset >= data.length) break;
      const type = data[state.offset++];
      const length = readVlq(data, state);
      if (state.offset + length > data.length) throw new Error(`第 ${trackIndex + 1} 轨的 Meta 事件不完整`);
      const payload = data.slice(state.offset, state.offset + length);
      state.offset += length;
      if (type === 0x03 && !nameBytes) nameBytes = payload;
      if (type === 0x01) texts.push({ tick, bytes: payload });
      if (type === 0x05) lyrics.push({ tick, bytes: payload });
      if (type === 0x51 && payload.length === 3) {
        const microsecondsPerQuarter = (payload[0] << 16) | (payload[1] << 8) | payload[2];
        if (microsecondsPerQuarter > 0) tempos.push({ tick, microsecondsPerQuarter });
      }
      if (type === 0x2f) break;
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      runningStatus = 0;
      const length = readVlq(data, state);
      if (state.offset + length > data.length) throw new Error(`第 ${trackIndex + 1} 轨的 SysEx 事件不完整`);
      state.offset += length;
      continue;
    }

    if (status >= 0xf0) {
      runningStatus = 0;
      const systemLengths: Record<number, number> = { 0xf1: 1, 0xf2: 2, 0xf3: 1, 0xf6: 0, 0xf8: 0, 0xfa: 0, 0xfb: 0, 0xfc: 0, 0xfe: 0 };
      state.offset += systemLengths[status] ?? 0;
      continue;
    }

    const command = status & 0xf0;
    const channel = status & 0x0f;
    const dataLength = command === 0xc0 || command === 0xd0 ? 1 : 2;
    const data1 = firstData ?? data[state.offset++];
    const data2 = dataLength === 2 ? data[state.offset++] : 0;
    channels.add(channel + 1);

    if (command === 0x90 && data2 > 0) {
      const note: RawNote = { id: `midi-${trackIndex}-${notes.length}`, onset: tick, end: tick + 1, pitch: data1, channel: channel + 1 };
      notes.push(note);
      const key = `${channel}:${data1}`;
      const stack = active.get(key) ?? [];
      stack.push(note);
      active.set(key, stack);
    } else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
      const stack = active.get(`${channel}:${data1}`);
      const note = stack?.shift();
      if (note) note.end = Math.max(note.onset + 1, tick);
    }
  }

  active.forEach((stack) => stack.forEach((note) => { note.end = Math.max(note.onset + 1, tick); }));
  return { nameBytes, lyrics, texts, tempos, notes, channels, endTick: tick };
}

function normalizeTempos(raw: RawTempo[]): MidiTempo[] {
  const byTick = new Map<number, RawTempo>();
  raw.sort((left, right) => left.tick - right.tick).forEach((tempo) => byTick.set(tempo.tick, tempo));
  const tempos = [...byTick.values()].sort((left, right) => left.tick - right.tick);
  if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, microsecondsPerQuarter: 500_000 });
  return tempos.map((tempo) => ({ ...tempo, bpm: 60_000_000 / tempo.microsecondsPerQuarter }));
}

function tickToSeconds(tick: number, timebase: MidiTimebase, tempos: MidiTempo[]): number {
  if (timebase.kind === 'smpte') return tick / (timebase.framesPerSecond * timebase.ticksPerFrame);
  let seconds = 0;
  let previousTick = 0;
  let microsecondsPerQuarter = tempos[0]?.microsecondsPerQuarter ?? 500_000;
  for (const tempo of tempos) {
    if (tempo.tick <= previousTick) {
      microsecondsPerQuarter = tempo.microsecondsPerQuarter;
      continue;
    }
    if (tempo.tick >= tick) break;
    seconds += ((tempo.tick - previousTick) / timebase.ticksPerQuarter) * (microsecondsPerQuarter / 1_000_000);
    previousTick = tempo.tick;
    microsecondsPerQuarter = tempo.microsecondsPerQuarter;
  }
  return seconds + ((tick - previousTick) / timebase.ticksPerQuarter) * (microsecondsPerQuarter / 1_000_000);
}

function lyricRole(value: string): MidiNote['role'] {
  const lyric = value.trim().toLowerCase();
  if (lyric === '-' || lyric === '=') return 'hold';
  if (lyric === '+') return 'syllable';
  if (lyric === 'br' || lyric === 'sil' || lyric === 'pau' || lyric === 'sp') return 'breath';
  return 'normal';
}

function normalizeLyric(value: string): { lyric: string; breakBefore: boolean; controlOnly: boolean } {
  const breakBefore = /^[\\/\r\n]/.test(value);
  const lyric = value.replace(/^[\\/\r\n]+/, '').replace(/[\r\n]+/g, ' ').trim();
  return { lyric, breakBefore, controlOnly: !lyric || /^@[A-Z]/i.test(lyric) };
}

function calculateMaxPolyphony(notes: RawNote[]): number {
  const events = notes.flatMap((note) => [{ tick: note.onset, delta: 1 }, { tick: note.end, delta: -1 }])
    .sort((left, right) => left.tick - right.tick || left.delta - right.delta);
  let current = 0;
  let maximum = 0;
  events.forEach((event) => {
    current = Math.max(0, current + event.delta);
    maximum = Math.max(maximum, current);
  });
  return maximum;
}

function detectLanguage(notes: MidiNote[]): MidiTrack['detectedLanguage'] {
  const lyrics = notes.filter((note) => note.role === 'normal' && note.lyric !== 'la').map((note) => note.lyric);
  if (!lyrics.length) return 'mixed';
  const han = lyrics.filter((lyric) => /\p{Script=Han}/u.test(lyric)).length;
  const kana = lyrics.filter((lyric) => /[\u3040-\u30ff]/.test(lyric)).length;
  const latin = lyrics.filter((lyric) => /[A-Za-z]/.test(lyric)).length;
  if (han > lyrics.length * .2 && (latin > lyrics.length * .2 || kana > lyrics.length * .2)) return 'mixed';
  if (han > lyrics.length * .5) return 'zh';
  if (kana > lyrics.length * .2) return 'ja';
  if (latin > lyrics.length * .5) return 'latin';
  return 'mixed';
}

function buildTrack(raw: RawTrack, trackIndex: number, timebase: MidiTimebase, tempos: MidiTempo[], encoding: MidiTextEncoding): MidiTrack | undefined {
  if (!raw.notes.length) return undefined;
  const decodedEvents = raw.lyrics
    .map((event) => ({ tick: event.tick, ...normalizeLyric(decodeMidiText(event.bytes, encoding)) }))
    .filter((event) => !event.controlOnly || event.breakBefore)
    .sort((left, right) => left.tick - right.tick);
  const hasEmbeddedLyrics = decodedEvents.some((event) => !event.controlOnly);
  const noteLyrics = new Map<string, { lyric: string; breakBefore: boolean }>();
  const notesByTick = new Map<number, RawNote[]>();
  raw.notes.forEach((note) => {
    const group = notesByTick.get(note.onset) ?? [];
    group.push(note);
    group.sort((left, right) => right.pitch - left.pitch);
    notesByTick.set(note.onset, group);
  });
  let pendingBreak = false;
  decodedEvents.forEach((event) => {
    if (event.controlOnly) {
      pendingBreak ||= event.breakBefore;
      return;
    }
    const exact = notesByTick.get(event.tick) ?? [];
    let note = exact.find((candidate) => !noteLyrics.has(candidate.id));
    if (!note) {
      note = raw.notes.find((candidate) => candidate.onset >= event.tick && !noteLyrics.has(candidate.id));
      if (note && timebase.kind === 'ppq' && note.onset - event.tick > timebase.ticksPerQuarter) note = undefined;
    }
    if (note) {
      noteLyrics.set(note.id, { lyric: event.lyric, breakBefore: pendingBreak || event.breakBefore });
      pendingBreak = false;
    }
  });

  const notes = raw.notes
    .sort((left, right) => left.onset - right.onset || right.pitch - left.pitch)
    .map((note): MidiNote => {
      const matched = noteLyrics.get(note.id);
      const lyric = matched?.lyric || (hasEmbeddedLyrics ? '-' : 'la');
      const startSeconds = tickToSeconds(note.onset, timebase, tempos);
      const endSeconds = tickToSeconds(note.end, timebase, tempos);
      return {
        ...note,
        lyric,
        startSeconds,
        endSeconds,
        durationSeconds: Math.max(0, endSeconds - startSeconds),
        role: lyricRole(lyric),
        phraseBreakBefore: matched?.breakBefore ?? false,
      };
    });
  const start = notes[0].startSeconds;
  const end = Math.max(...notes.map((note) => note.endSeconds));
  return {
    id: `midi-track-${trackIndex}`,
    name: decodeMidiText(raw.nameBytes, encoding) || `轨道 ${trackIndex + 1}`,
    detectedLanguage: detectLanguage(notes),
    notes,
    embeddedLyricCount: noteLyrics.size,
    hasEmbeddedLyrics,
    maxPolyphony: calculateMaxPolyphony(raw.notes),
    channels: [...raw.channels].sort((left, right) => left - right),
    durationSeconds: Math.max(0, end - start),
  };
}

export function parseMidiProject(buffer: ArrayBuffer, encoding: MidiTextEncoding = 'auto'): MidiProject {
  const data = new Uint8Array(buffer);
  if (data.length < 14 || String.fromCharCode(...data.slice(0, 4)) !== 'MThd') throw new Error('这不是可识别的标准 MIDI 文件');
  const headerLength = readU32(data, 4);
  if (headerLength < 6 || 8 + headerLength > data.length) throw new Error('MIDI 文件头不完整');
  const format = readU16(data, 8);
  const declaredTracks = readU16(data, 10);
  const division = readU16(data, 12);
  const timebase: MidiTimebase = division & 0x8000
    ? { kind: 'smpte', framesPerSecond: Math.max(1, -(division >> 8 << 24 >> 24)), ticksPerFrame: Math.max(1, division & 0xff) }
    : { kind: 'ppq', ticksPerQuarter: Math.max(1, division) };

  let offset = 8 + headerLength;
  const rawTracks: RawTrack[] = [];
  while (offset + 8 <= data.length) {
    const type = String.fromCharCode(...data.slice(offset, offset + 4));
    const length = readU32(data, offset + 4);
    offset += 8;
    if (offset + length > data.length) throw new Error(`${type} 数据块不完整`);
    if (type === 'MTrk') rawTracks.push(parseRawTrack(data.slice(offset, offset + length), rawTracks.length));
    offset += length;
  }
  if (!rawTracks.length) throw new Error('MIDI 中没有轨道数据');
  const tempos = normalizeTempos(rawTracks.flatMap((track) => track.tempos));
  const tracks = rawTracks.map((track, index) => buildTrack(track, index, timebase, tempos, encoding)).filter((track): track is MidiTrack => Boolean(track));
  if (!tracks.length) throw new Error('这个 MIDI 只有空轨，没有可导入的音符');
  return {
    format,
    declaredTracks,
    timebase,
    tempos,
    tracks,
    durationSeconds: Math.max(...tracks.flatMap((track) => track.notes.map((note) => note.endSeconds))),
  };
}

export function midiTrackScore(track: MidiTrack): number {
  const nameBonus = /(vocal|voice|main|melody|singer|歌手|人声|主旋律|洛天依|初音|miku|teto|テト)/i.test(track.name) ? 2_200 : 0;
  const lyricBonus = track.hasEmbeddedLyrics ? 10_000 + track.embeddedLyricCount * 4 : 0;
  const melodyBonus = track.maxPolyphony <= 1 ? 2_500 : track.maxPolyphony === 2 ? 800 : -Math.min(2_400, (track.maxPolyphony - 2) * 400);
  const drumPenalty = track.channels.includes(10) || /(drum|kick|snare|hat|鼓)/i.test(track.name) ? 7_000 : 0;
  return lyricBonus + nameBonus + melodyBonus + Math.min(track.notes.length, 800) - drumPenalty;
}

function notesForMode(track: MidiTrack, mode: MidiPolyphonyMode): MidiNote[] {
  if (mode === 'all' || track.maxPolyphony <= 1) return track.notes;
  const grouped = new Map<number, MidiNote[]>();
  track.notes.forEach((note) => {
    const group = grouped.get(note.onset) ?? [];
    group.push(note);
    grouped.set(note.onset, group);
  });
  return [...grouped.values()].map((group) => group.sort((left, right) => {
    const leftLyric = left.role === 'normal' || left.role === 'syllable' ? 1 : 0;
    const rightLyric = right.role === 'normal' || right.role === 'syllable' ? 1 : 0;
    return rightLyric - leftLyric || right.pitch - left.pitch;
  })[0]).sort((left, right) => left.onset - right.onset || right.pitch - left.pitch);
}

function noteAddsSyllable(note: MidiNote): boolean {
  return note.role === 'normal' || note.role === 'syllable';
}

export function splitMidiTrack(track: MidiTrack, maximumSyllables = 18, segmentation: MidiSegmentation = 'balanced', polyphonyMode: MidiPolyphonyMode = 'melody'): MidiNote[][] {
  const notes = notesForMode(track, polyphonyMode);
  const phrases: MidiNote[][] = [];
  let current: MidiNote[] = [];
  let syllables = 0;
  const threshold = {
    conservative: { hard: .58, medium: .36, soft: .2 },
    balanced: { hard: .5, medium: .25, soft: .1 },
    strict: { hard: .42, medium: .18, soft: .06 },
  }[segmentation];

  notes.forEach((note) => {
    const previous = current[current.length - 1];
    const previousLyric = [...current].reverse().find((candidate) => candidate.role === 'normal');
    const gap = previous ? Math.max(0, note.startSeconds - previous.endSeconds) : 0;
    const punctuationBreak = Boolean(previousLyric && /[。！？!?、，,；;：:]$/u.test(previousLyric.lyric));
    const explicitBreak = Boolean(previous && note.phraseBreakBefore);
    const hardBreak = Boolean(previous && syllables >= 2 && gap >= threshold.hard);
    const mediumBreak = Boolean(previous && syllables >= 4 && gap >= threshold.medium);
    const softBreak = Boolean(previous && syllables >= 8 && gap >= threshold.soft);
    const lengthBreak = Boolean(previous && syllables >= maximumSyllables && gap >= .015);
    const hardLengthBreak = Boolean(previous && syllables >= maximumSyllables + 5);

    if (current.length && note.role !== 'breath' && (explicitBreak || punctuationBreak || hardBreak || mediumBreak || softBreak || lengthBreak || hardLengthBreak)) {
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

function isHan(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

function cleanWordPart(value: string): { word: string; part?: number } {
  const match = value.trim().match(/^(.*?)(?:#(\d+))$/);
  return match ? { word: match[1], part: Number(match[2]) } : { word: value.trim() };
}

function displaySource(notes: MidiNote[], trackName: string, phraseIndex: number, hasLyrics: boolean): string {
  if (!hasLyrics) return `MIDI · ${trackName} · 旋律片段 ${String(phraseIndex + 1).padStart(2, '0')}`;
  const lyrics = notes.filter((note) => note.role === 'normal').map((note) => cleanWordPart(note.lyric).word).filter(Boolean);
  const compact = lyrics.filter((lyric) => isHan(lyric) || /[\u3040-\u30ff]/.test(lyric)).length > lyrics.length / 2;
  const deduplicated = lyrics.filter((lyric, index) => lyric !== lyrics[index - 1]);
  return compact ? lyrics.join('') : deduplicated.join(' ');
}

async function noteLabel(note: MidiNote, languageMode: MidiLanguageMode, phraseIndex: number, noteIndex: number): Promise<string> {
  const { word, part } = cleanWordPart(note.lyric);
  if (isHan(word)) return pinyin(word, { toneType: 'none' });
  if (/[\u3040-\u30ff]/.test(word)) {
    try {
      const parsed = await parseLyricLine(word, phraseIndex * 1000 + noteIndex);
      return parsed.tokens.filter((token) => token.counted).map((token) => token.label).join('·') || word;
    } catch {
      return word;
    }
  }
  if (languageMode === 'en' && /^[A-Za-z'’-]+$/.test(word)) {
    try {
      const parsed = await parseLyricLine(word, phraseIndex * 1000 + noteIndex);
      const labels = parsed.tokens.filter((token) => token.counted).map((token) => token.label);
      if (part && labels[part - 1]) return labels[part - 1];
      return labels.join('·') || word;
    } catch {
      return word;
    }
  }
  return part ? `${word}·${part}` : word || 'la';
}

function tokenFromLabel(label: string, id: string, note: MidiNote, source: PronunciationToken['source']): PronunciationToken {
  const normalized = label.toLowerCase();
  const absorbed = normalized === 'n' || normalized === 'q' || normalized === 'cl' || normalized === 'っ';
  const long = !absorbed && note.durationSeconds >= .72;
  return { id, label, kind: absorbed ? 'absorbed' : long ? 'long' : 'normal', counted: !absorbed, source };
}

export async function importMidiPhrase(meta: Omit<MidiLineMeta, 'notes'>, notes: MidiNote[], phraseIndex = 0): Promise<MidiImportedLine> {
  const target: string[] = [];
  const tokens: PronunciationToken[] = [];
  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index];
    if (note.role === 'hold') {
      target.push('—');
      continue;
    }
    if (note.role === 'breath') continue;
    const label = note.role === 'syllable' ? '+' : await noteLabel(note, meta.languageMode, phraseIndex, index);
    const source: PronunciationToken['source'] = /[\u3040-\u30ff]/.test(note.lyric) || meta.languageMode === 'ja'
      ? 'ja'
      : meta.languageMode === 'en'
        ? 'en'
        : 'manual';
    const token = tokenFromLabel(label, `midi-token-${phraseIndex}-${index}`, note, source);
    tokens.push(token);
    if (token.counted) target.push(isHan(note.lyric) ? Array.from(note.lyric).find(isHan) ?? '' : '');
    else target.push('—');
  }
  const detectedLanguage: ParsedLyricLine['language'] = meta.languageMode === 'zh'
    ? 'zh'
    : meta.languageMode === 'en'
      ? 'en'
      : meta.languageMode === 'ja'
        ? 'ja'
        : notes.some((note) => isHan(note.lyric))
          ? 'zh'
          : notes.some((note) => /[\u3040-\u30ff]/.test(note.lyric))
            ? 'ja'
            : 'mixed';
  return {
    source: displaySource(notes, meta.trackName, phraseIndex, meta.hasEmbeddedLyrics),
    kana: detectedLanguage === 'ja' ? tokens.map((token) => token.label).join(' ') : '',
    tokens,
    language: detectedLanguage,
    uncertain: !meta.hasEmbeddedLyrics || meta.polyphonyMode === 'melody' && notes.some((note, index) => note.onset === notes[index - 1]?.onset),
    start: notes[0].startSeconds,
    end: Math.max(...notes.map((note) => note.endSeconds)),
    target: target.length ? target : Array.from({ length: Math.max(1, tokens.filter((token) => token.counted).length) }, () => ''),
    midi: { ...meta, notes },
  };
}

export async function importMidiTrack(project: MidiProject, trackId: string, maximumSyllables = 18, segmentation: MidiSegmentation = 'balanced', polyphonyMode: MidiPolyphonyMode = 'melody', languageMode: MidiLanguageMode = 'auto'): Promise<MidiImportedLine[]> {
  const track = project.tracks.find((candidate) => candidate.id === trackId);
  if (!track) throw new Error('没有找到选择的 MIDI 轨道');
  const phrases = splitMidiTrack(track, maximumSyllables, segmentation, polyphonyMode);
  const meta = { format: project.format, trackName: track.name, hasEmbeddedLyrics: track.hasEmbeddedLyrics, polyphonyMode, languageMode };
  return Promise.all(phrases.map((notes, phraseIndex) => importMidiPhrase(meta, notes, phraseIndex)));
}
