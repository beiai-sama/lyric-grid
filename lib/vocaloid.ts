import { pinyin } from 'pinyin-pro';
import { ParsedLyricLine, PronunciationToken, parseLyricLine } from './phonetics';

export type VocaloidFormat = 'VSQX' | 'VPR';
export type VocaloidSegmentation = 'conservative' | 'balanced' | 'strict';
export type VocaloidLanguageMode = 'auto' | 'ja' | 'en' | 'zh';

export type VocaloidTempo = { tick: number; bpm: number };

export type VocaloidNote = {
  id: string;
  lyric: string;
  phoneme: string;
  onset: number;
  end: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  pitch: number;
  partId: string;
  role: 'normal' | 'hold' | 'syllable' | 'breath';
  phraseBreakBefore: boolean;
};

export type VocaloidTrack = {
  id: string;
  name: string;
  detectedLanguage: 'zh' | 'ja' | 'latin' | 'mixed';
  languageHint: VocaloidLanguageMode;
  partCount: number;
  notes: VocaloidNote[];
  durationSeconds: number;
};

export type VocaloidProject = {
  format: VocaloidFormat;
  version: string;
  resolution: number;
  tempos: VocaloidTempo[];
  tracks: VocaloidTrack[];
};

export type VocaloidLineMeta = {
  format: VocaloidFormat;
  version: string;
  trackName: string;
  languageMode: VocaloidLanguageMode;
  notes: VocaloidNote[];
};

export type VocaloidImportedLine = ParsedLyricLine & {
  start: number;
  end: number;
  target: string[];
  vocaloid: VocaloidLineMeta;
};

type VprSequence = {
  version?: { major?: number; minor?: number; revision?: number };
  masterTrack?: { tempo?: { events?: Array<{ pos?: number; value?: number }> } };
  tracks?: Array<{
    name?: string;
    type?: number;
    parts?: Array<{
      name?: string;
      pos?: number;
      voice?: { langID?: number };
      notes?: Array<{ lyric?: string; phoneme?: string; pos?: number; duration?: number; number?: number }>;
    }>;
  }>;
};

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function noteRole(lyric: string): VocaloidNote['role'] {
  const normalized = lyric.trim().toLowerCase();
  if (normalized === '-' || normalized === '=' || normalized === 'ー' || normalized === '—') return 'hold';
  if (normalized === '+') return 'syllable';
  if (normalized === 'br' || normalized === 'sil' || normalized === 'pau') return 'breath';
  return 'normal';
}

function isHan(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

function isKana(value: string): boolean {
  return /[\u3040-\u30ff]/u.test(value);
}

function lyricScript(value: string): 'han' | 'kana' | 'latin' | 'other' {
  if (isHan(value)) return 'han';
  if (isKana(value)) return 'kana';
  if (/[A-Za-z]/.test(value)) return 'latin';
  return 'other';
}

function detectTrackLanguage(notes: VocaloidNote[]): VocaloidTrack['detectedLanguage'] {
  const lyrics = notes.filter((note) => note.role === 'normal').map((note) => note.lyric);
  if (!lyrics.length) return 'mixed';
  const han = lyrics.filter(isHan).length;
  const kana = lyrics.filter(isKana).length;
  const latin = lyrics.filter((lyric) => /[A-Za-z]/.test(lyric)).length;
  if (han > lyrics.length * .2 && latin > lyrics.length * .2) return 'mixed';
  if (han > lyrics.length * .45 && kana < lyrics.length * .1) return 'zh';
  if (kana > lyrics.length * .15) return 'ja';
  if (latin > lyrics.length * .5) return 'latin';
  return 'mixed';
}

function normalizeTempos(values: VocaloidTempo[]): VocaloidTempo[] {
  const byTick = new Map<number, VocaloidTempo>();
  values
    .filter((tempo) => Number.isFinite(tempo.tick) && Number.isFinite(tempo.bpm) && tempo.bpm > 0)
    .sort((left, right) => left.tick - right.tick)
    .forEach((tempo) => byTick.set(tempo.tick, tempo));
  const tempos = [...byTick.values()].sort((left, right) => left.tick - right.tick);
  if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, bpm: 120 });
  return tempos;
}

