'use client';

import { CSSProperties, useMemo, useState } from 'react';
import { PronunciationToken, baseCount } from '../lib/phonetics';
import { analyzeChineseCells } from '../lib/chinese';
import { MidiLineMeta } from '../lib/midi';
import { SvpLineMeta } from '../lib/svp';
import { VocaloidLineMeta } from '../lib/vocaloid';
import { WritableProject, exportSvpWithChinese, exportVocaloidWithChinese } from '../lib/project-export';

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

export type LabDraftLine = Pick<LabLine, 'id' | 'source' | 'target' | 'tokens'>;

type LabTab = 'health' | 'match' | 'roll' | 'rhyme' | 'versions' | 'export' | 'check' | 'blind';
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

type Snapshot = {
  id: string;
  name: string;
  createdAt: number;
  lines: LabDraftLine[];
};

type Props = {
  lines: LabLine[];
  activeId: string;
  projectTitle: string;
  currentTime: number;
  duration: number;
  playing: boolean;
  rate: number;
  looping: boolean;
  audioAvailable: boolean;
  writableProject: WritableProject | null;
  onClose: () => void;
  onSelectLine: (id: string) => void;
  onRestoreDraft: (lines: LabDraftLine[]) => void;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onRate: (rate: number) => void;
  onLooping: (value: boolean) => void;
  onNotice: (message: string) => void;
};

const tabLabels: Array<[LabTab, string, string]> = [
  ['health', '填词体检', '咬字与时值'],
  ['match', '声韵对照', '原音与拼音'],
  ['roll', '全曲钢琴窗', '音高与时间'],
  ['rhyme', '押韵地图', '整首韵脚'],
  ['versions', '版本对比', '保存与恢复'],
  ['export', '工程写回', '另存歌声工程'],
  ['check', '导出自检', '查漏补缺'],
  ['blind', '盲听模式', '只凭耳朵填'],
];

const snapshotKey = 'lyric-grid-lab-snapshots-v1';

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

function healthIssues(line: LabLine): Array<{ level: 'danger' | 'warn' | 'tip'; text: string }> {
  const issues: Array<{ level: 'danger' | 'warn' | 'tip'; text: string }> = [];
  const expected = baseCount(line.tokens);
  const filled = line.target.filter((cell) => cell.trim() && cell !== '—').length;
  if (!filled) issues.push({ level: 'danger', text: '这一句还没有中文填词。' });
  else if (filled < expected) issues.push({ level: 'warn', text: `还少 ${expected - filled} 个实际发音字。` });
  else if (filled > expected) issues.push({ level: 'danger', text: `比建议词格多 ${filled - expected} 个字，可能发生抢拍。` });

  const pairs = noteCellPairs(line);
  const pitches = pairs.map((pair) => pair.note?.pitch).filter((value): value is number => value != null);
  const high = pitches.length ? Math.max(...pitches) - 2 : 128;
  const reading = analyzeChineseCells(line.target);
  pairs.forEach((pair) => {
    const final = reading.cells[pair.index]?.final ?? '';
    if (!pair.note || !pair.cell || pair.cell === '—') return;
    if (pair.note.durationSeconds < .13 && /(?:ang|eng|ing|ong|ian|uan)$/i.test(final)) issues.push({ level: 'warn', text: `“${pair.cell}”只有 ${Math.round(pair.note.durationSeconds * 1000)}ms，后鼻音可能咬不完整。` });
    if (pair.note.pitch >= high && /(?:n|ng|i|u)$/i.test(final)) issues.push({ level: 'tip', text: `高音上的“${pair.cell}”收口较紧，可以实唱确认开口度。` });
    if (pair.note.durationSeconds >= .85 && pair.cell.length && /(?:i|u|v)$/i.test(final)) issues.push({ level: 'tip', text: `“${pair.cell}”需要拖 ${pair.note.durationSeconds.toFixed(2)} 秒，闭口韵母可能不够舒展。` });
  });
  if (line.uncertain) issues.push({ level: 'warn', text: '这一句的原唱读法仍是自动推测，建议先盲听确认。' });
  return issues.slice(0, 6);
}

