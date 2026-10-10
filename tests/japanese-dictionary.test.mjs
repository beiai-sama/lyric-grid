import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dictionaryReadings, searchJapaneseReadings } from '../lib/japanese-dictionary.ts';

const entry = (kanji, kana) => ({ reading: { kanji, kana }, senses: [{ glosses: ['light', 'lamp'] }] });
const payload = { words: [entry('灯火', 'とうか'), entry('灯火', 'ともしび')], kanji: [{ kunyomi: ['ひ'] }] };

test('whole-word dictionary entries retain both readings and match the 燈/灯 spelling', () => {
  assert.deepEqual(dictionaryReadings(payload, '燈火').map((item) => item.kana), ['とうか', 'ともしび']);
  assert.deepEqual(dictionaryReadings({ words: [] , kanji: payload.kanji }, '燈火'), []);
  assert.deepEqual(dictionaryReadings({ words: [entry('火', 'ひ'), entry('灯火', '燈ヒ'), null] }, '燈火'), []);
  assert.equal(dictionaryReadings({ words: [entry('灯火', 'ともしび'), entry('灯火', 'ともしび')] }, '燈火').length, 1);
  assert.throws(() => dictionaryReadings({}, '燈火'), /格式异常/);
});

test('lookup sends only the requested word and allows retry after an HTTP failure', async () => {
  let attempts = 0;
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://jotoba.de/api/search/words');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { query: '燈火', language: 'English', no_english: true });
    attempts++;
    return attempts === 1 ? new Response('', { status: 503 }) : Response.json(payload);
  };
  await assert.rejects(searchJapaneseReadings(' 燈火 ', { fetcher }), /503/);
  assert.equal((await searchJapaneseReadings('燈火', { fetcher })).length, 2);
});

test('network, timeout and caller cancellation finish without returning stale candidates', async () => {
  await assert.rejects(searchJapaneseReadings('燈火', { fetcher: async () => { throw new TypeError('network'); } }), /无法连接/);
  const fetcher = async (_url, { signal }) => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await assert.rejects(searchJapaneseReadings('燈火', { fetcher, timeoutMs: 5 }), /超时/);
  const controller = new AbortController();
  const pending = searchJapaneseReadings('燈火', { fetcher, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(searchJapaneseReadings('', { fetcher }), /请输入/);
});