export function vocaloidTickToSeconds(tick: number, resolution: number, tempos: VocaloidTempo[]): number {
  const target = Math.max(0, tick);
  let seconds = 0;
  let previousTick = 0;
  let bpm = tempos[0]?.bpm ?? 120;
  for (const tempo of tempos) {
    if (tempo.tick <= previousTick) {
      bpm = tempo.bpm;
      continue;
    }
    if (tempo.tick >= target) break;
    seconds += ((tempo.tick - previousTick) / resolution) * (60 / bpm);
    previousTick = tempo.tick;
    bpm = tempo.bpm;
  }
  return seconds + ((target - previousTick) / resolution) * (60 / bpm);
}

function decodeXmlText(value: string): string {
  const cdata = value.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)?.[1] ?? value;
  return cdata
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function xmlBlocks(xml: string, names: string[]): string[] {
  const pattern = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const expression = new RegExp(`<(?:[\\w.-]+:)?(?:${pattern})(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?(?:${pattern})>`, 'gi');
  return [...xml.matchAll(expression)].map((match) => match[0]);
}

function xmlText(xml: string, names: string[], fallback = ''): string {
  const pattern = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = xml.match(new RegExp(`<(?:[\\w.-]+:)?(?:${pattern})(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?(?:${pattern})>`, 'i'));
  return match ? decodeXmlText(match[1]) : fallback;
}

function parseVsqxProject(text: string): VocaloidProject {
  const xml = text.replace(/^\uFEFF/, '').trim();
  if (!/<(?:[\w.-]+:)?vsq[34]\b/i.test(xml)) throw new Error('这不是可识别的 VSQX 工程');
  const root = xml.match(/<(?:[\w.-]+:)?(vsq[34])\b/i)?.[1]?.toUpperCase() ?? 'VSQX';
  const version = xmlText(xml, ['version'], root === 'VSQ3' ? '3' : '4');
  const master = xmlBlocks(xml, ['masterTrack'])[0] ?? '';
  const resolution = Math.max(1, Number(xmlText(master, ['resolution'], '480')) || 480);
  const tempos = normalizeTempos(xmlBlocks(master, ['tempo']).map((block) => ({
    tick: Number(xmlText(block, ['t', 'posTick'], '0')) || 0,
    bpm: Math.max(1, (Number(xmlText(block, ['v', 'bpm'], '12000')) || 12000) / 100),
  })));

  const tracks = xmlBlocks(xml, ['vsTrack']).map((trackXml, trackIndex): VocaloidTrack | undefined => {
    const trackName = xmlText(trackXml, ['name', 'trackName'], `轨道 ${trackIndex + 1}`);
    const partBlocks = xmlBlocks(trackXml, ['vsPart', 'musicalPart']);
    const notes = partBlocks.flatMap((partXml, partIndex) => {
      const partStart = Number(xmlText(partXml, ['t', 'posTick'], '0')) || 0;
      const partId = `vsqx-${trackIndex}-part-${partIndex}`;
      return xmlBlocks(partXml, ['note']).map((noteXml, noteIndex): VocaloidNote | undefined => {
        const relativeOnset = Number(xmlText(noteXml, ['t', 'posTick'], '0')) || 0;
        const duration = Math.max(0, Number(xmlText(noteXml, ['dur', 'durTick'], '0')) || 0);
        if (!duration) return undefined;
        const onset = partStart + relativeOnset;
        const end = onset + duration;
        const lyric = xmlText(noteXml, ['y', 'lyric'], 'a') || 'a';
        const startSeconds = vocaloidTickToSeconds(onset, resolution, tempos);
        const endSeconds = vocaloidTickToSeconds(end, resolution, tempos);
        return {
          id: `${partId}-note-${noteIndex}`,
          lyric,
          phoneme: xmlText(noteXml, ['p', 'phnms']),
          onset,
          end,
          startSeconds,
          endSeconds,
          durationSeconds: Math.max(0, endSeconds - startSeconds),
          pitch: Number(xmlText(noteXml, ['n', 'noteNum'], '60')) || 60,
          partId,
          role: noteRole(lyric),
          phraseBreakBefore: noteIndex === 0 && partIndex > 0,
        };
      }).filter((note): note is VocaloidNote => Boolean(note));
    }).sort((left, right) => left.onset - right.onset || left.pitch - right.pitch);
    if (!notes.length) return undefined;
    return {
      id: `vocaloid-track-${trackIndex}`,
      name: trackName || `轨道 ${trackIndex + 1}`,
      detectedLanguage: detectTrackLanguage(notes),
      languageHint: 'auto',
      partCount: partBlocks.length,
      notes,
      durationSeconds: Math.max(0, notes[notes.length - 1].endSeconds - notes[0].startSeconds),
    };
  }).filter((track): track is VocaloidTrack => Boolean(track));

  if (!tracks.length) throw new Error('VSQX 里没有可读取的歌唱音符');
  return { format: 'VSQX', version, resolution, tempos, tracks };
}