function downloadBlob(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function snapshotDraft(lines: LabLine[]): LabDraftLine[] {
  return lines.map((line) => ({ id: line.id, source: line.source, target: [...line.target], tokens: line.tokens.map((token) => ({ ...token })) }));
}

function loadSnapshots(): Snapshot[] {
  if (typeof window === 'undefined') return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(snapshotKey) ?? '[]') as Snapshot[];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export default function LabModal(props: Props) {
  const [tab, setTab] = useState<LabTab>('health');
  const [snapshots, setSnapshots] = useState<Snapshot[]>(() => loadSnapshots());
  const [baselineId, setBaselineId] = useState(() => loadSnapshots()[0]?.id ?? '');
  const [snapshotName, setSnapshotName] = useState('');
  const [blindReveal, setBlindReveal] = useState(false);
  const [exporting, setExporting] = useState(false);
  const activeIndex = Math.max(0, props.lines.findIndex((line) => line.id === props.activeId));
  const activeLine = props.lines[activeIndex] ?? props.lines[0];
  const allIssues = useMemo(() => props.lines.map((line) => ({ line, issues: healthIssues(line) })), [props.lines]);
  const seriousCount = allIssues.reduce((sum, row) => sum + row.issues.filter((issue) => issue.level !== 'tip').length, 0);
  const rhymeRows = useMemo(() => props.lines.map((line) => ({ line, rhyme: analyzeChineseCells(line.target).rhyme })), [props.lines]);
  const rhymeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    rhymeRows.forEach(({ rhyme }) => { if (rhyme?.final) counts.set(rhyme.final, (counts.get(rhyme.final) ?? 0) + 1); });
    return counts;
  }, [rhymeRows]);
  const baseline = snapshots.find((snapshot) => snapshot.id === baselineId);
  const changedLines = useMemo(() => {
    if (!baseline) return [];
    return props.lines.flatMap((line, index) => {
      const before = baseline.lines.find((candidate) => candidate.id === line.id) ?? baseline.lines[index];
      const beforeText = before?.target.join('') ?? '';
      const afterText = line.target.join('');
      return beforeText === afterText ? [] : [{ line, beforeText, afterText }];
    });
  }, [baseline, props.lines]);
  const rollNotes = useMemo(() => {
    const seen = new Set<string>();
    return props.lines.flatMap((line) => lineNotes(line).flatMap((note) => {
      const key = `${line.vocaloid?.format ?? (line.svp ? 'svp' : 'midi')}-${note.id}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ ...note, lineId: line.id, cell: noteCellPairs(line).find((pair) => pair.note?.id === note.id)?.cell ?? '' }];
    }));
  }, [props.lines]);
  const rollBounds = useMemo(() => {
    const end = Math.max(props.duration, ...rollNotes.map((note) => note.endSeconds), 1);
    const pitches = rollNotes.map((note) => note.pitch);
    return { end, minimum: pitches.length ? Math.min(...pitches) : 48, maximum: pitches.length ? Math.max(...pitches) : 72 };
  }, [props.duration, rollNotes]);
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
      { label: '缺少时间轴', value: untimed, good: untimed === 0, detail: '无法跟随播放或进入钢琴窗' },
      { label: '韵脚未识别', value: noRhyme, good: noRhyme === 0, detail: '检查句尾是否为汉字' },
    ];
  }, [props.lines]);

  const saveSnapshot = () => {
    const next: Snapshot = { id: `version-${Date.now()}`, name: snapshotName.trim() || `版本 ${snapshots.length + 1}`, createdAt: Date.now(), lines: snapshotDraft(props.lines) };
    const values = [next, ...snapshots].slice(0, 12);
    try {
      window.localStorage.setItem(snapshotKey, JSON.stringify(values));
      setSnapshots(values);
      setBaselineId(next.id);
      setSnapshotName('');
      props.onNotice(`已保存“${next.name}”`);
    } catch {
      props.onNotice('版本内容太大，本机存储空间不足');
    }
  };

  const removeSnapshot = (id: string) => {
    const values = snapshots.filter((snapshot) => snapshot.id !== id);
    setSnapshots(values);
    if (baselineId === id) setBaselineId(values[0]?.id ?? '');
    window.localStorage.setItem(snapshotKey, JSON.stringify(values));
  };

  const exportSingingProject = async () => {
    if (!props.writableProject) return;
    setExporting(true);
    try {
      if (props.writableProject.kind === 'svp') {
        const content = exportSvpWithChinese(props.writableProject.sourceText, props.lines);
        downloadBlob(props.writableProject.fileName.replace(/\.svp$/i, '.中文副本.svp'), new Blob([content], { type: 'application/json' }));
      } else {
        const blob = await exportVocaloidWithChinese(props.writableProject, props.lines);
        downloadBlob(props.writableProject.fileName.replace(/\.(vsqx|vpr)$/i, '.中文副本.$1'), blob);
      }
      props.onNotice('已生成中文歌词工程副本，原文件没有改动');
    } catch (error) {
      console.error(error);
      props.onNotice(error instanceof Error ? error.message : '工程副本生成失败');
    } finally {
      setExporting(false);
    }
  };

  if (!activeLine) return null;

  return (
    <div className="lab-backdrop" role="presentation">
      <section className="lab-modal" role="dialog" aria-modal="true" aria-labelledby="lab-title">
        <header className="lab-header">
          <div><span className="lab-kicker">LYRIC GRID EXPERIMENTS</span><h2 id="lab-title">词格实验室 <em>β</em></h2><p>只检查唱感、节奏和结构，不替你生成中文歌词。</p></div>
          <div className="lab-overview"><span><b>{props.lines.length}</b> 句</span><span className={seriousCount ? 'alert' : 'good'}><b>{seriousCount}</b> 项待处理</span><button onClick={props.onClose} aria-label="关闭实验室">×</button></div>
        </header>

        <nav className="lab-tabs" aria-label="实验室工具">
          {tabLabels.map(([value, label, note]) => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}><b>{label}</b><small>{note}</small></button>)}
        </nav>

        <div className="lab-body">
          {tab === 'health' && (
            <div className="lab-health">
              <div className="lab-section-heading"><div><span>01</span><h3>整首填词体检</h3><p>检查字数、短音咬字、高音开口和长音舒展度。</p></div><output>{seriousCount ? `${seriousCount} 项需要确认` : '没有明显问题'}</output></div>
              <div className="health-list">
                {allIssues.map(({ line, issues }, index) => <button key={line.id} className={line.id === props.activeId ? 'active' : ''} onClick={() => props.onSelectLine(line.id)}><span className="health-index">{String(index + 1).padStart(2, '0')}</span><span className="health-copy"><b>{lineLabel(line)}</b><small>{line.source}</small><span>{issues.length ? issues.map((issue, issueIndex) => <em className={issue.level} key={issueIndex}>{issue.text}</em>) : <em className="pass">✓ 唱感结构暂未发现明显问题</em>}</span></span><strong>{issues.filter((issue) => issue.level !== 'tip').length || '✓'}</strong></button>)}
              </div>
            </div>
          )}

          {tab === 'match' && (
            <div className="lab-match">
              <div className="lab-section-heading"><div><span>02</span><h3>原音—中文声韵对照</h3><p>分数只代表元音唱感接近程度，不代表歌词好坏。</p></div><select value={props.activeId} onChange={(event) => props.onSelectLine(event.target.value)}>{props.lines.map((line, index) => <option key={line.id} value={line.id}>第 {index + 1} 句 · {lineLabel(line)}</option>)}</select></div>
              <div className="sound-match-grid">
                {noteCellPairs(activeLine).map((pair) => {
                  const reading = analyzeChineseCells(activeLine.target).cells[pair.index];
                  const original = pair.note?.phoneme || pair.token?.label || pair.note?.lyric || '—';
                  const score = pair.cell && pair.cell !== '—' ? soundScore(original, reading?.final ?? '') : 0;
                  return <article key={`${pair.note?.id ?? 'cell'}-${pair.index}`} className={score >= 85 ? 'great' : score >= 60 ? 'near' : score ? 'far' : 'empty'}><span>{String(pair.index + 1).padStart(2, '0')}</span><div><small>原唱</small><b>{original}</b></div><i>→</i><div><small>中文</small><b>{pair.cell || '待填'}</b><em>{reading?.syllable ?? '—'} · {reading?.final || '无韵母'}</em></div><output>{score ? `${score}%` : '—'}</output></article>;
                })}
              </div>
            </div>
          )}

          {tab === 'roll' && (
            <div className="lab-roll">
              <div className="lab-section-heading"><div><span>03</span><h3>全曲钢琴窗</h3><p>点击音符跳到对应时间；中文会直接显示在音符上。</p></div><div className="lab-transport"><button disabled={!props.audioAvailable} onClick={props.onTogglePlay}>{props.playing ? 'Ⅱ' : '▶'}</button><span>{formatTime(props.currentTime)} / {formatTime(rollBounds.end)}</span></div></div>
              {rollNotes.length ? <div className="piano-scroll"><div className="piano-canvas" style={{ width: `${Math.max(1000, rollBounds.end * 18)}px`, '--pitch-span': String(Math.max(1, rollBounds.maximum - rollBounds.minimum)) } as CSSProperties}><div className="piano-playhead" style={{ left: `${(props.currentTime / rollBounds.end) * 100}%` }} /><div className="piano-grid-lines">{Array.from({ length: 12 }, (_, index) => <i key={index} />)}</div>{rollNotes.map((note) => <button key={`${note.lineId}-${note.id}`} className={`piano-note ${note.lineId === props.activeId ? 'active' : ''} ${note.role}`} style={{ left: `${(note.startSeconds / rollBounds.end) * 100}%`, width: `${Math.max(.16, ((note.endSeconds - note.startSeconds) / rollBounds.end) * 100)}%`, bottom: `${((note.pitch - rollBounds.minimum) / Math.max(1, rollBounds.maximum - rollBounds.minimum)) * 82 + 5}%` }} onClick={() => { props.onSelectLine(note.lineId); props.onSeek(note.startSeconds); }} title={`${note.cell || note.lyric} · M${note.pitch} · ${formatTime(note.startSeconds)}`}><b>{note.cell || (note.role === 'hold' ? '—' : note.lyric)}</b></button>)}</div></div> : <div className="lab-empty-state"><b>还没有音符时间轴</b><p>请先导入 SVP、MIDI、VSQX 或 VPR 工程。</p></div>}
            </div>
          )}

          {tab === 'rhyme' && (
            <div className="lab-rhyme">
              <div className="lab-section-heading"><div><span>04</span><h3>全曲押韵地图</h3><p>相同韵母自动归为同色；只展示你的成品，不补写歌词。</p></div><output>{rhymeCounts.size} 组韵脚</output></div>
              <div className="rhyme-legend">{[...rhymeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([final, count], index) => <span key={final} style={{ '--rhyme-hue': `${(index * 67 + 96) % 360}` } as CSSProperties}><i />{final} 韵 <b>{count}</b></span>)}</div>
              <div className="rhyme-map">{rhymeRows.map(({ line, rhyme }, index) => { const order = [...rhymeCounts.keys()].indexOf(rhyme?.final ?? ''); return <button key={line.id} onClick={() => props.onSelectLine(line.id)} className={!rhyme ? 'empty' : ''} style={{ '--rhyme-hue': `${(Math.max(0, order) * 67 + 96) % 360}` } as CSSProperties}><span>{String(index + 1).padStart(2, '0')}</span><b>{lineLabel(line)}</b><em>{rhyme ? `${rhyme.character} · ${rhyme.syllable} · ${rhyme.final} 韵` : '尚无可识别韵脚'}</em><i /></button>; })}</div>
            </div>
          )}

          {tab === 'versions' && (
            <div className="lab-versions">
              <div className="lab-section-heading"><div><span>05</span><h3>版本快照与 A/B 对比</h3><p>只保存歌词与唱法，不复制庞大的工程音符。</p></div><div className="snapshot-create"><input value={snapshotName} onChange={(event) => setSnapshotName(event.target.value)} placeholder="例如：副歌第二版" /><button onClick={saveSnapshot}>保存当前版本</button></div></div>
              {snapshots.length ? <><div className="snapshot-list">{snapshots.map((snapshot) => <article key={snapshot.id} className={snapshot.id === baselineId ? 'active' : ''}><button onClick={() => setBaselineId(snapshot.id)}><b>{snapshot.name}</b><small>{new Date(snapshot.createdAt).toLocaleString('zh-CN')} · {snapshot.lines.length} 句</small></button><button onClick={() => props.onRestoreDraft(snapshot.lines)}>恢复</button><button onClick={() => removeSnapshot(snapshot.id)}>删除</button></article>)}</div><div className="version-diff"><h4>当前版本与“{baseline?.name}”相比</h4>{changedLines.length ? changedLines.map(({ line, beforeText, afterText }, index) => <div key={line.id}><span>{String(index + 1).padStart(2, '0')}</span><del>{beforeText || '（空）'}</del><i>→</i><ins>{afterText || '（空）'}</ins></div>) : <p>没有歌词变化。</p>}</div></> : <div className="lab-empty-state"><b>还没有保存版本</b><p>先给当前成果拍一张“快照”，之后每次大改都能回来比较。</p><button onClick={saveSnapshot}>保存第一个版本</button></div>}
            </div>
          )}

          {tab === 'export' && (
            <div className="lab-export">
              <div className="lab-section-heading"><div><span>06</span><h3>把中文写回歌声工程</h3><p>只生成一个新副本，音高、时值和参数保留，原文件永远不覆盖。</p></div></div>
              <div className={`export-project-card ${props.writableProject ? 'ready' : ''}`}><span className="export-seal">{props.writableProject?.kind === 'svp' ? 'SVP' : props.writableProject?.fileName.match(/\.(vsqx|vpr)$/i)?.[1].toUpperCase() || '?'}</span><div><b>{props.writableProject?.fileName ?? '本次编辑没有可写回的原工程'}</b><p>{props.writableProject ? '会把每个已填写中文格写入对应歌唱音符；空格、延音和未填写内容保持原样。' : '请从“导入”重新选择 SVP、VSQX 或 VPR，再进入实验室。刷新网页后也需要重新选择原文件。'}</p><ul><li>✓ 另存“中文副本”</li><li>✓ 保留音高与时值</li><li>✓ 清除被替换音符的旧音素，让歌声软件重新发音</li></ul></div><button disabled={!props.writableProject || exporting} onClick={exportSingingProject}>{exporting ? '正在生成副本…' : '下载中文工程副本'}</button></div>
              <div className="export-warning"><b>实验功能</b><p>不同歌声库对中文支持不同。导入副本后请在原软件里检查发音，尤其是日语声库唱中文的情况。</p></div>
            </div>
          )}

          {tab === 'check' && (
            <div className="lab-check">
              <div className="lab-section-heading"><div><span>07</span><h3>导出前自检清单</h3><p>把会影响交付和试听的问题一次找齐。</p></div><output className={checklist.every((item) => item.good) ? 'good' : 'alert'}>{checklist.every((item) => item.good) ? '可以交付' : '还有项目要确认'}</output></div>
              <div className="check-grid">{checklist.map((item) => <article className={item.good ? 'pass' : 'fail'} key={item.label}><span>{item.good ? '✓' : '!'}</span><div><b>{item.label}</b><p>{item.detail}</p></div><output>{item.value}</output></article>)}</div>
              <div className="check-summary"><b>{checklist.every((item) => item.good) ? '所有基础检查都通过了。' : '这些不是硬性答案，只是交付前别忘了亲耳确认。'}</b><p>机器无法判断隐喻、情绪和演唱者的个人习惯，最后决定权始终在你。</p></div>
            </div>
          )}

          {tab === 'blind' && (
            <div className="lab-blind">
              <div className="lab-section-heading"><div><span>08</span><h3>盲听填词模式</h3><p>隐藏原词，只留下时间、词格数量和你的中文，逼自己相信耳朵。</p></div><button className="blind-reveal" onClick={() => setBlindReveal((value) => !value)}>{blindReveal ? '重新隐藏原词' : '揭晓原词'}</button></div>
              <div className="blind-stage"><div className="blind-counter"><span>第 {activeIndex + 1} / {props.lines.length} 句</span><b>{baseCount(activeLine.tokens)} 个发音格</b></div><div className={`blind-source ${blindReveal ? 'revealed' : ''}`}>{blindReveal ? <><b>{activeLine.source}</b><small>{activeLine.tokens.map((token) => token.label).join(' ')}</small></> : <><b>原词已隐藏</b><small>先听，再决定每个字落在哪里</small></>}</div><div className="blind-cells">{activeLine.target.map((cell, index) => <span key={index} className={cell === '—' ? 'hold' : ''}><small>{String(index + 1).padStart(2, '0')}</small><b>{cell || '·'}</b></span>)}</div><div className="blind-player"><button disabled={!props.audioAvailable} onClick={props.onTogglePlay}>{props.playing ? 'Ⅱ 暂停' : '▶ 播放当前句'}</button><input type="range" min={activeLine.start ?? 0} max={activeLine.end ?? Math.max(props.duration, 1)} step=".01" value={Math.max(activeLine.start ?? 0, Math.min(props.currentTime, activeLine.end ?? Math.max(props.duration, 1)))} onChange={(event) => props.onSeek(Number(event.target.value))} /><span>{formatTime(props.currentTime)}</span></div><div className="blind-controls"><button disabled={activeIndex <= 0} onClick={() => { const line = props.lines[activeIndex - 1]; props.onSelectLine(line.id); props.onSeek(line.start ?? 0); }}>← 上一句</button><div>{[.5, .75, 1].map((value) => <button key={value} className={props.rate === value ? 'active' : ''} onClick={() => props.onRate(value)}>{value}×</button>)}<button className={props.looping ? 'active' : ''} onClick={() => props.onLooping(!props.looping)}>↻ 单句循环</button></div><button disabled={activeIndex >= props.lines.length - 1} onClick={() => { const line = props.lines[activeIndex + 1]; props.onSelectLine(line.id); props.onSeek(line.start ?? 0); }}>下一句 →</button></div>{!props.audioAvailable && <p className="blind-no-audio">先回到主编辑器右侧上传歌曲音频，盲听模式才可以播放。</p>}</div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
