'use client';

import { ChangeEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  ParsedLyricLine,
  PronunciationToken,
  baseCount,
  manualPronunciationToTokens,
  parseLyricLine,
} from '../lib/phonetics';

type LyricLine = ParsedLyricLine & {
  id: string;
  target: string[];
  start?: number;
  end?: number;
};

const token = (
  id: string,
  label: string,
  kind: PronunciationToken['kind'] = 'normal',
  source: PronunciationToken['source'] = 'ja',
  kana?: string,
): PronunciationToken => ({ id, label, kind, source, kana, counted: kind !== 'absorbed' });

const seedLines: LyricLine[] = [
  {
    id: 'sample-1', source: 'どうして どうして 私だけ', kana: 'どうして　どうして　わたしだけ', language: 'ja', uncertain: false,
    tokens: [token('1-1', 'dō', 'long'), token('1-2', 'shi'), token('1-3', 'te'), token('1-4', 'dō', 'long'), token('1-5', 'shi'), token('1-6', 'te'), token('1-7', 'wa'), token('1-8', 'ta'), token('1-9', 'shi'), token('1-10', 'da'), token('1-11', 'ke')],
    target: ['告', '诉', '我', '告', '诉', '我', '为', '何', '只', '有', '我'],
  },
  {
    id: 'sample-2', source: '乾燥し切った眼でlove-la-villain', kana: 'かんそうしきっためで love-la-villain', language: 'mixed', uncertain: true,
    tokens: [
      token('2-1', 'ka'), token('2-2', 'n', 'absorbed', 'ja', 'ん'), token('2-3', 'sō', 'long'), token('2-4', 'shi'), token('2-5', 'ki'), token('2-6', 'q', 'absorbed', 'ja', 'っ'), token('2-7', 'ta'), token('2-8', 'me'), token('2-9', 'de'),
      token('2-10', 'ra', 'normal', 'manual'), token('2-11', 'bu', 'normal', 'manual'), token('2-12', 'ra', 'normal', 'manual'), token('2-13', 'vi', 'normal', 'manual'), token('2-14', 'ra', 'normal', 'manual'), token('2-15', 'n', 'absorbed', 'manual'),
    ],
    target: Array.from({ length: 12 }, () => ''),
  },
  {
    id: 'sample-3', source: '今に見てろよ 超変身', kana: 'いまにみてろよ　ちょうへんしん', language: 'ja', uncertain: false,
    tokens: [token('3-1', 'i'), token('3-2', 'ma'), token('3-3', 'ni'), token('3-4', 'mi'), token('3-5', 'te'), token('3-6', 'ro'), token('3-7', 'yo'), token('3-8', 'chō', 'long'), token('3-9', 'he'), token('3-10', 'n', 'absorbed'), token('3-11', 'shi'), token('3-12', 'n', 'absorbed')],
    target: ['你', '的', '触', '摸', '让', '我', '—', '心', '脏', '暂', '停'],
    start: 42.18,
    end: 45.62,
  },
];

const languageLabel = { ja: '日语', en: '英语', mixed: '日英混合' } as const;
const storageKey = 'lyric-grid-project-v1';