function readU16LE(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

function readU32LE(data: Uint8Array, offset: number): number {
  return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

async function unzipSequenceJson(buffer: ArrayBuffer): Promise<string> {
  const data = new Uint8Array(buffer);
  let eocd = -1;
  for (let offset = Math.max(0, data.length - 65_557); offset <= data.length - 22; offset += 1) {
    if (readU32LE(data, offset) === 0x06054b50) eocd = offset;
  }
  if (eocd < 0) throw new Error('VPR 压缩目录不完整');
  const entryCount = readU16LE(data, eocd + 10);
  let offset = readU32LE(data, eocd + 16);
  const decoder = new TextDecoder('utf-8');
  for (let index = 0; index < entryCount; index += 1) {
    if (readU32LE(data, offset) !== 0x02014b50) throw new Error('VPR 文件目录无法识别');
    const method = readU16LE(data, offset + 10);
    const compressedSize = readU32LE(data, offset + 20);
    const fileNameLength = readU16LE(data, offset + 28);
    const extraLength = readU16LE(data, offset + 30);
    const commentLength = readU16LE(data, offset + 32);
    const localOffset = readU32LE(data, offset + 42);
    const name = decoder.decode(data.slice(offset + 46, offset + 46 + fileNameLength)).replace(/\\/g, '/');
    if (/^(?:Project\/)?sequence\.json$/i.test(name)) {
      if (readU32LE(data, localOffset) !== 0x04034b50) throw new Error('VPR 歌唱数据入口损坏');
      const localNameLength = readU16LE(data, localOffset + 26);
      const localExtraLength = readU16LE(data, localOffset + 28);
      const payloadStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = data.slice(payloadStart, payloadStart + compressedSize);
      if (method === 0) return decoder.decode(compressed);
      if (method !== 8 || typeof DecompressionStream === 'undefined') throw new Error('当前浏览器无法解压这个 VPR 工程');
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return decoder.decode(await new Response(stream).arrayBuffer());
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  throw new Error('VPR 里没有找到 sequence.json');
}

function languageFromVprId(value: unknown): VocaloidLanguageMode {
  const id = finiteNumber(value, -1);
  if (id === 0) return 'ja';
  if (id === 1) return 'en';
  if (id === 4) return 'zh';
  return 'auto';
}

async function parseVprProject(buffer: ArrayBuffer): Promise<VocaloidProject> {
  const raw = JSON.parse(await unzipSequenceJson(buffer)) as VprSequence;
  if (!raw || !Array.isArray(raw.tracks)) throw new Error('这不是可识别的 VPR 工程');
  const resolution = 480;
  const tempos = normalizeTempos((raw.masterTrack?.tempo?.events ?? []).map((event) => ({
    tick: finiteNumber(event.pos),
    bpm: Math.max(1, finiteNumber(event.value, 12_000) / 100),
  })));
  const versionParts = raw.version ? [raw.version.major, raw.version.minor, raw.version.revision].filter((value) => value != null) : [];
  const version = versionParts.length ? versionParts.join('.') : '5';
  const tracks = raw.tracks.map((track, trackIndex): VocaloidTrack | undefined => {
    if (track.type != null && track.type !== 0) return undefined;
    const parts = track.parts ?? [];
    const languageHints = parts.map((part) => languageFromVprId(part.voice?.langID)).filter((value) => value !== 'auto');
    const languageHint = languageHints[0] ?? 'auto';
    const notes = parts.flatMap((part, partIndex) => {
      const partStart = finiteNumber(part.pos);
      const partId = `vpr-${trackIndex}-part-${partIndex}`;
      return (part.notes ?? []).map((note, noteIndex): VocaloidNote | undefined => {
        const duration = Math.max(0, finiteNumber(note.duration));
        if (!duration) return undefined;
        const onset = partStart + finiteNumber(note.pos);
        const end = onset + duration;
        const lyric = String(note.lyric ?? '').trim() || 'a';
        const startSeconds = vocaloidTickToSeconds(onset, resolution, tempos);
        const endSeconds = vocaloidTickToSeconds(end, resolution, tempos);
        return {
          id: `${partId}-note-${noteIndex}`,
          lyric,
          phoneme: String(note.phoneme ?? '').trim(),
          onset,
          end,
          startSeconds,
          endSeconds,
          durationSeconds: Math.max(0, endSeconds - startSeconds),
          pitch: finiteNumber(note.number, 60),
          partId,
          role: noteRole(lyric),
          phraseBreakBefore: noteIndex === 0 && partIndex > 0,
        };
      }).filter((note): note is VocaloidNote => Boolean(note));
    }).sort((left, right) => left.onset - right.onset || left.pitch - right.pitch);
    if (!notes.length) return undefined;
    return {
      id: `vocaloid-track-${trackIndex}`,
      name: String(track.name ?? '').trim() || `轨道 ${trackIndex + 1}`,
      detectedLanguage: detectTrackLanguage(notes),
      languageHint,
      partCount: parts.length,
      notes,
      durationSeconds: Math.max(0, notes[notes.length - 1].endSeconds - notes[0].startSeconds),
    };
  }).filter((track): track is VocaloidTrack => Boolean(track));
  if (!tracks.length) throw new Error('VPR 里没有可读取的歌唱音符');
  return { format: 'VPR', version, resolution, tempos, tracks };
}

export async function parseVocaloidProject(fileName: string, buffer: ArrayBuffer): Promise<VocaloidProject> {
  if (/\.vsqx$/i.test(fileName)) return parseVsqxProject(new TextDecoder('utf-8').decode(buffer));
  if (/\.vpr$/i.test(fileName)) return parseVprProject(buffer);
  throw new Error('目前支持 VSQX 与 VPR；VSPX 需要真实样品后再适配');
}

function noteAddsSyllable(note: VocaloidNote): boolean {
  return note.role === 'normal' || note.role === 'syllable';
}

export function splitVocaloidTrack(track: VocaloidTrack, maximumSyllables = 18, segmentation: VocaloidSegmentation = 'balanced'): VocaloidNote[][] {
  const phrases: VocaloidNote[][] = [];
  let current: VocaloidNote[] = [];
  let syllables = 0;
  const threshold = {
    conservative: { hard: .6, medium: .38, soft: .2, partMinimum: 5 },
    balanced: { hard: .48, medium: .24, soft: .1, partMinimum: 3 },
    strict: { hard: .36, medium: .15, soft: .05, partMinimum: 2 },
  }[segmentation];

  track.notes.forEach((note) => {
    const previous = current[current.length - 1];
    const previousLyric = [...current].reverse().find((candidate) => candidate.role === 'normal');
    const gap = previous ? Math.max(0, note.startSeconds - previous.endSeconds) : 0;
    const partBreak = Boolean(previous && note.phraseBreakBefore && syllables >= threshold.partMinimum);
    const punctuationBreak = Boolean(previousLyric && /[。！？!?、，,；;：:]$/u.test(previousLyric.lyric));
    const scriptChanged = Boolean(previousLyric && lyricScript(note.lyric) !== lyricScript(previousLyric.lyric));
    const hardBreak = Boolean(previous && syllables >= 2 && gap >= threshold.hard);
    const mediumBreak = Boolean(previous && syllables >= 4 && gap >= threshold.medium);
    const softBreak = Boolean(previous && syllables >= 8 && gap >= threshold.soft);
    const scriptBreak = Boolean(previous && syllables >= 4 && scriptChanged && gap >= .04);
    const lengthBreak = Boolean(previous && syllables >= maximumSyllables);
    if (current.length && note.role === 'normal' && (partBreak || punctuationBreak || hardBreak || mediumBreak || softBreak || scriptBreak || lengthBreak)) {
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

function sourceForLanguage(mode: VocaloidLanguageMode): PronunciationToken['source'] {
  if (mode === 'ja') return 'ja';
  if (mode === 'en') return 'en';
  return 'manual';
}

function tokenFromLabel(label: string, id: string, durationSeconds: number, source: PronunciationToken['source']): PronunciationToken {
  const normalized = label.toLowerCase();
  const absorbed = normalized === 'n' || normalized === 'q' || normalized === 'cl' || normalized === 'っ';
  const long = !absorbed && (durationSeconds >= .72 || /[āīūēōː:]$/.test(normalized));
  return { id, label, kind: absorbed ? 'absorbed' : long ? 'long' : 'normal', counted: !absorbed, source };
}

async function labelForNote(note: VocaloidNote, languageMode: VocaloidLanguageMode, phraseIndex: number, noteIndex: number): Promise<string> {
  if (isHan(note.lyric)) return pinyin(note.lyric, { toneType: 'none', type: 'array' }).join('');
  if (isKana(note.lyric) || languageMode === 'ja') {
    try {
      const parsed = await parseLyricLine(note.lyric, phraseIndex * 10_000 + noteIndex);
      const labels = parsed.tokens.filter((token) => token.counted).map((token) => token.label);
      if (labels.length) return labels.join('+');
    } catch {
      // Preserve the note lyric when the local Japanese dictionary cannot parse it.
    }
  }
  return note.lyric || note.phoneme.replace(/\s+/g, '·') || 'a';
}

function displaySource(notes: VocaloidNote[]): string {
  const lyrics = notes.filter((note) => note.role === 'normal').map((note) => note.lyric);
  const joinedScript = lyrics.filter((lyric) => isHan(lyric) || isKana(lyric)).length > lyrics.length / 2;
  return joinedScript ? lyrics.join('') : lyrics.join(' ');
}

export async function importVocaloidPhrase(meta: Omit<VocaloidLineMeta, 'notes'>, notes: VocaloidNote[], phraseIndex = 0): Promise<VocaloidImportedLine> {
  const tokens: PronunciationToken[] = [];
  const target: string[] = [];
  const normalNotes = notes.filter((note) => note.role === 'normal');
  const chineseContent = normalNotes.filter((note) => isHan(note.lyric)).length > normalNotes.length / 2;
  const kanaContent = normalNotes.filter((note) => isKana(note.lyric)).length > normalNotes.length * .15;
  const effectiveLanguage: VocaloidLanguageMode = meta.languageMode !== 'auto' ? meta.languageMode : chineseContent ? 'zh' : kanaContent ? 'ja' : 'auto';

  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index];
    if (note.role === 'hold') {
      target.push('—');
      continue;
    }
    if (note.role === 'breath') continue;
    const label = note.role === 'syllable' ? '+' : await labelForNote(note, effectiveLanguage, phraseIndex, index);
    const value = tokenFromLabel(label, `vocaloid-${phraseIndex}-${index}`, note.durationSeconds, sourceForLanguage(effectiveLanguage));
    tokens.push(value);
    if (value.counted) {
      const characters = Array.from(note.lyric).filter(isHan);
      target.push(characters[0] ?? '');
    } else {
      target.push('—');
    }
  }

  const language: ParsedLyricLine['language'] = chineseContent ? 'zh' : effectiveLanguage === 'en' ? 'en' : effectiveLanguage === 'ja' ? 'ja' : 'mixed';
  return {
    source: displaySource(notes) || `${meta.format} 第 ${phraseIndex + 1} 句`,
    kana: effectiveLanguage === 'ja' ? tokens.map((item) => item.label).join(' ') : '',
    tokens,
    language,
    uncertain: effectiveLanguage === 'auto',
    start: notes[0].startSeconds,
    end: notes[notes.length - 1].endSeconds,
    target: target.length ? target : Array.from({ length: Math.max(1, tokens.filter((item) => item.counted).length) }, () => ''),
    vocaloid: { ...meta, languageMode: effectiveLanguage, notes },
  };
}

export async function importVocaloidTrack(project: VocaloidProject, trackId: string, maximumSyllables = 18, segmentation: VocaloidSegmentation = 'balanced', languageMode: VocaloidLanguageMode = 'auto'): Promise<VocaloidImportedLine[]> {
  const track = project.tracks.find((candidate) => candidate.id === trackId);
  if (!track) throw new Error('没有找到选择的 VOCALOID 轨道');
  const phrases = splitVocaloidTrack(track, maximumSyllables, segmentation);
  const selectedLanguage = languageMode === 'auto' ? track.languageHint : languageMode;
  const meta = { format: project.format, version: project.version, trackName: track.name, languageMode: selectedLanguage };
  return Promise.all(phrases.map((notes, phraseIndex) => importVocaloidPhrase(meta, notes, phraseIndex)));
}
