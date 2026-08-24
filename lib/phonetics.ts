export type TokenKind = 'normal' | 'long' | 'absorbed' | 'linked' | 'uncertain';

export type PronunciationToken = {
  id: string;
  label: string;
  kana?: string;
  ipa?: string;
  kind: TokenKind;
  counted: boolean;
  source: 'ja' | 'en' | 'manual';
  components?: PronunciationToken[];
  linkCandidate?: boolean;
};

export type ParsedLyricLine = {
  source: string;
  kana: string;
  tokens: PronunciationToken[];
  language: 'ja' | 'en' | 'mixed';
  uncertain: boolean;
};

type KuromojiRow = {
  surface_form: string;
  reading?: string;
  pronunciation?: string;
};

type Analyzer = {
  parse(value: string): Promise<KuromojiRow[]>;
};

type KuromojiTokenizer = {
  tokenize(value: string): KuromojiRow[];
};

type KuromojiModule = {
  builder(options: { dicPath: string }): {
    build(callback: (error: Error | null, tokenizer: KuromojiTokenizer) => void): void;
  };
};

let analyzerPromise: Promise<Analyzer> | null = null;

const unwrapDefault = <T,>(module: unknown): T => {
  const candidate = module as { default?: unknown };
  const first = candidate.default ?? module;
  const nested = first as { default?: unknown };
  return (nested.default ?? first) as T;
};

async function getAnalyzer(): Promise<Analyzer> {
  if (!analyzerPromise) {
    analyzerPromise = import('kuromoji/build/kuromoji.js').then((module) =>
      new Promise<Analyzer>((resolve, reject) => {
        const kuromoji = unwrapDefault<KuromojiModule>(module);
        kuromoji.builder({ dicPath: '/dict/' }).build((error, tokenizer) => {
          if (error) reject(error);
          else resolve({ parse: async (value: string) => tokenizer.tokenize(value) });
        });
      }),
    );
  }
  return analyzerPromise;
}

const kanaMap: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ゔ: 'vu',
  きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo',
  ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
  しゃ: 'sha', しゅ: 'shu', しょ: 'sho',
  じゃ: 'ja', じゅ: 'ju', じょ: 'jo',
  ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho',
  にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
  ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo',
  びゃ: 'bya', びゅ: 'byu', びょ: 'byo',
  ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
  みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
  りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo',
  ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo',
  てぃ: 'ti', でぃ: 'di', うぃ: 'wi', うぇ: 'we', うぉ: 'wo',
  ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo',
};

