'use client';

import { useEffect, useRef, useState } from 'react';
import { japaneseTokenWords, kanaToTokens } from '../lib/phonetics';
import type { ParsedLyricLine, PronunciationToken } from '../lib/phonetics';
import { searchJapaneseReadings } from '../lib/japanese-dictionary';
import type { DictionaryReading } from '../lib/japanese-dictionary';

type ReadingSpan = { start: number; end: number; surface: string };

export default function DictionaryReadingEditor({ line, selectedToken, onApply }: {
  line: ParsedLyricLine;
  selectedToken?: PronunciationToken;
  onApply: (span: ReadingSpan, reading: string) => string | undefined;
}) {
  const initialWord = (selectedToken ? japaneseTokenWords(selectedToken)[0] : undefined)
    ?? line.tokens.filter((token) => token.unresolved).flatMap(japaneseTokenWords)[0]
    ?? line.tokens.flatMap(japaneseTokenWords).find((word) => /\p{Script=Han}/u.test(word.surface));
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(initialWord?.surface ?? '');
  const [occurrence, setOccurrence] = useState(initialWord?.start ?? 0);
  const [candidates, setCandidates] = useState<DictionaryReading[]>([]);
  const [manualKana, setManualKana] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const term = query.trim();
  const occurrences: ReadingSpan[] = [];
  if (term) {
    for (let start = line.source.indexOf(term); start !== -1; start = line.source.indexOf(term, start + term.length)) {
      occurrences.push({ start, end: start + term.length, surface: term });
    }
  }
  const span = occurrences.find((item) => item.start === occurrence) ?? occurrences[0];
  const search = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setCandidates([]);
    setMessage('');
    try {
      const readings = await searchJapaneseReadings(term, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setCandidates(readings);
      if (!readings.length) setMessage('未查到这个完整词组的读音，可按原唱手动填写假名。');
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : '查询失败，请重试。');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  const apply = (reading: string) => {
    if (!span) return;
    const error = onApply(span, reading);
    setMessage(error ?? '');
  };

  return (
    <div className="dictionary-reading-editor">
      <button className="text-button" aria-expanded={open} onClick={() => {
        if (open) { request.current?.abort(); setLoading(false); }
        setOpen(!open);
      }}>{open ? '收起词典' : '查词典 / 勘误'}</button>
      {open && <div className="dictionary-reading-panel">
        <label htmlFor="dictionary-query">要查的日文词组</label>
        <div className="dictionary-input-row">
          <input id="dictionary-query" value={query} maxLength={80} onChange={(event) => {
            request.current?.abort(); setLoading(false); setCandidates([]); setMessage('');
            setQuery(event.target.value); setOccurrence(0);
          }} onKeyDown={(event) => { if (event.key === 'Enter' && term) void search(); }} />
          <button disabled={!term || loading} onClick={() => void search()}>{loading ? '查询中…' : '查读音'}</button>
        </div>
        <p className="dictionary-source">点击查询会将该词组发送至 <a href="https://jotoba.de" target="_blank" rel="noreferrer">Jotoba</a>。词典资料由 <a href="https://jotoba.de/about" target="_blank" rel="noreferrer">EDRDG 等</a>提供；请按原唱选择读法。</p>
        {span ? <label className="dictionary-occurrence">应用位置
          <select value={span.start} onChange={(event) => setOccurrence(Number(event.target.value))}>
            {occurrences.map((item, index) => <option key={item.start} value={item.start}>
              第 {index + 1} 处：{line.source.slice(Math.max(0, item.start - 6), item.start)}【{term}】{line.source.slice(item.end, item.end + 6)}
            </option>)}
          </select>
        </label> : <p>该词组不在本句原文中，可查词；应用时请填写原文中的完整词组。</p>}
        <div className="dictionary-candidates">
          {candidates.map((candidate) => <article key={`${candidate.headword}-${candidate.kana}`}>
            <div><strong>{candidate.headword} · {candidate.kana}</strong>
              <span>{kanaToTokens(candidate.kana).map((token) => token.label).join(' · ')}</span>
              {candidate.meanings.length > 0 && <small>{candidate.meanings.join('; ')}</small>}
            </div>
            <button disabled={!span} onClick={() => apply(candidate.kana)}>应用这处读音</button>
          </article>)}
        </div>
        <label htmlFor="dictionary-manual-kana">按原唱勘误（假名）</label>
        <div className="dictionary-input-row">
          <input id="dictionary-manual-kana" value={manualKana} placeholder="例如：ともしび" onChange={(event) => setManualKana(event.target.value)} />
          <button disabled={!span || !manualKana.trim()} onClick={() => apply(manualKana)}>应用假名</button>
        </div>
        {message && <p role="status" className="dictionary-message">{message}</p>}
      </div>}
    </div>
  );
}
