export type DictionaryReading = { headword: string; kana: string; meanings: string[] };

const dictionaryEndpoint = 'https://jotoba.de/api/search/words';
const canonicalSpelling = (value: string) => value.normalize('NFKC').replaceAll('燈', '灯');

/** Search whole-word entries only. Individual kanji readings cannot pronounce a compound. */
export function dictionaryReadings(payload: unknown, query: string): DictionaryReading[] {
  if (!payload || typeof payload !== 'object' || !('words' in payload) || !Array.isArray(payload.words)) {
    throw new Error('词典返回格式异常，请稍后重试或手动填写读音。');
  }
  const results = new Map<string, DictionaryReading>();
  for (const entry of payload.words) {
    if (!entry || typeof entry !== 'object') continue;
    const { reading, senses } = entry;
    if (!reading || typeof reading.kana !== 'string') continue;
    const kana = reading.kana.normalize('NFKC');
    if (!/^[ぁ-ゖァ-ヶ][ぁ-ゖァ-ヶー]*$/u.test(kana)) continue;
    const headword = typeof reading.kanji === 'string' ? reading.kanji : kana;
    if (canonicalSpelling(headword) !== canonicalSpelling(query)
      && canonicalSpelling(kana) !== canonicalSpelling(query)) continue;
    const meanings: string[] = Array.isArray(senses)
      ? senses.flatMap((sense: { glosses?: unknown }) => Array.isArray(sense?.glosses)
        ? sense.glosses.filter((gloss): gloss is string => typeof gloss === 'string').slice(0, 4) : []).slice(0, 6)
      : [];
    results.set(`${headword}\0${kana}`, { headword, kana, meanings });
    if (results.size >= 20) break;
  }
  return [...results.values()];
}

export async function searchJapaneseReadings(
  query: string,
  options: { signal?: AbortSignal; fetcher?: typeof fetch; timeoutMs?: number } = {},
): Promise<DictionaryReading[]> {
  const term = query.trim();
  if (!term || term.length > 80) throw new Error('请输入不超过 80 字的日文词组。');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, options.timeoutMs ?? 12000);
  try {
    const response = await (options.fetcher ?? fetch)(dictionaryEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: term, language: 'English', no_english: true }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`词典暂时不可用（${response.status}），请稍后重试或手动填写读音。`);
    return dictionaryReadings(await response.json(), term);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (controller.signal.aborted) throw new Error('词典查询超时，可重试或手动填写读音。');
    if (error instanceof TypeError) throw new Error('无法连接词典，请检查网络或手动填写读音。');
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
