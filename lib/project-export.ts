import { SvpLineMeta } from './svp';
import { VocaloidLineMeta } from './vocaloid';

export type WritableProject =
  | { kind: 'svp'; fileName: string; sourceText: string; trackId: string }
  | { kind: 'vocaloid'; fileName: string; sourceBuffer: ArrayBuffer; trackId: string };

type ExportLine = {
  target: string[];
  svp?: SvpLineMeta;
  vocaloid?: VocaloidLineMeta;
};

function validLyric(value: string | undefined): string | undefined {
  const lyric = value?.trim();
  return lyric && lyric !== '—' && lyric !== '-' ? lyric : undefined;
}

function lyricMap(lines: ExportLine[], metaKey: 'svp' | 'vocaloid'): Map<string, string> {
  const result = new Map<string, string>();
  lines.forEach((line) => {
    const meta = line[metaKey];
    if (!meta) return;
    let cellIndex = 0;
    const notes = meta.notes as Array<{ id: string; role: string }>;
    notes.forEach((note) => {
      if (note.role === 'breath') return;
      const lyric = validLyric(line.target[cellIndex]);
      if (note.role === 'normal' && lyric) result.set(note.id, lyric);
      cellIndex += 1;
    });
  });
  return result;
}

export function exportSvpWithChinese(sourceText: string, lines: ExportLine[]): string {
  const sanitized = sourceText.replace(/^\uFEFF/, '').replace(/\u0000+$/g, '').trim();
  const raw = JSON.parse(sanitized) as {
    library?: Array<{ uuid?: string; notes?: Array<{ lyrics?: string; phonemes?: string }> }>;
    tracks?: Array<{
      mainGroup?: { notes?: Array<{ lyrics?: string; phonemes?: string }> };
      groups?: Array<{ groupID?: string }>;
    }>;
  };
  const replacements = lyricMap(lines, 'svp');
  const library = new Map((raw.library ?? []).filter((group) => group.uuid).map((group) => [group.uuid as string, group]));
  replacements.forEach((lyric, id) => {
    const main = id.match(/^track-(\d+)-main-(\d+)$/);
    if (main) {
      const note = raw.tracks?.[Number(main[1])]?.mainGroup?.notes?.[Number(main[2])];
      if (note) {
        note.lyrics = lyric;
        delete note.phonemes;
      }
      return;
    }
    const reference = id.match(/^track-(\d+)-ref-(\d+)-(\d+)$/);
    if (!reference) return;
    const groupId = raw.tracks?.[Number(reference[1])]?.groups?.[Number(reference[2])]?.groupID;
    const note = groupId ? library.get(groupId)?.notes?.[Number(reference[3])] : undefined;
    if (note) {
      note.lyrics = lyric;
      delete note.phonemes;
    }
  });
  return JSON.stringify(raw, null, 2);
}

type ZipEntry = { name: string; data: Uint8Array };

function readU16(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

function readU32(data: Uint8Array, offset: number): number {
  return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

function writeU16(data: Uint8Array, offset: number, value: number) {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(data: Uint8Array, offset: number, value: number) {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >>> 8) & 0xff;
  data[offset + 2] = (value >>> 16) & 0xff;
  data[offset + 3] = (value >>> 24) & 0xff;
}

async function unzipEntries(buffer: ArrayBuffer): Promise<ZipEntry[]> {
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let offset = Math.max(0, bytes.length - 65_557); offset <= bytes.length - 22; offset += 1) {
    if (readU32(bytes, offset) === 0x06054b50) eocd = offset;
  }
  if (eocd < 0) throw new Error('VPR 压缩目录不完整');
  const count = readU16(bytes, eocd + 10);
  let offset = readU32(bytes, eocd + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (readU32(bytes, offset) !== 0x02014b50) throw new Error('VPR 文件目录无法识别');
    const method = readU16(bytes, offset + 10);
    const compressedSize = readU32(bytes, offset + 20);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const localOffset = readU32(bytes, offset + 42);
    const name = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    const localNameLength = readU16(bytes, localOffset + 26);
    const localExtraLength = readU16(bytes, localOffset + 28);
    const payloadStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(payloadStart, payloadStart + compressedSize);
    let data: Uint8Array;
    if (method === 0) data = compressed;
    else if (method === 8 && typeof DecompressionStream !== 'undefined') {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    } else throw new Error(`VPR 中包含暂不支持的压缩方式 ${method}`);
    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  data.forEach((value) => { crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8); });
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let localOffset = 0;
  entries.forEach((entry) => {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length + entry.data.length);
    writeU32(local, 0, 0x04034b50);
    writeU16(local, 4, 20);
    writeU16(local, 6, 0x0800);
    writeU16(local, 8, 0);
    writeU32(local, 14, crc);
    writeU32(local, 18, entry.data.length);
    writeU32(local, 22, entry.data.length);
    writeU16(local, 26, name.length);
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);
    localChunks.push(local);

    const central = new Uint8Array(46 + name.length);
    writeU32(central, 0, 0x02014b50);
    writeU16(central, 4, 20);
    writeU16(central, 6, 20);
    writeU16(central, 8, 0x0800);
    writeU16(central, 10, 0);
    writeU32(central, 16, crc);
    writeU32(central, 20, entry.data.length);
    writeU32(central, 24, entry.data.length);
    writeU16(central, 28, name.length);
    writeU32(central, 42, localOffset);
    central.set(name, 46);
    centralChunks.push(central);
    localOffset += local.length;
  });

  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = new Uint8Array(22);
  writeU32(eocd, 0, 0x06054b50);
  writeU16(eocd, 8, entries.length);
  writeU16(eocd, 10, entries.length);
  writeU32(eocd, 12, centralSize);
  writeU32(eocd, 16, localOffset);
  const blobParts = [...localChunks, ...centralChunks, eocd].map((chunk) => {
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    return copy.buffer;
  });
  return new Blob(blobParts, { type: 'application/octet-stream' });
}

