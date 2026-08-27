'use client';

import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PronunciationToken, baseCount } from '../lib/phonetics';
import { analyzeChineseCells } from '../lib/chinese';
import { MidiLineMeta } from '../lib/midi';
import { SvpLineMeta } from '../lib/svp';
import { VocaloidLineMeta } from '../lib/vocaloid';

export type LabLine = {
  id: string;
  source: string;
  kana: string;
  tokens: PronunciationToken[];
  target: string[];
  language: 'ja' | 'en' | 'mixed' | 'zh';
  uncertain: boolean;
  start?: number;
  end?: number;
  svp?: SvpLineMeta;
  midi?: MidiLineMeta;
  vocaloid?: VocaloidLineMeta;
};

type LabTab = 'match' | 'rhyme' | 'check' | 'blind';
type BlindPhase = 'ready' | 'recording' | 'review';
type BlindTap = { id: string; time: number; label: string };
type NoteLike = {
  id: string;
  lyric: string;
  phoneme?: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  pitch: number;
  role: 'normal' | 'hold' | 'syllable' | 'breath';
};

type Props = {
  lines: LabLine[];
  activeId: string;
  currentTime: number;
  duration: number;
  playing: boolean;
  rate: number;
  audioAvailable: boolean;
  subtitleAvailable: boolean;
  audioName: string;
  subtitleName: string;
  onClose: () => void;
  onSelectLine: (id: string) => void;
  onApplyPronunciation: (lineId: string, value: string) => void;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onRate: (rate: number) => void;
  onLooping: (value: boolean) => void;
  onNotice: (message: string) => void;
};

const tabLabels: Array<[LabTab, string, string]> = [
  ['blind', '盲听打点', '空格键记录 la'],
  ['match', '声韵对照', '原音与拼音'],
  ['rhyme', '押韵地图', '整首韵脚'],
  ['check', '导出自检', '查漏补缺'],
];

const lockedShops = [
  ['填词体检', '咬字与时值'],
  ['全曲钢琴窗', '音高与时间'],
  ['版本对比', '保存与恢复'],
  ['工程回写', '歌声工程副本'],
];

function lineNotes(line: LabLine): NoteLike[] {
  if (line.vocaloid) return line.vocaloid.notes;
  if (line.svp) return line.svp.notes.map((note) => ({ ...note, phoneme: note.phonemes }));
  if (line.midi) return line.midi.notes;
  return [];
}

function lineLabel(line: LabLine): string {
  return line.target.join('').replace(/—/g, '—') || '尚未填词';
}