const smallKana = new Set(['ゃ', 'ゅ', 'ょ', 'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'ゎ']);
const linkableVowelPairs = new Set(['ai', 'ei', 'ao', 'ou', 'ia', 'ie', 'iu', 'ua', 'uo', 'ui', 'ue']);

export function toHiragana(value: string): string {
  return Array.from(value).map((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : character;
  }).join('');
}

function lengthenRomaji(value: string): string {
  const replacements: Record<string, string> = { a: 'ā', i: 'ī', u: 'ū', e: 'ē', o: 'ō' };
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[value[index]];
    if (replacement) return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
  }
  return `${value}ː`;
}

function makeId(prefix: string, index: number): string {
  return `${prefix}-${index}-${Math.random().toString(36).slice(2, 7)}`;
}

export function kanaToTokens(value: string, prefix = 'ja'): PronunciationToken[] {
  const normalized = toHiragana(value);
  const chunks: string[] = [];

  for (const character of Array.from(normalized)) {
    if (smallKana.has(character) && chunks.length) {
      chunks[chunks.length - 1] += character;
    } else if (character === 'ー' && chunks.length) {
      chunks[chunks.length - 1] += character;
    } else if (/^[ぁ-ゖ]$/.test(character)) {
      chunks.push(character);
    }
  }

  return chunks.map((kana, index) => {
    if (kana === 'ん') {
      return { id: makeId(prefix, index), label: 'n', kana, kind: 'absorbed', counted: false, source: 'ja' };
    }
    if (kana === 'っ') {
      return { id: makeId(prefix, index), label: 'q', kana, kind: 'absorbed', counted: false, source: 'ja' };
    }

    const isLong = kana.endsWith('ー');
    const rawKana = isLong ? kana.slice(0, -1) : kana;
    const base = kanaMap[rawKana] ?? rawKana;
    return {
      id: makeId(prefix, index),
      label: isLong ? lengthenRomaji(base) : base,
      kana,
      kind: isLong ? 'long' : 'normal',
      counted: true,
      source: 'ja',
    };
  });
}

function finalVowel(value: string): string | undefined {
  const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return normalized.match(/[aeiou](?!.*[aeiou])/)?.[0];
}

/**
 * Merge high-confidence Japanese vowel continuations into one Chinese lyric slot.
 * For example, na + i becomes na+i and no + u becomes no+u. The original
 * tokens are retained so the UI can split the linked unit back apart.
 */
export function linkPronunciationTokens(tokens: PronunciationToken[]): PronunciationToken[] {
  const result: PronunciationToken[] = [];

  tokens.forEach((current) => {
    const previous = result[result.length - 1];
    const nextVowel = current.label.toLowerCase();
    const previousVowel = previous ? finalVowel(previous.label) : undefined;
    const canLink = Boolean(
      previous
      && previous.source === 'ja'
      && current.source === 'ja'
      && previous.kind === 'normal'
      && current.kind === 'normal'
      && previous.counted
      && current.counted
      && /^[aeiou]$/.test(nextVowel)
      && previousVowel
      && linkableVowelPairs.has(`${previousVowel}${nextVowel}`),
    );

    if (!canLink || !previous) {
      result.push(current);
      return;
    }

    result[result.length - 1] = {
      id: `${previous.id}-linked-${current.id}`,
      label: `${previous.label}+${current.label}`,
      kana: `${previous.kana ?? ''}${current.kana ?? ''}` || undefined,
      kind: 'linked',
      counted: true,
      source: 'ja',
      components: [previous, current],
    };
  });

  return result.map((current, index) => {
    const previous = result[index - 1];
    const isCandidate = Boolean(
      previous
      && previous.source === 'ja'
      && current.source === 'ja'
      && previous.kind === 'normal'
      && current.kind === 'normal'
      && previous.counted
      && current.counted
      && /^[aeiou]$/i.test(current.label)
      && finalVowel(previous.label),
    );
    return isCandidate ? { ...current, linkCandidate: true } : current;
  });
}

const arpabetToIpa: Record<string, string> = {
  AA: 'ɑ', AE: 'æ', AH: 'ʌ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ',
  EH: 'ɛ', ER: 'ɝ', EY: 'eɪ', IH: 'ɪ', IY: 'i', OW: 'oʊ',
  OY: 'ɔɪ', UH: 'ʊ', UW: 'u', B: 'b', CH: 'tʃ', D: 'd',
  DH: 'ð', F: 'f', G: 'ɡ', HH: 'h', JH: 'dʒ', K: 'k', L: 'l',
  M: 'm', N: 'n', NG: 'ŋ', P: 'p', R: 'r', S: 's', SH: 'ʃ',
  T: 't', TH: 'θ', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ',
};

function splitArpabetIntoSyllables(pronunciation: string): string[][] {
  const phonemes = pronunciation.split(/\s+/).filter(Boolean);
  const syllables: string[][] = [];
  let current: string[] = [];
  let hasVowel = false;

  phonemes.forEach((phoneme) => {
    const isVowel = /\d$/.test(phoneme);
    if (isVowel && hasVowel) {
      syllables.push(current);
      current = [];
      hasVowel = false;
    }
    current.push(phoneme);
    if (isVowel) hasVowel = true;
  });
  if (current.length) syllables.push(current);
  return syllables;
}

function arpabetSyllableToIpa(syllable: string[]): string {
  return syllable.map((phoneme) => {
    const base = phoneme.replace(/\d/g, '');
    return arpabetToIpa[base] ?? base.toLowerCase();
  }).join('');
}

async function englishWordToTokens(word: string, prefix: string): Promise<PronunciationToken[]> {
  const { dictionary } = await import('cmu-pronouncing-dictionary');
  const pronunciation = dictionary[word.toLowerCase()];
  if (pronunciation) {
    return splitArpabetIntoSyllables(pronunciation).map((syllable, index) => {
      const ipa = arpabetSyllableToIpa(syllable);
      return {
        id: makeId(prefix, index),
        label: ipa,
        ipa,
        kind: 'normal',
        counted: true,
        source: 'en',
      };
    });
  }

  const estimated = word.toLowerCase().match(/[aeiouy]+(?:[^aeiouy]+|$)/g) ?? [word];
  return estimated.map((part, index) => ({
    id: makeId(prefix, index),
    label: part.replace(/[^a-z]/g, '') || word,
    kind: 'uncertain',
    counted: true,
    source: 'en',
  }));
}

function splitSegments(value: string): string[] {
  return value.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*|[^A-Za-z]+/g) ?? [value];
}