function replaceXmlBlocks(xml: string, names: string[], replace: (block: string, index: number) => string): string {
  const pattern = names.join('|');
  const expression = new RegExp(`<(?:[\\w.-]+:)?(?:${pattern})(?:\\s[^>]*)?>[\\s\\S]*?<\\/(?:[\\w.-]+:)?(?:${pattern})>`, 'gi');
  let index = 0;
  return xml.replace(expression, (block) => replace(block, index++));
}

function replaceVsqxNoteLyric(noteXml: string, lyric: string): string {
  const cdata = `<![CDATA[${lyric.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
  const withLyric = noteXml.replace(
    /(<(?:[\w.-]+:)?(?:y|lyric)(?:\s[^>]*)?>)[\s\S]*?(<\/(?:[\w.-]+:)?(?:y|lyric)>)/i,
    `$1${cdata}$2`,
  );
  return withLyric.replace(/\s*<(?:[\w.-]+:)?(?:p|phnms)(?:\s[^>]*)?>[\s\S]*?<\/(?:[\w.-]+:)?(?:p|phnms)>/i, '');
}

async function exportVsqx(sourceBuffer: ArrayBuffer, trackId: string, lines: ExportLine[]): Promise<Blob> {
  const replacements = lyricMap(lines, 'vocaloid');
  const text = new TextDecoder().decode(sourceBuffer);
  const trackIndex = Number(trackId.match(/(\d+)$/)?.[1] ?? -1);
  let foundTrack = false;
  const output = replaceXmlBlocks(text, ['vsTrack'], (trackXml, currentTrackIndex) => {
    if (currentTrackIndex !== trackIndex) return trackXml;
    foundTrack = true;
    return replaceXmlBlocks(trackXml, ['vsPart', 'musicalPart'], (partXml, partIndex) => replaceXmlBlocks(partXml, ['note'], (noteXml, noteIndex) => {
      const lyric = replacements.get(`vsqx-${trackIndex}-part-${partIndex}-note-${noteIndex}`);
      return lyric ? replaceVsqxNoteLyric(noteXml, lyric) : noteXml;
    }));
  });
  if (!foundTrack) throw new Error('没有找到原 VSQX 歌唱轨道');
  return new Blob([output], { type: 'application/xml' });
}

async function exportVpr(sourceBuffer: ArrayBuffer, trackId: string, lines: ExportLine[]): Promise<Blob> {
  const entries = await unzipEntries(sourceBuffer);
  const sequence = entries.find((entry) => /(?:^|[\\/])sequence\.json$/i.test(entry.name));
  if (!sequence) throw new Error('VPR 里没有 sequence.json');
  const raw = JSON.parse(new TextDecoder().decode(sequence.data)) as { tracks?: Array<{ parts?: Array<{ notes?: Array<{ lyric?: string; phoneme?: string }> }> }> };
  const trackIndex = Number(trackId.match(/(\d+)$/)?.[1] ?? -1);
  const replacements = lyricMap(lines, 'vocaloid');
  raw.tracks?.[trackIndex]?.parts?.forEach((part, partIndex) => {
    part.notes?.forEach((note, noteIndex) => {
      const lyric = replacements.get(`vpr-${trackIndex}-part-${partIndex}-note-${noteIndex}`);
      if (!lyric) return;
      note.lyric = lyric;
      delete note.phoneme;
    });
  });
  sequence.data = new TextEncoder().encode(JSON.stringify(raw));
  return createStoredZip(entries);
}

export async function exportVocaloidWithChinese(source: Extract<WritableProject, { kind: 'vocaloid' }>, lines: ExportLine[]): Promise<Blob> {
  if (/\.vsqx$/i.test(source.fileName)) return exportVsqx(source.sourceBuffer, source.trackId, lines);
  if (/\.vpr$/i.test(source.fileName)) return exportVpr(source.sourceBuffer, source.trackId, lines);
  throw new Error('目前只能写回 VSQX 或 VPR 副本');
}
