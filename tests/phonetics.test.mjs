import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  baseCount,
  kanaToTokens,
  linkPronunciationTokens,
  manualPronunciationToTokens,
  parseJapaneseRows,
  parseLyricLine,
} from '../lib/phonetics.ts';

const labels = (tokens) => tokens.map((token) => token.label);
const known = (surface_form, reading, pronunciation = reading) => ({ surface_form, reading, pronunciation });

test('燈火 uses its whole-word reading for one or multiple tokenizer rows', () => {
  for (const rows of [
    [{ surface_form: '燈' }, known('火', 'ヒ')],
    [known('燈火', 'トウカ')],
    [{ surface_form: '燈火' }],
  ]) {
    const result = parseJapaneseRows(rows);
    assert.equal(result.kana, 'ともしび');
    assert.deepEqual(labels(result.tokens), ['to', 'mo', 'shi', 'bi']);
    assert.equal(baseCount(result.tokens), 4);
    assert.equal(result.uncertain, false);
  }
});

test('word corrections respect whitespace and do not replace 燈 on its own', () => {
  const result = parseJapaneseRows([{ surface_form: '燈' }, { surface_form: ' ' }, known('火', 'ヒ')]);
  assert.deepEqual(labels(result.tokens), ['燈', 'hi']);
  assert.equal(result.tokens[0].unresolved, true);
  assert.equal(result.uncertain, true);
});

test('unknown Japanese text remains visible without inventing a syllable count', () => {
  const result = parseJapaneseRows([{ surface_form: '燈' }]);
  assert.equal(result.kana, '燈');
  assert.deepEqual(labels(result.tokens), ['燈']);
  assert.equal(result.tokens[0].kind, 'uncertain');
  assert.equal(result.tokens[0].unresolved, true);
  assert.equal(result.tokens[0].counted, false);
  assert.equal(baseCount(result.tokens), 0);
  assert.equal(result.uncertain, true);
});

test('missing, blank, sentinel and non-kana pronunciation fall back to a valid reading', () => {
  for (const pronunciation of [undefined, '', ' ', '*', '燈ヒ']) {
    const result = parseJapaneseRows([{ surface_form: '火', reading: 'ヒ', pronunciation }]);
    assert.deepEqual(labels(result.tokens), ['hi']);
    assert.equal(result.kana, 'ひ');
    assert.equal(result.uncertain, false);
  }
  const result = parseJapaneseRows([{ surface_form: '燈', reading: '*', pronunciation: '*' }]);
  assert.equal(result.tokens[0].unresolved, true);
});

test('unknown kana can use its surface, while punctuation is skipped', () => {
  const result = parseJapaneseRows([
    { surface_form: 'び' }, { surface_form: ' ' }, { surface_form: '。' },
    { surface_form: '・' }, { surface_form: '！' },
  ]);
  assert.deepEqual(labels(result.tokens), ['bi']);
  assert.equal(result.uncertain, false);
  assert.deepEqual(parseJapaneseRows([{ surface_form: '。' }]).tokens, []);
});

test('reading display and spoken pronunciation retain distinct meanings', () => {
  const result = parseJapaneseRows([known('今日', 'キョウ', 'キョー'), known('は', 'ハ', 'ワ')]);
  assert.equal(result.kana, 'きょう は');
  assert.deepEqual(labels(result.tokens), ['kyō', 'wa']);
  assert.equal(baseCount(result.tokens), 2);
});

test('unresolved text prevents automatic links across an unknown word', () => {
  const result = parseJapaneseRows([known('あ', 'ア'), { surface_form: '燈' }, known('い', 'イ')]);
  const tokens = linkPronunciationTokens(result.tokens);
  assert.deepEqual(labels(tokens), ['a', '燈', 'i']);
  assert.equal(baseCount(tokens), 2);
});

test('kana chunking, long vowels, absorption and linking keep their existing behavior', () => {
  assert.deepEqual(labels(kanaToTokens('トモシビ')), ['to', 'mo', 'shi', 'bi']);
  assert.deepEqual(labels(kanaToTokens('コーヒー')), ['kō', 'hī']);
  const tokens = kanaToTokens('きゃっんと');
  assert.deepEqual(labels(tokens), ['kya', 'q', 'n', 'to']);
  assert.equal(baseCount(tokens), 2);
  const linked = linkPronunciationTokens(kanaToTokens('ない'));
  assert.deepEqual(labels(linked), ['na+i']);
  assert.deepEqual(labels(linked[0].components), ['na', 'i']);
});