export async function parseLyricLine(source: string, lineIndex = 0): Promise<ParsedLyricLine> {
  const analyzer = await getAnalyzer();
  const segments = splitSegments(source);
  const tokens: PronunciationToken[] = [];
  const kanaParts: string[] = [];
  let hasJapanese = false;
  let hasEnglish = false;
  let uncertain = false;

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    if (/^[A-Za-z]/.test(segment)) {
      hasEnglish = true;
      const words = segment.split(/['’-]/).filter(Boolean);
      for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
        const wordTokens = await englishWordToTokens(words[wordIndex], `en-${lineIndex}-${segmentIndex}-${wordIndex}`);
        uncertain ||= wordTokens.some((token) => token.kind === 'uncertain');
        tokens.push(...wordTokens);
      }
      kanaParts.push(segment);
      continue;
    }

    if (!/[\u3040-\u30ff\u3400-\u9fff]/.test(segment)) continue;
    hasJapanese = true;
    const rows = await analyzer.parse(segment);
    rows.forEach((row, rowIndex) => {
      const kanaSurface = /^[\u3040-\u30ffー]+$/.test(row.surface_form) ? row.surface_form : undefined;
      const pronunciation = row.pronunciation ?? row.reading ?? kanaSurface;
      if (!pronunciation) return;
      kanaParts.push(toHiragana(row.reading ?? pronunciation));
      tokens.push(...kanaToTokens(pronunciation, `ja-${lineIndex}-${segmentIndex}-${rowIndex}`));
    });
  }

  return {
    source,
    kana: kanaParts.join(' '),
    tokens: linkPronunciationTokens(tokens),
    language: hasJapanese && hasEnglish ? 'mixed' : hasEnglish ? 'en' : 'ja',
    uncertain: uncertain || hasEnglish,
  };
}

export function manualPronunciationToTokens(value: string): PronunciationToken[] {
  return value.trim().split(/\s+/).filter(Boolean).map((label, index) => {
    const linkedParts = label.split('+').filter(Boolean);
    if (linkedParts.length > 1) {
      const components = linkedParts.map((part, partIndex): PronunciationToken => ({
        id: makeId(`manual-${index}`, partIndex),
        label: part,
        kind: 'normal',
        counted: true,
        source: 'manual',
      }));
      return {
        id: makeId('manual-linked', index),
        label: linkedParts.join('+'),
        kind: 'linked',
        counted: true,
        source: 'manual',
        components,
      };
    }
    const normalized = label.toLowerCase();
    const absorbed = normalized === 'n' || normalized === 'q' || normalized === 'cl' || normalized === 'っ';
    const long = /[āīūēōː:]$/.test(normalized);
    return {
      id: makeId('manual', index),
      label,
      kind: absorbed ? 'absorbed' : long ? 'long' : 'normal',
      counted: !absorbed,
      source: 'manual',
    };
  });
}

export function baseCount(tokens: PronunciationToken[]): number {
  return tokens.filter((token) => token.counted).length;
}
