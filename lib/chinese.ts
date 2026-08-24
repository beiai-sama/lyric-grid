import { pinyin } from 'pinyin-pro';

export type ChineseCellReading = {
  character: string;
  syllable: string;
  final: string;
  rhyme: boolean;
};

export type ChinesePronunciationAnalysis = {
  cells: Array<ChineseCellReading | undefined>;
  rhyme?: ChineseCellReading;
};

export function analyzeChineseCells(cells: string[]): ChinesePronunciationAnalysis {
  const pronounced = cells
    .map((character, index) => ({ character, index }))
    .filter(({ character }) => /\p{Script=Han}/u.test(character));

  const result: Array<ChineseCellReading | undefined> = Array.from({ length: cells.length });
  if (!pronounced.length) return { cells: result };

  const phrase = pronounced.map(({ character }) => character).join('');
  const syllables = pinyin(phrase, { type: 'array', toneType: 'symbol' }) as string[];
  const finals = pinyin(phrase, { type: 'array', pattern: 'final', toneType: 'none' }) as string[];
  const rhymeIndex = pronounced[pronounced.length - 1].index;

  pronounced.forEach(({ character, index }, readingIndex) => {
    result[index] = {
      character,
      syllable: syllables[readingIndex] ?? character,
      final: finals[readingIndex] ?? '',
      rhyme: index === rhymeIndex,
    };
  });

  return { cells: result, rhyme: result[rhymeIndex] };
}
