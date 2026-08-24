export type SubtitleCue = {
  index: number;
  start: number;
  end: number;
  lines: string[];
};

function parseTimestamp(value: string): number | undefined {
  const match = value.trim().match(/^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) return undefined;
  const [, hours, minutes, seconds, milliseconds] = match;
  return Number(hours) * 3600
    + Number(minutes) * 60
    + Number(seconds)
    + Number(milliseconds.padEnd(3, '0').slice(0, 3)) / 1000;
}

function cleanSubtitleLine(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\\[^}]+\}/g, '')
    .trim();
}

export function parseSrt(value: string): SubtitleCue[] {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((block, blockIndex) => {
      const rows = block.split('\n').map((row) => row.trimEnd());
      const timingIndex = rows.findIndex((row) => row.includes('-->'));
      if (timingIndex < 0) return undefined;
      const [startText, endText] = rows[timingIndex].split(/\s*-->\s*/);
      const start = parseTimestamp(startText);
      const end = parseTimestamp(endText?.split(/\s+/)[0] ?? '');
      if (start == null || end == null || end <= start) return undefined;
      const lines = rows.slice(timingIndex + 1).map(cleanSubtitleLine).filter(Boolean);
      if (!lines.length) return undefined;
      return {
        index: Number(rows[0]) || blockIndex + 1,
        start,
        end,
        lines,
      } satisfies SubtitleCue;
    })
    .filter((cue): cue is SubtitleCue => Boolean(cue))
    .sort((left, right) => left.start - right.start);
}

function lrcTimestampToSeconds(match: RegExpMatchArray): number {
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  const fraction = match[4] ? Number(`0.${match[4]}`) : 0;
  return hours * 3600 + minutes * 60 + seconds + fraction;
}

export function parseLrc(value: string): SubtitleCue[] {
  const normalized = value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const offsetMilliseconds = Number(normalized.match(/\[offset\s*:\s*([+-]?\d+)\s*\]/i)?.[1] ?? 0);
  const grouped = new Map<number, { start: number; lines: string[] }>();
  const timestampPattern = /\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

  normalized.split('\n').forEach((row) => {
    const matches = Array.from(row.matchAll(timestampPattern));
    if (!matches.length) return;
    const lyric = cleanSubtitleLine(
      row
        .replace(timestampPattern, '')
        .replace(/<(?:(?:\d{1,2}):)?\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, ''),
    );
    if (!lyric) return;

    matches.forEach((match) => {
      const start = Math.max(0, lrcTimestampToSeconds(match) + offsetMilliseconds / 1000);
      const key = Math.round(start * 1000);
      const group = grouped.get(key) ?? { start, lines: [] };
      if (!group.lines.includes(lyric)) group.lines.push(lyric);
      grouped.set(key, group);
    });
  });

  const groups = Array.from(grouped.values()).sort((left, right) => left.start - right.start);
  return groups.map((group, index) => ({
    index: index + 1,
    start: group.start,
    end: groups[index + 1]?.start ?? group.start + 5,
    lines: group.lines,
  }));
}

export function normalizeLyric(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function bigrams(value: string): string[] {
  if (value.length < 2) return value ? [value] : [];
  return Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2));
}

export function lyricSimilarity(left: string, right: string): number {
  const a = normalizeLyric(left);
  const b = normalizeLyric(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const leftPairs = bigrams(a);
  const rightPairs = bigrams(b);
  const available = [...rightPairs];
  let overlap = 0;
  leftPairs.forEach((pair) => {
    const index = available.indexOf(pair);
    if (index >= 0) {
      overlap += 1;
      available.splice(index, 1);
    }
  });
  return (2 * overlap) / Math.max(1, leftPairs.length + rightPairs.length);
}

function hasKana(value: string): boolean {
  return /[\u3040-\u30ff]/.test(value);
}

function hasLatin(value: string): boolean {
  return /[A-Za-z]/.test(value);
}

function hasHan(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

export function recognizeSubtitleText(cue: SubtitleCue, knownSource?: string): { source: string; target?: string; similarity: number } {
  let sourceIndex = -1;
  let similarity = 0;

  if (knownSource) {
    cue.lines.forEach((line, index) => {
      const score = lyricSimilarity(line, knownSource);
      if (score > similarity) {
        sourceIndex = index;
        similarity = score;
      }
    });
    if (similarity < 0.45) sourceIndex = -1;
  }

  if (sourceIndex < 0 && !knownSource) {
    sourceIndex = cue.lines.findIndex(hasKana);
    if (sourceIndex < 0) sourceIndex = cue.lines.findIndex(hasLatin);
    if (sourceIndex < 0) sourceIndex = 0;
  }

  const source = sourceIndex >= 0 ? cue.lines[sourceIndex] : knownSource ?? cue.lines[0];
  const targetCandidates = cue.lines.filter((line, index) => index !== sourceIndex && hasHan(line) && !hasKana(line));
  const target = targetCandidates[0]
    ?? (sourceIndex < 0 ? cue.lines.find((line) => hasHan(line) && !hasKana(line) && !hasLatin(line)) : undefined);

  return { source, target, similarity };
}

export function targetTextToCells(value: string): string[] {
  return Array.from(value).filter((character) => /[\p{Script=Han}A-Za-z0-9—]/u.test(character));
}