function formatTime(value: number): string {
  if (!Number.isFinite(value)) return '00:00.00';
  const minutes = Math.floor(value / 60);
  const seconds = value - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}`;
}

function downloadFile(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const [lines, setLines] = useState<LyricLine[]>(seedLines);
  const [activeId, setActiveId] = useState('sample-3');
  const [projectTitle, setProjectTitle] = useState('未命名翻填工程');
  const [selectedCell, setSelectedCell] = useState(5);
  const [showKana, setShowKana] = useState(false);
  const [editingPronunciation, setEditingPronunciation] = useState(false);
  const [manualPronunciation, setManualPronunciation] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [notice, setNotice] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [audioUrl, setAudioUrl] = useState('');
  const [audioName, setAudioName] = useState('');
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(0.75);
  const [looping, setLooping] = useState(true);
  const audioRef = useRef<HTMLAudioElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const activeIndex = lines.findIndex((line) => line.id === activeId);
  const activeLine = lines[activeIndex] ?? lines[0];
  const suggestedCount = activeLine ? baseCount(activeLine.tokens) : 0;
  const currentCount = activeLine
    ? activeLine.target.filter((cell) => cell.trim() && cell !== '—').length
    : 0;
  const delta = currentCount - suggestedCount;

  useEffect(() => {
    queueMicrotask(() => {
      const saved = window.localStorage.getItem(storageKey);
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as { title?: string; lines?: LyricLine[]; activeId?: string };
          if (parsed.lines?.length) {
            setLines(parsed.lines);
            setActiveId(parsed.activeId ?? parsed.lines[0].id);
            setProjectTitle(parsed.title ?? '未命名翻填工程');
          }
        } catch {
          window.localStorage.removeItem(storageKey);
        }
      }
      setHydrated(true);
    });
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(storageKey, JSON.stringify({ title: projectTitle, lines, activeId }));
  }, [activeId, hydrated, lines, projectTitle]);

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  const updateActiveLine = (updater: (line: LyricLine) => LyricLine) => {
    setLines((current) => current.map((line) => line.id === activeId ? updater(line) : line));
  };

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 1800);
  };

  const startPronunciationEdit = () => {
    if (!activeLine) return;
    setManualPronunciation(activeLine.tokens.map((item) => item.label).join(' '));
    setEditingPronunciation(true);
  };

  const savePronunciation = () => {
    const tokens = manualPronunciationToTokens(manualPronunciation);
    updateActiveLine((line) => ({ ...line, tokens, uncertain: false }));
    setEditingPronunciation(false);
    flash('实际唱法已更新');
  };

  const toggleToken = (id: string) => {
    updateActiveLine((line) => ({
      ...line,
      tokens: line.tokens.map((item) => item.id === id
        ? { ...item, counted: !item.counted, kind: item.counted ? 'absorbed' : 'normal' }
        : item),
    }));
  };

  const updateCell = (index: number, value: string) => {
    const character = Array.from(value).slice(-1)[0] ?? '';
    updateActiveLine((line) => ({
      ...line,
      target: line.target.map((cell, cellIndex) => cellIndex === index ? character : cell),
    }));
  };

  const pasteCells = (index: number, text: string) => {
    const characters = Array.from(text.replace(/\s+/g, ''));
    if (!characters.length) return;
    updateActiveLine((line) => {
      const target = [...line.target];
      characters.forEach((character, offset) => { target[index + offset] = character; });
      return { ...line, target };
    });
    setSelectedCell(index + characters.length - 1);
  };

  const addSustain = () => {
    updateActiveLine((line) => {
      const target = [...line.target];
      target.splice(Math.min(selectedCell + 1, target.length), 0, '—');
      return { ...line, target };
    });
    setSelectedCell((value) => value + 1);
  };

  const splitCell = () => {
    updateActiveLine((line) => {
      const target = [...line.target];
      target.splice(Math.min(selectedCell + 1, target.length), 0, '');
      return { ...line, target };
    });
    setSelectedCell((value) => value + 1);
  };

  const mergeCell = () => {
    if (selectedCell < 0) return;
    updateCell(selectedCell, '—');
  };

  const removeCell = () => {
    updateActiveLine((line) => ({
      ...line,
      target: line.target.length > 1 ? line.target.filter((_, index) => index !== selectedCell) : line.target,
    }));
    setSelectedCell((value) => Math.max(0, value - 1));
  };

  const analyzeLyrics = async () => {
    const sourceLines = importText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!sourceLines.length) return;
    setAnalyzing(true);
    try {
      const parsed = await Promise.all(sourceLines.map((line, index) => parseLyricLine(line, index)));
      const nextLines: LyricLine[] = parsed.map((line, index) => ({
        ...line,
        id: `line-${Date.now()}-${index}`,
        target: Array.from({ length: Math.max(1, baseCount(line.tokens)) }, () => ''),
      }));
      setLines(nextLines);
      setActiveId(nextLines[0].id);
      setSelectedCell(0);
      setImportOpen(false);
      setImportText('');
      flash(`已拆出 ${nextLines.length} 句歌词`);
    } catch (error) {
      console.error(error);
      flash('发音辞典加载失败，请稍后重试');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleAudio = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const nextUrl = URL.createObjectURL(file);
    setAudioUrl(nextUrl);
    setAudioName(file.name);
    setCurrentTime(0);
    flash('音频只在本机打开');
  };

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio) {
      fileRef.current?.click();
      return;
    }
    if (audio.paused) await audio.play();
    else audio.pause();
  };

  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (looping && activeLine?.end != null && audio.currentTime >= activeLine.end) {
      audio.currentTime = activeLine.start ?? 0;
      void audio.play();
    }
    setCurrentTime(audio.currentTime);
  };

  const cycleRate = () => {
    const options = [0.5, 0.75, 1];
    const next = options[(options.indexOf(rate) + 1) % options.length];
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  const setMarker = (kind: 'start' | 'end') => {
    updateActiveLine((line) => ({ ...line, [kind]: currentTime }));
    flash(kind === 'start' ? '已设为本句句首' : '已设为本句句尾');
  };

  const copyLyrics = async () => {
    const text = lines.map((line) => line.target.filter((cell) => cell !== '—').join('')).join('\n');
    await navigator.clipboard.writeText(text);
    flash('整首中文歌词已复制');
  };

  const exportProject = () => {
    downloadFile(`${projectTitle || '词格工程'}.lyric-grid.json`, JSON.stringify({ version: 1, title: projectTitle, lines }, null, 2), 'application/json');
    flash('项目文件已导出');
  };

  const pronunciationLabel = useMemo(
    () => activeLine?.tokens.map((item) => item.label).join(' ') ?? '',
    [activeLine],
  );

  if (!activeLine) return null;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="词格 Lyric Grid">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span className="brand-name">词格</span>
          <span className="brand-en">LYRIC GRID</span>
        </div>
        <label className="project-title">
          <span className="status-dot" />
          <input value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} aria-label="工程名称" />
          <span className="saved-label">{hydrated ? '已保存到本机' : '正在读取'}</span>
        </label>
        <div className="top-actions">
          <button className="button button-quiet" onClick={() => setImportOpen(true)}>导入歌词</button>
          <button className="button button-quiet export-button" onClick={exportProject}>导出</button>
          <button className="button button-primary" onClick={() => setImportOpen(true)}>＋ 新建工程</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="line-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">歌词行</span><strong>{lines.length} 句歌词</strong></div>
            <button className="icon-button" aria-label="添加歌词行" onClick={() => setImportOpen(true)}>＋</button>
          </div>
          <div className="line-list">
            {lines.map((line, index) => {
              const count = baseCount(line.tokens);
              const filled = line.target.some((cell) => cell && cell !== '—');
              return (
                <button className={`line-item ${line.id === activeId ? 'active' : ''}`} key={line.id} onClick={() => { setActiveId(line.id); setSelectedCell(0); }}>
                  <span className="line-index">{String(index + 1).padStart(2, '0')}</span>
                  <span className="line-copy"><span lang="ja">{line.source}</span><small>{line.id === activeId ? '正在编辑' : filled ? '已有填词' : '尚未填写'}</small></span>
                  <span className="line-count">{count}<small>字</small></span>
                </button>
              );
            })}
          </div>
          <button className="copy-all" onClick={copyLyrics}>复制整首中文歌词</button>
          <div className="local-note"><span className="lock-icon">●</span><p><strong>仅保存在这台设备</strong><br />歌词和音频不会上传。</p></div>
        </aside>

        <section className="editor-panel">
          <div className="editor-heading">
            <div>
              <span className="eyebrow">第 {String(activeIndex + 1).padStart(2, '0')} 句 · {languageLabel[activeLine.language]}{activeLine.uncertain ? ' · 需试听' : ''}</span>
              <h1 lang="ja">{activeLine.source}</h1>
              {showKana && <p className="kana-line">{activeLine.kana}</p>}
            </div>
            <div className="count-summary" aria-label="字数统计">
              <div><span>基础建议</span><strong>{suggestedCount}<small>字</small></strong></div>
              <div className="current-count"><span>当前设计</span><strong>{currentCount}<small>字</small></strong></div>
            </div>
          </div>

          <section className="editor-section pronunciation-section">
            <div className="section-title-row">
              <div><span className="step-number">01</span><h2>实际唱法</h2><p>点击任意发音格，可切换是否需要新中文字</p></div>
              <div className="section-actions">
                {activeLine.kana && <button className="text-button" onClick={() => setShowKana((value) => !value)}>{showKana ? '收起假名' : '显示假名'}</button>}
                <button className="text-button" onClick={startPronunciationEdit}>编辑唱法</button>
              </div>
            </div>

            {editingPronunciation ? (
              <div className="pronunciation-editor">
                <input value={manualPronunciation} onChange={(event) => setManualPronunciation(event.target.value)} aria-label="用空格分开发音" autoFocus />
                <button onClick={() => setEditingPronunciation(false)}>取消</button>
                <button className="save-pronunciation" onClick={savePronunciation}>应用</button>
                <small>用空格分格，例如：love 改成 ra bu；单独的 n、q、cl 默认可吸收。</small>
              </div>
            ) : (
              <div className="token-track" aria-label="分格罗马音">
                {activeLine.tokens.map((item) => (
                  <button className={`phoneme-token ${item.kind} ${!item.counted ? 'not-counted' : ''}`} key={item.id} onClick={() => toggleToken(item.id)} title={item.counted ? '计入基础字数；点击改为可吸收' : '不计入基础字数；点击改为普通发音'}>
                    <span>{item.label}</span>
                    {!item.counted && <small>吸收</small>}
                    {item.kind === 'long' && item.counted && <small>长音</small>}
                    {item.kind === 'uncertain' && <small>待确认</small>}
                  </button>
                ))}
              </div>
            )}

            <div className="analysis-note"><span className="analysis-spark">✦</span>{activeLine.uncertain ? '英文先按标准发音估算；如果原唱采用日式或特殊唱法，请点“编辑唱法”按听到的结果修改。' : `当前唱法为 ${pronunciationLabel}；灰色格默认由相邻中文字吸收。`}</div>
          </section>

          <section className="editor-section target-section">
            <div className="section-title-row">
              <div><span className="step-number">02</span><h2>中文填词</h2><p>可直接粘贴整句；延音不计入当前字数</p></div>
              <div className="mini-toolbar" aria-label="编辑工具">
                <button onClick={mergeCell}>合并为延音</button>
                <button onClick={splitCell}>拆一格</button>
                <button className="active" onClick={addSustain}>＋ 延音</button>
                <button onClick={removeCell}>删除格</button>
              </div>
            </div>

            <div className="lyric-grid" aria-label="中文逐格编辑器">
              {activeLine.target.map((cell, index) => (
                <label className={`lyric-cell ${cell === '—' ? 'sustain' : ''} ${selectedCell === index ? 'selected' : ''}`} key={`${activeLine.id}-${index}`} onClick={() => setSelectedCell(index)}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <input
                    aria-label={`第 ${index + 1} 格`}
                    value={cell}
                    onFocus={() => setSelectedCell(index)}
                    onChange={(event) => updateCell(index, event.target.value)}
                    onPaste={(event) => { event.preventDefault(); pasteCells(index, event.clipboardData.getData('text')); }}
                    onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                      if (event.key === 'ArrowRight') setSelectedCell(Math.min(index + 1, activeLine.target.length - 1));
                      if (event.key === 'ArrowLeft') setSelectedCell(Math.max(index - 1, 0));
                    }}
                  />
                </label>
              ))}
              <button className="add-cell" aria-label="添加一格" onClick={splitCell}>＋</button>
            </div>

            <div className="change-ledger">
              <div><span className={delta < 0 ? 'minus' : 'neutral'}>{delta < 0 ? delta : '—'}</span><p><strong>延音与合并</strong><small>少起一个中文读音</small></p></div>
              <div><span className={delta > 0 ? 'plus' : 'neutral'}>{delta > 0 ? `＋${delta}` : '—'}</span><p><strong>拆音设计</strong><small>在长音里增加落字</small></p></div>
              <span className={`balanced ${delta !== 0 ? 'shifted' : ''}`}>{delta === 0 ? '当前与基础建议持平' : delta > 0 ? `当前比建议多 ${delta} 字` : `当前比建议少 ${Math.abs(delta)} 字`}</span>
            </div>
          </section>
        </section>

        <aside className="listen-panel">
          <div className="listen-heading"><span className="eyebrow">听感校对</span><h2>这一句怎么唱</h2></div>
          <div className="audio-card">
            <input ref={fileRef} type="file" accept="audio/*" onChange={handleAudio} hidden />
            <audio ref={audioRef} src={audioUrl || undefined} onLoadedMetadata={(event) => { setDuration(event.currentTarget.duration); event.currentTarget.playbackRate = rate; }} onTimeUpdate={handleTimeUpdate} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
            <div className="waveform" aria-hidden="true">{Array.from({ length: 38 }, (_, index) => <i key={index} style={{ height: `${18 + ((index * 17) % 54)}%` }} />)}</div>
            <input className="audio-slider" type="range" min="0" max={duration || 1} step="0.01" value={Math.min(currentTime, duration || 1)} onChange={(event) => { const value = Number(event.target.value); setCurrentTime(value); if (audioRef.current) audioRef.current.currentTime = value; }} aria-label="音频进度" />
            <div className="audio-time"><span>{formatTime(currentTime)}</span><span>{formatTime(duration)}</span></div>
            <div className="transport"><button className="speed-button" onClick={cycleRate}>{rate}×</button><button className="play-button" aria-label={playing ? '暂停' : '播放'} onClick={togglePlay}>{playing ? 'Ⅱ' : '▶'}</button><button className={`loop-button ${looping ? 'on' : ''}`} onClick={() => setLooping((value) => !value)}>↻ 循环</button></div>
            {audioName ? <p className="audio-name" title={audioName}>{audioName}</p> : <button className="upload-audio" onClick={() => fileRef.current?.click()}>上传歌曲音频</button>}
            <div className="marker-actions"><button onClick={() => setMarker('start')}>设为句首</button><button onClick={() => setMarker('end')}>设为句尾</button></div>
            <div className="marker-time"><span>A {formatTime(activeLine.start ?? 0)}</span><span>B {activeLine.end != null ? formatTime(activeLine.end) : '未设置'}</span></div>
          </div>
          <div className="legend-card"><h3>格子说明</h3><p><span className="legend-dot normal" />普通发音 <small>建议填一字</small></p><p><span className="legend-dot long" />长音 <small>默认一字，可拆</small></p><p><span className="legend-dot absorbed" />可吸收 <small>默认不添字</small></p></div>
          <div className="tip-card"><span>提示</span><p>基础建议不是硬性答案。只要唱起来顺，你可以把延音移动到任何位置。</p></div>
        </aside>
      </div>

      {importOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !analyzing) setImportOpen(false); }}>
          <section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
            <button className="modal-close" aria-label="关闭" onClick={() => setImportOpen(false)}>×</button>
            <span className="eyebrow">新建歌词工程</span>
            <h2 id="import-title">把原歌词粘贴进来</h2>
            <p>每一行会作为一句。支持日语、英语和日英混合歌词。</p>
            <textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={'どうして どうして 私だけ\n乾燥し切った眼でlove-la-villain'} autoFocus />
            <div className="modal-help"><span>日语</span> 自动生成假名和分格罗马音 <span>英语</span> 自动生成 IPA，可按原唱修改</div>
            <div className="modal-actions"><button onClick={() => setImportOpen(false)}>取消</button><button className="analyze-button" disabled={!importText.trim() || analyzing} onClick={analyzeLyrics}>{analyzing ? '正在加载发音辞典…' : '分析歌词 →'}</button></div>
          </section>
        </div>
      )}

      {notice && <div className="toast" role="status">{notice}</div>}
    </main>
  );
}