function formatTime(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${(safe % 60).toFixed(2).padStart(5, '0')}`;
}

function noteCellPairs(line: LabLine): Array<{ note?: NoteLike; cell: string; index: number; token?: PronunciationToken }> {
  const notes = lineNotes(line);
  if (!notes.length) return line.target.map((cell, index) => ({ cell, index, token: line.tokens[index] }));
  const pairs: Array<{ note?: NoteLike; cell: string; index: number; token?: PronunciationToken }> = [];
  let cellIndex = 0;
  let tokenIndex = 0;
  notes.forEach((note) => {
    if (note.role === 'breath') return;
    const token = note.role === 'hold' ? undefined : line.tokens[tokenIndex++];
    pairs.push({ note, cell: line.target[cellIndex] ?? '', index: cellIndex, token });
    cellIndex += 1;
  });
  return pairs;
}

function finalFamily(value: string): string {
  const input = value.toLowerCase().replace(/[āáǎà]/g, 'a').replace(/[ēéěè]/g, 'e').replace(/[īíǐì]/g, 'i').replace(/[ōóǒò]/g, 'o').replace(/[ūúǔù]/g, 'u').replace(/[ǖǘǚǜü]/g, 'v');
  if (/(ang|an|ai|ao|a)/.test(input)) return 'a';
  if (/(eng|en|ei|er|e|ə|3:)/.test(input)) return 'e';
  if (/(ing|in|ie|ian|iao|i|iy)/.test(input)) return 'i';
  if (/(ong|ou|o|ɔ)/.test(input)) return 'o';
  if (/(uang|uan|uo|ui|un|u|uw)/.test(input)) return 'u';
  if (/(ve|van|vn|v|y)/.test(input)) return 'v';
  return '';
}

function soundScore(original: string, final: string): number {
  const left = finalFamily(original);
  const right = finalFamily(final);
  if (!left || !right) return 55;
  if (left === right) return 94;
  const near = new Set(['a-o', 'o-a', 'e-i', 'i-e', 'u-o', 'o-u', 'i-v', 'v-i']);
  return near.has(`${left}-${right}`) ? 72 : 38;
}

function lineAtTime(lines: LabLine[], time: number): LabLine | undefined {
  return lines.find((line, index) => {
    if (line.start == null) return false;
    const nextStart = lines.slice(index + 1).find((candidate) => candidate.start != null)?.start;
    const end = line.end ?? nextStart ?? Number.POSITIVE_INFINITY;
    return time >= line.start && time < end;
  });
}

export default function LabModal(props: Props) {
  const [tab, setTab] = useState<LabTab>('blind');
  const [blindPhase, setBlindPhase] = useState<BlindPhase>('ready');
  const [blindTaps, setBlindTaps] = useState<Record<string, BlindTap[]>>({});
  const tapCounterRef = useRef(0);
  const { currentTime, lines, onNotice, playing } = props;
  const activeIndex = Math.max(0, props.lines.findIndex((line) => line.id === props.activeId));
  const activeLine = props.lines[activeIndex] ?? props.lines[0];
  const timedLines = useMemo(() => props.lines.filter((line) => line.start != null), [props.lines]);
  const blindReady = props.audioAvailable && props.subtitleAvailable && timedLines.length > 0;
  const playingLine = blindPhase === 'recording' ? lineAtTime(props.lines, props.currentTime) : undefined;
  const blindLine = playingLine ?? activeLine;
  const blindLineIndex = Math.max(0, props.lines.findIndex((line) => line.id === blindLine?.id));
  const activeTaps = blindLine ? blindTaps[blindLine.id] ?? [] : [];
  const totalTaps = Object.values(blindTaps).reduce((sum, taps) => sum + taps.length, 0);

  const rhymeRows = useMemo(() => props.lines.map((line) => ({ line, rhyme: analyzeChineseCells(line.target).rhyme })), [props.lines]);
  const rhymeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    rhymeRows.forEach(({ rhyme }) => { if (rhyme?.final) counts.set(rhyme.final, (counts.get(rhyme.final) ?? 0) + 1); });
    return counts;
  }, [rhymeRows]);
  const checklist = useMemo(() => {
    const unfinished = props.lines.filter((line) => !line.target.some((cell) => cell.trim() && cell !== '—')).length;
    const mismatch = props.lines.filter((line) => line.target.filter((cell) => cell.trim() && cell !== '—').length !== baseCount(line.tokens)).length;
    const uncertain = props.lines.filter((line) => line.uncertain).length;
    const untimed = props.lines.filter((line) => line.start == null || line.end == null).length;
    const noRhyme = props.lines.filter((line) => line.target.some((cell) => /\p{Script=Han}/u.test(cell)) && !analyzeChineseCells(line.target).rhyme?.final).length;
    return [
      { label: '未完成句子', value: unfinished, good: unfinished === 0, detail: '至少填入一个中文字才算开始' },
      { label: '字数不一致', value: mismatch, good: mismatch === 0, detail: '延音不计入实际发音字数' },
      { label: '唱法待确认', value: uncertain, good: uncertain === 0, detail: '自动推测需要人工听感确认' },
      { label: '缺少时间轴', value: untimed, good: untimed === 0, detail: '无法使用 LRC 跟随与盲听打点' },
      { label: '韵脚未识别', value: noRhyme, good: noRhyme === 0, detail: '检查句尾是否为汉字' },
    ];
  }, [props.lines]);

  const addBlindTap = useCallback(() => {
    if (!blindReady) return;
    if (!playing) {
      onNotice('先点击播放，再跟着人声按空格');
      return;
    }
    const line = lineAtTime(lines, currentTime);
    if (!line) {
      onNotice('当前时间还没有进入 LRC 歌词行');
      return;
    }
    tapCounterRef.current += 1;
    const marker: BlindTap = { id: `tap-${tapCounterRef.current}`, time: currentTime, label: 'la' };
    setBlindTaps((current) => {
      const previous = current[line.id] ?? [];
      if (previous.length && marker.time - previous[previous.length - 1].time < .07) return current;
      return { ...current, [line.id]: [...previous, marker] };
    });
  }, [blindReady, currentTime, lines, onNotice, playing]);

  const removeLastBlindTap = useCallback(() => {
    const line = lineAtTime(props.lines, props.currentTime) ?? blindLine;
    if (!line) return;
    setBlindTaps((current) => {
      const values = current[line.id] ?? [];
      if (!values.length) return current;
      return { ...current, [line.id]: values.slice(0, -1) };
    });
  }, [blindLine, props.currentTime, props.lines]);

  useEffect(() => {
    if (tab !== 'blind' || blindPhase !== 'recording' || !blindReady) return;
    const handleBlindKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement) return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (!event.repeat) addBlindTap();
      }
      if (event.key === 'Backspace') {
        event.preventDefault();
        if (!event.repeat) removeLastBlindTap();
      }
    };
    window.addEventListener('keydown', handleBlindKey);
    return () => window.removeEventListener('keydown', handleBlindKey);
  }, [addBlindTap, blindPhase, blindReady, removeLastBlindTap, tab]);

  const startBlindRecording = () => {
    if (!blindReady || !activeLine) return;
    setBlindPhase('recording');
    props.onLooping(false);
    props.onSeek(activeLine.start ?? timedLines[0]?.start ?? 0);
    if (!props.playing) props.onTogglePlay();
  };

  const finishBlindRecording = () => {
    if (props.playing) props.onTogglePlay();
    setBlindPhase('review');
    const firstRecorded = props.lines.find((line) => blindTaps[line.id]?.length);
    if (firstRecorded) props.onSelectLine(firstRecorded.id);
    props.onNotice(`盲听完成，共记录 ${totalTaps} 个 la`);
  };

  const updateTapLabel = (lineId: string, tapId: string, value: string) => {
    setBlindTaps((current) => ({ ...current, [lineId]: (current[lineId] ?? []).map((tap) => tap.id === tapId ? { ...tap, label: value } : tap) }));
  };

  const clearBlindDraft = () => {
    setBlindTaps({});
    setBlindPhase('ready');
    props.onNotice('盲听打点已清空');
  };

  if (!activeLine || !blindLine) return null;
  const reviewRows = Array.from({ length: Math.max(activeTaps.length, blindLine.tokens.length) }, (_, index) => ({ tap: activeTaps[index], token: blindLine.tokens[index] }));
  const lineStart = blindLine.start ?? 0;
  const lineEnd = blindLine.end ?? Math.max(lineStart + 1, props.duration);
  const lineDuration = Math.max(.01, lineEnd - lineStart);

  return (
    <div className="lab-backdrop" role="presentation">
      <section className="lab-modal" role="dialog" aria-modal="true" aria-labelledby="lab-title">
        <header className="lab-header">
          <div><span className="lab-kicker">LYRIC GRID EXPERIMENTS</span><h2 id="lab-title">词格实验室 <em>β</em></h2><p>先凭耳朵打点，再拿原唱发音来核对；工具只帮你看，不替你写。</p></div>
          <div className="lab-overview"><span><b>{props.lines.length}</b> 句</span><span className={totalTaps ? 'good' : ''}><b>{totalTaps}</b> 次打点</span><button onClick={props.onClose} aria-label="关闭实验室">×</button></div>
        </header>

        <nav className="lab-tabs lab-tabs-compact" aria-label="实验室工具">
          {tabLabels.map(([value, label, note]) => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}><b>{label}</b><small>{note}</small></button>)}
        </nav>

        <div className="lab-body">
          {tab === 'blind' && (
            <div className="lab-blind blind-tap-lab">
              <div className="lab-section-heading"><div><span>01</span><h3>空格盲听打点</h3><p>播放时每听见一个实际发音就按一次空格；按错可用 Backspace 撤回。</p></div><div className={`blind-phase-badge ${blindPhase}`}>{blindPhase === 'recording' ? '● 正在录入' : blindPhase === 'review' ? '对照修改' : '等待开始'}</div></div>
              <div className="blind-readiness"><div className={props.audioAvailable ? 'ready' : ''}><span>{props.audioAvailable ? '✓' : '1'}</span><p><b>歌曲音频</b><small>{props.audioAvailable ? props.audioName || '已导入' : '请在主编辑器右侧上传 MP3'}</small></p></div><i>＋</i><div className={props.subtitleAvailable ? 'ready' : ''}><span>{props.subtitleAvailable ? '✓' : '2'}</span><p><b>LRC 时间轴</b><small>{props.subtitleAvailable ? props.subtitleName || '已导入' : '请导入带时间的 .lrc 文件'}</small></p></div></div>
              {!blindReady ? <div className="blind-locked"><span>⌁</span><b>音频和 LRC 要同时到店</b><p>两个文件都导入后，这扇门才会打开。SRT、SVP 或 MIDI 的时间轴不会冒充 LRC。</p></div> : (
                <div className={`blind-stage blind-tap-stage ${blindPhase}`}>
                  <div className="blind-counter"><span>第 {blindLineIndex + 1} / {props.lines.length} 句</span><b>{activeTaps.length} 个 la</b><time>{formatTime(lineStart)} — {formatTime(lineEnd)}</time></div>
                  <div className={`blind-source ${blindPhase === 'review' ? 'revealed' : ''}`}>{blindPhase === 'review' ? <><b>{blindLine.source}</b><small>{blindLine.tokens.map((token) => token.ipa || token.label).join(' ')}</small></> : <><b>{blindPhase === 'recording' ? '只听，不偷看' : '准备好耳朵了吗？'}</b><small>{blindPhase === 'recording' ? '听到一个音就按一下空格' : '从当前 LRC 歌词行开始播放'}</small></>}</div>
                  <div className="blind-tap-timeline" aria-label="本句盲听打点时间线"><i className="blind-tap-playhead" style={{ left: `${Math.max(0, Math.min(100, ((props.currentTime - lineStart) / lineDuration) * 100))}%` }} />{activeTaps.map((tap, index) => <span key={tap.id} style={{ left: `${Math.max(0, Math.min(100, ((tap.time - lineStart) / lineDuration) * 100))}%` }}><b>la</b><small>{index + 1}</small></span>)}</div>
                  <div className="blind-player blind-tap-player"><button onClick={props.onTogglePlay}>{props.playing ? 'Ⅱ 暂停' : '▶ 播放'}</button><input type="range" min={lineStart} max={lineEnd} step=".01" value={Math.max(lineStart, Math.min(props.currentTime, lineEnd))} onChange={(event) => props.onSeek(Number(event.target.value))} /><span>{formatTime(props.currentTime)}</span></div>
                  {blindPhase === 'ready' && <button className="blind-start-button" onClick={startBlindRecording}>从当前句开始盲听</button>}
                  {blindPhase === 'recording' && <div className="blind-hit-zone"><button onClick={addBlindTap}><kbd>SPACE</kbd><b>听到发音，打一个 la</b><small>手机也可以点这里</small></button><button onClick={removeLastBlindTap}>撤回上一个</button><button className="finish" onClick={finishBlindRecording}>完成并对照 →</button></div>}
                  {blindPhase === 'review' && <><div className="blind-review-lines">{timedLines.map((line, index) => <button key={line.id} className={line.id === blindLine.id ? 'active' : ''} onClick={() => { props.onSelectLine(line.id); props.onSeek(line.start ?? 0); }}><span>{String(index + 1).padStart(2, '0')}</span><b>{blindTaps[line.id]?.length ?? 0} la</b><small>{line.source}</small></button>)}</div><div className="blind-compare"><div className="blind-compare-head"><span>你的盲听格</span><i>对照</i><span>原罗马音 / 英标</span></div>{reviewRows.map(({ tap, token }, index) => <div className={`${tap && token ? 'paired' : 'missing'}`} key={`${tap?.id ?? 'missing'}-${token?.id ?? index}`}><span>{String(index + 1).padStart(2, '0')}</span>{tap ? <input value={tap.label} onChange={(event) => updateTapLabel(blindLine.id, tap.id, event.target.value)} aria-label={`第 ${index + 1} 个盲听发音`} /> : <em>未打点</em>}<i>↔</i><b>{token?.ipa || token?.label || '多出的打点'}</b></div>)}</div><div className="blind-review-actions"><button onClick={clearBlindDraft}>清空重录</button><button disabled={!activeTaps.length} onClick={() => props.onApplyPronunciation(blindLine.id, activeTaps.map((tap) => tap.label.trim() || 'la').join(' '))}>应用为本句实际唱法</button></div></>}
                  <div className="blind-controls"><button disabled={blindLineIndex <= 0} onClick={() => { const line = props.lines[blindLineIndex - 1]; props.onSelectLine(line.id); props.onSeek(line.start ?? 0); }}>← 上一句</button><div>{[.5, .75, 1].map((value) => <button key={value} className={props.rate === value ? 'active' : ''} onClick={() => props.onRate(value)}>{value}×</button>)}</div><button disabled={blindLineIndex >= props.lines.length - 1} onClick={() => { const line = props.lines[blindLineIndex + 1]; props.onSelectLine(line.id); props.onSeek(line.start ?? 0); }}>下一句 →</button></div>
                </div>
              )}
            </div>
          )}

          {tab === 'match' && <div className="lab-match"><div className="lab-section-heading"><div><span>02</span><h3>原音—中文声韵对照</h3><p>分数只代表元音唱感接近程度，不代表歌词好坏。</p></div><select value={props.activeId} onChange={(event) => props.onSelectLine(event.target.value)}>{props.lines.map((line, index) => <option key={line.id} value={line.id}>第 {index + 1} 句 · {lineLabel(line)}</option>)}</select></div><div className="sound-match-grid">{noteCellPairs(activeLine).map((pair) => { const reading = analyzeChineseCells(activeLine.target).cells[pair.index]; const original = pair.note?.phoneme || pair.token?.ipa || pair.token?.label || pair.note?.lyric || '—'; const score = pair.cell && pair.cell !== '—' ? soundScore(original, reading?.final ?? '') : 0; return <article key={`${pair.note?.id ?? 'cell'}-${pair.index}`} className={score >= 85 ? 'great' : score >= 60 ? 'near' : score ? 'far' : 'empty'}><span>{String(pair.index + 1).padStart(2, '0')}</span><div><small>原唱</small><b>{original}</b></div><i>→</i><div><small>中文</small><b>{pair.cell || '待填'}</b><em>{reading?.syllable ?? '—'} · {reading?.final || '无韵母'}</em></div><output>{score ? `${score}%` : '—'}</output></article>; })}</div></div>}

          {tab === 'rhyme' && <div className="lab-rhyme"><div className="lab-section-heading"><div><span>03</span><h3>全曲押韵地图</h3><p>相同韵母自动归为同色；只展示你的成品，不补写歌词。</p></div><output>{rhymeCounts.size} 组韵脚</output></div><div className="rhyme-legend">{[...rhymeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([final, count], index) => <span key={final} style={{ '--rhyme-hue': `${(index * 67 + 96) % 360}` } as CSSProperties}><i />{final} 韵 <b>{count}</b></span>)}</div><div className="rhyme-map">{rhymeRows.map(({ line, rhyme }, index) => { const order = [...rhymeCounts.keys()].indexOf(rhyme?.final ?? ''); return <button key={line.id} onClick={() => props.onSelectLine(line.id)} className={!rhyme ? 'empty' : ''} style={{ '--rhyme-hue': `${(Math.max(0, order) * 67 + 96) % 360}` } as CSSProperties}><span>{String(index + 1).padStart(2, '0')}</span><b>{lineLabel(line)}</b><em>{rhyme ? `${rhyme.character} · ${rhyme.syllable} · ${rhyme.final} 韵` : '尚无可识别韵脚'}</em><i /></button>; })}</div></div>}

          {tab === 'check' && <div className="lab-check"><div className="lab-section-heading"><div><span>04</span><h3>导出前自检清单</h3><p>把会影响交付和试听的问题一次找齐。</p></div><output className={checklist.every((item) => item.good) ? 'good' : 'alert'}>{checklist.every((item) => item.good) ? '可以交付' : '还有项目要确认'}</output></div><div className="check-grid">{checklist.map((item) => <article className={item.good ? 'pass' : 'fail'} key={item.label}><span>{item.good ? '✓' : '!'}</span><div><b>{item.label}</b><p>{item.detail}</p></div><output>{item.value}</output></article>)}</div><div className="check-summary"><b>{checklist.every((item) => item.good) ? '所有基础检查都通过了。' : '这些不是硬性答案，只是交付前别忘了亲耳确认。'}</b><p>机器无法判断隐喻、情绪和演唱者的个人习惯，最后决定权始终在你。</p></div></div>}

          <section className="lab-coming-street" aria-label="即将开放的实验工具"><div className="coming-street-heading"><span>AFTER HOURS</span><h3>实验街暂未营业</h3><p>旧工具已经撤下，这四间店正在重新装修。</p></div><div className="locked-shop-grid">{lockedShops.map(([name, note], index) => <article key={name} style={{ '--shop-delay': `${index * .35}s` } as CSSProperties}><div className="shop-sign"><span>COMING SOON</span><b>{name}</b><small>{note}</small></div><div className="shop-shutter"><i /><i /><i /><i /><i /><span>锁</span></div><footer><b>敬请期待</b><small>装修中 · 暂不接客</small></footer></article>)}</div></section>
        </div>
      </section>
    </div>
  );
}