test('manual correction accepts kana and preserves unresolved Japanese placeholders', () => {
  const corrected = manualPronunciationToTokens('ともしび');
  assert.deepEqual(labels(corrected), ['to', 'mo', 'shi', 'bi']);
  assert.equal(baseCount(corrected), 4);
  assert.ok(corrected.every((token) => token.source === 'manual' && !token.unresolved));
  const unchanged = manualPronunciationToTokens('燈 hi');
  assert.equal(unchanged[0].unresolved, true);
  assert.equal(unchanged[0].kind, 'uncertain');
  assert.equal(baseCount(unchanged), 1);
  assert.deepEqual(labels(manualPronunciationToTokens('to mo shi bi')), ['to', 'mo', 'shi', 'bi']);
  const legacy = manualPronunciationToTokens('na+i n q cl kō');
  assert.deepEqual(legacy.map((token) => token.kind), ['linked', 'absorbed', 'absorbed', 'absorbed', 'long']);
});

// Exercise the production browser bundle with the repository's actual dictionary.
// Only XHR transport is replaced; tokenization and parsing run unchanged.
const originalXHR = globalThis.XMLHttpRequest;
const dictionaryRequests = new Set();
globalThis.XMLHttpRequest = class {
  open(method, url) {
    assert.equal(method, 'GET');
    assert.match(url, /^\/dict\/[a-z_]+\.dat\.gz$/);
    this.fileName = url.slice('/dict/'.length);
    dictionaryRequests.add(this.fileName);
  }

  send() {
    readFile(new URL(`../public/dict/${this.fileName}`, import.meta.url)).then((buffer) => {
      this.status = 200;
      this.response = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      this.onload();
    }, (error) => this.onerror(error));
  }
};
after(() => {
  if (originalXHR === undefined) delete globalThis.XMLHttpRequest;
  else globalThis.XMLHttpRequest = originalXHR;
});

test('actual dictionary: Issue #1 produces four final tokens and preserves the lyric', async () => {
  const source = 'あの日 心に宿した燈火';
  const result = await parseLyricLine(source);
  assert.equal(result.source, source);
  assert.equal(result.kana, 'あの ひ こころ に やどし た ともしび');
  assert.deepEqual(labels(result.tokens.slice(-4)), ['to', 'mo', 'shi', 'bi']);
  assert.equal(baseCount(result.tokens), 15);
  assert.equal(result.uncertain, false);
  assert.equal(dictionaryRequests.size, 12);
});

test('actual dictionary: 燈火, 灯火 and both kana spellings generate four tokens', async () => {
  for (const source of ['燈火', '灯火', 'ともしび', 'トモシビ']) {
    const result = await parseLyricLine(source);
    assert.deepEqual(labels(result.tokens), ['to', 'mo', 'shi', 'bi']);
    assert.equal(baseCount(result.tokens), 4);
    assert.equal(result.uncertain, false);
  }
  const repeated = await parseLyricLine('燈火と燈火');
  assert.deepEqual(labels(repeated.tokens), ['to', 'mo', 'shi', 'bi', 'to', 'to', 'mo', 'shi', 'bi']);
});

test('actual dictionary: unknown kanji and supplementary kanji are preserved', async () => {
  for (const source of ['燈', '𠮷']) {
    const result = await parseLyricLine(source);
    assert.equal(result.source, source);
    assert.equal(result.kana, source);
    assert.deepEqual(labels(result.tokens), [source]);
    assert.equal(result.tokens[0].unresolved, true);
    assert.equal(baseCount(result.tokens), 0);
    assert.equal(result.uncertain, true);
  }
});

test('actual dictionary: particles and long vowels retain their pronunciation', async () => {
  for (const [source, expected] of [
    ['今日は', ['kyō', 'wa']], ['東京', ['tō', 'kyō']], ['コーヒー', ['kō', 'hī']],
  ]) {
    const result = await parseLyricLine(source);
    assert.deepEqual(labels(result.tokens), expected);
    assert.equal(result.uncertain, false);
  }
});

test('actual dictionary: mixed-language lyrics keep English and corrected Japanese tokens', async () => {
  const result = await parseLyricLine('love 燈火');
  assert.equal(result.language, 'mixed');
  assert.ok(result.tokens.some((token) => token.source === 'en'));
  assert.deepEqual(labels(result.tokens.slice(-4)), ['to', 'mo', 'shi', 'bi']);
});
