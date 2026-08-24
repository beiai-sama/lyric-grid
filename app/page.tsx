'use client';

import { CSSProperties, ChangeEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  ParsedLyricLine,
  PronunciationToken,
  baseCount,
  linkPronunciationTokens,
  manualPronunciationToTokens,
  parseLyricLine,
} from '../lib/phonetics';
import {
  lyricSimilarity,
  parseLrc,
  parseSrt,
  recognizeSubtitleText,
  targetTextToCells,
} from '../lib/subtitles';
import { analyzeChineseCells } from '../lib/chinese';
import {
  SvpLineMeta,
  SvpProject,
  importSvpTrack,
  parseSvpProject,
} from '../lib/svp';

type LyricLine = ParsedLyricLine & {
  id: string;
  target: string[];
  start?: number;
  end?: number;
  svp?: SvpLineMeta;
};

type PendingSvpImport = {
  fileName: string;
  project: SvpProject;
  trackId: string;
  maximumSyllables: number;
};

type ThemeConfig = {
  accent: string;
  background: string;
  panel: string;
  backgroundImage: string;
  backgroundName: string;
  backgroundOpacity: number;
};

type AiTask = 'translate' | 'rhyme' | 'imagery' | 'music';

type AiConfig = {
  endpoint: string;
  model: string;
};

const defaultTheme: ThemeConfig = {
  accent: '#c8f36b',
  background: '#0d1214',
  panel: '#151b1d',
  backgroundImage: '',
  backgroundName: '',
  backgroundOpacity: 0.2,
};

const defaultAiConfig: AiConfig = {
  endpoint: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-4.7-flash',
};

const aiTaskLabels: Record<AiTask, { title: string; note: string }> = {
  translate: { title: '日语直译', note: '忠实解释原意，不按字数适配' },
  rhyme: { title: '韵脚方向', note: '找韵母和单词素材，不写成品句' },
  imagery: { title: '意象隐喻', note: '梳理画面、叙事和关键词' },
  music: { title: '音乐背景', note: '从文本推测情绪和演唱口吻' },
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

const languageLabel = { ja: '日语', en: '英语', mixed: '日英混合', zh: '中文' } as const;
const storageKey = 'lyric-grid-project-v1';
const tutorialStorageKey = 'lyric-grid-tutorial-dismissed-v1';
const themeStorageKey = 'lyric-grid-theme-v1';
const aiStorageKey = 'lyric-grid-ai-config-v1';
const phoneticVersion = 2;

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

async function readLyricFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    const gb18030 = new TextDecoder('gb18030').decode(buffer);
    return gb18030.includes('\uFFFD') ? utf8 : gb18030;
  } catch {
    return utf8;
  }
}

async function compressBackground(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
  if (file.size > 12 * 1024 * 1024) throw new Error('背景图片请控制在 12MB 以内');
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('这张图片无法读取'));
      image.src = source;
    });
    const scale = Math.min(1, 1920 / image.naturalWidth, 1200 / image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法处理这张图片');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/webp', 0.78);
  } finally {
    URL.revokeObjectURL(source);
  }
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
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [hideTutorialNextTime, setHideTutorialNextTime] = useState(false);
  const [svpImport, setSvpImport] = useState<PendingSvpImport | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewShowPronunciation, setPreviewShowPronunciation] = useState(true);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeConfig>(defaultTheme);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiConfig, setAiConfig] = useState<AiConfig>(defaultAiConfig);
  const [aiKey, setAiKey] = useState('');
  const [aiTask, setAiTask] = useState<AiTask>('translate');
  const [aiScope, setAiScope] = useState<'current' | 'all'>('current');
  const [aiFocus, setAiFocus] = useState('');
  const [aiResult, setAiResult] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [audioUrl, setAudioUrl] = useState('');
  const [audioName, setAudioName] = useState('');
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(0.75);
  const [looping, setLooping] = useState(true);
  const [followLyrics, setFollowLyrics] = useState(false);
  const [subtitleName, setSubtitleName] = useState('');
  const audioRef = useRef<HTMLAudioElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const subtitleRef = useRef<HTMLInputElement>(null);
  const svpRef = useRef<HTMLInputElement>(null);
  const backgroundRef = useRef<HTMLInputElement>(null);
  const editorPanelRef = useRef<HTMLElement>(null);
  const lineButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const activeIndex = lines.findIndex((line) => line.id === activeId);
  const activeLine = lines[activeIndex] ?? lines[0];
  const suggestedCount = activeLine ? baseCount(activeLine.tokens) : 0;
  const currentCount = activeLine
    ? activeLine.target.filter((cell) => cell.trim() && cell !== '—').length
    : 0;
  const delta = currentCount - suggestedCount;
  const chinesePronunciation = useMemo(
    () => analyzeChineseCells(activeLine?.target ?? []),
    [activeLine],
  );
  const lineRhymes = useMemo(
    () => new Map(lines.map((line) => [line.id, analyzeChineseCells(line.target).rhyme])),
    [lines],
  );
  const previewStats = useMemo(() => {
    const completed = lines.filter((line) => line.target.some((cell) => cell.trim() && cell !== '—')).length;
    const rhymeCounts = new Map<string, number>();
    lineRhymes.forEach((rhyme) => {
      if (rhyme?.final) rhymeCounts.set(rhyme.final, (rhymeCounts.get(rhyme.final) ?? 0) + 1);
    });
    const commonRhymes = [...rhymeCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 4);
    return { completed, commonRhymes };
  }, [lineRhymes, lines]);
  const themeStyle = useMemo(() => ({
    '--lime': theme.accent,
    '--background': theme.background,
    '--panel': theme.panel,
    '--custom-bg-image': theme.backgroundImage ? `url(${JSON.stringify(theme.backgroundImage)})` : 'none',
    '--custom-bg-opacity': String(theme.backgroundOpacity),
  }) as CSSProperties, [theme]);
  const activeSvpPitchRange = useMemo(() => {
    const pitches = activeLine?.svp?.notes.map((note) => note.pitch) ?? [];
    return {
      minimum: pitches.length ? Math.min(...pitches) : 60,
      maximum: pitches.length ? Math.max(...pitches) : 60,
    };
  }, [activeLine]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => void (async () => {
      const saved = window.localStorage.getItem(storageKey);
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as { title?: string; lines?: LyricLine[]; activeId?: string; phoneticVersion?: number };
          if (parsed.lines?.length) {
            const restoredLines = parsed.phoneticVersion === phoneticVersion
              ? parsed.lines
              : await Promise.all(parsed.lines.map(async (line, index) => {
                let tokens = linkPronunciationTokens(line.tokens);
                let kana = line.kana;
                let language = line.language;
                let uncertain = line.uncertain;

                if (!line.tokens.some((item) => item.source === 'manual')) {
                  try {
                    const reparsed = await parseLyricLine(line.source, index);
                    tokens = reparsed.tokens;
                    kana = reparsed.kana;
                    language = reparsed.language;
                    uncertain = reparsed.uncertain;
                  } catch {
                    // Keep the existing analysis if the local pronunciation dictionary is unavailable.
                  }
                }

                const hasChineseDraft = line.target.some((cell) => cell.trim());
                return {
                  ...line,
                  kana,
                  language,
                  uncertain,
                  tokens,
                  target: hasChineseDraft
                    ? line.target
                    : Array.from({ length: Math.max(1, baseCount(tokens)) }, () => ''),
                };
              }));
            if (cancelled) return;
            setLines(restoredLines);
            setActiveId(parsed.activeId ?? parsed.lines[0].id);
            setProjectTitle(parsed.title ?? '未命名翻填工程');
          }
        } catch {
          window.localStorage.removeItem(storageKey);
        }
      }
      const savedTheme = window.localStorage.getItem(themeStorageKey);
      if (savedTheme) {
        try {
          setTheme({ ...defaultTheme, ...JSON.parse(savedTheme) as Partial<ThemeConfig> });
        } catch {
          window.localStorage.removeItem(themeStorageKey);
        }
      }
      const savedAiConfig = window.localStorage.getItem(aiStorageKey);
      if (savedAiConfig) {
        try {
          setAiConfig({ ...defaultAiConfig, ...JSON.parse(savedAiConfig) as Partial<AiConfig> });
        } catch {
          window.localStorage.removeItem(aiStorageKey);
        }
      }
      if (!cancelled) {
        const tutorialDismissed = window.localStorage.getItem(tutorialStorageKey) === '1';
        setHideTutorialNextTime(tutorialDismissed);
        setTutorialOpen(!tutorialDismissed);
        setHydrated(true);
      }
    })());
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(storageKey, JSON.stringify({ phoneticVersion, title: projectTitle, lines, activeId }));
  }, [activeId, hydrated, lines, projectTitle]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(themeStorageKey, JSON.stringify(theme));
    } catch {
      console.warn('The custom background is too large for localStorage and will only remain visible in this session.');
    }
  }, [hydrated, theme]);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(aiStorageKey, JSON.stringify(aiConfig));
  }, [aiConfig, hydrated]);

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  useEffect(() => {
    if (!followLyrics || !playing) return;
    lineButtonRefs.current.get(activeId)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    editorPanelRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [activeId, followLyrics, playing]);

  const updateActiveLine = (updater: (line: LyricLine) => LyricLine) => {
    setLines((current) => current.map((line) => line.id === activeId ? updater(line) : line));
  };

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 1800);
  };

  const openTutorial = () => {
    setHideTutorialNextTime(window.localStorage.getItem(tutorialStorageKey) === '1');
    setTutorialOpen(true);
  };

  const closeTutorial = () => {
    if (hideTutorialNextTime) window.localStorage.setItem(tutorialStorageKey, '1');
    else window.localStorage.removeItem(tutorialStorageKey);
    setTutorialOpen(false);
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
    updateActiveLine((line) => {
      const index = line.tokens.findIndex((item) => item.id === id);
      const item = line.tokens[index];
      if (!item) return line;

      if (item.linkCandidate && index > 0) {
        const previous = line.tokens[index - 1];
        const currentPart = { ...item };
        delete currentPart.linkCandidate;
        const linked: PronunciationToken = {
          id: `${previous.id}-linked-${item.id}`,
          label: `${previous.label}+${item.label}`,
          kana: `${previous.kana ?? ''}${item.kana ?? ''}` || undefined,
          kind: 'linked',
          counted: true,
          source: 'ja',
          components: [previous, currentPart],
        };
        return { ...line, tokens: [...line.tokens.slice(0, index - 1), linked, ...line.tokens.slice(index + 1)] };
      }

      return {
        ...line,
        tokens: line.tokens.flatMap((tokenItem) => {
          if (tokenItem.id !== id) return [tokenItem];
          if (tokenItem.kind === 'linked' && tokenItem.components?.length) return tokenItem.components;
          return [{ ...tokenItem, counted: !tokenItem.counted, kind: tokenItem.counted ? 'absorbed' : 'normal' }];
        }),
      };
    });
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

  const handleSubtitle = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const content = await readLyricFile(file);
    const lrcFirst = /\.lrc$/i.test(file.name);
    const primaryCues = lrcFirst ? parseLrc(content) : parseSrt(content);
    const cues = primaryCues.length ? primaryCues : lrcFirst ? parseSrt(content) : parseLrc(content);
    const formatLabel = parseLrc(content).length ? 'LRC' : 'SRT';
    event.target.value = '';
    if (!cues.length) {
      flash('没有识别到有效的歌词时间轴');
      return;
    }

    setAnalyzing(true);
    try {
      const usedCues = new Set<number>();
      const assignments = lines.map((line) => {
        let bestIndex = -1;
        let bestScore = 0;
        cues.forEach((cue, cueIndex) => {
          if (usedCues.has(cueIndex)) return;
          const score = Math.max(...cue.lines.map((text) => lyricSimilarity(text, line.source)));
          if (score > bestScore) {
            bestScore = score;
            bestIndex = cueIndex;
          }
        });
        if (bestIndex >= 0 && bestScore >= 0.58) usedCues.add(bestIndex);
        else bestIndex = -1;
        return { cueIndex: bestIndex, score: bestScore };
      });
      const strongMatches = assignments.filter((assignment) => assignment.cueIndex >= 0).length;
      const comparableCount = Math.min(cues.length, lines.length);
      const requiredStrongMatches = comparableCount === 1 ? 1 : Math.max(2, Math.ceil(comparableCount * 0.4));
      const sequentialMatch = strongMatches < requiredStrongMatches && cues.length === lines.length;

      if (strongMatches >= requiredStrongMatches || sequentialMatch) {
        let recognizedTargets = 0;
        const nextLines = lines.map((line, index) => {
          const cueIndex = sequentialMatch ? index : assignments[index].cueIndex;
          if (cueIndex < 0) return line;
          const cue = cues[cueIndex];
          const recognized = recognizeSubtitleText(cue, line.source);
          const hasDraft = line.target.some((cell) => cell.trim());
          const recognizedTarget = !hasDraft && recognized.target ? targetTextToCells(recognized.target) : [];
          if (recognizedTarget.length) recognizedTargets += 1;
          return {
            ...line,
            start: cue.start,
            end: cue.end,
            target: recognizedTarget.length ? recognizedTarget : line.target,
          };
        });
        setLines(nextLines);
        const firstTimedLine = nextLines.find((line) => line.start != null);
        if (firstTimedLine) setActiveId(firstTimedLine.id);
        flash(`已匹配 ${sequentialMatch ? cues.length : strongMatches} 句时间轴${recognizedTargets ? `，识别 ${recognizedTargets} 句中文填词` : ''}`);
      } else {
        const parsed = await Promise.all(cues.map(async (cue, index) => {
          const recognized = recognizeSubtitleText(cue);
          const lyric = await parseLyricLine(recognized.source, index);
          const target = recognized.target ? targetTextToCells(recognized.target) : [];
          return {
            ...lyric,
            id: `srt-${Date.now()}-${index}`,
            start: cue.start,
            end: cue.end,
            target: target.length ? target : Array.from({ length: Math.max(1, baseCount(lyric.tokens)) }, () => ''),
          } satisfies LyricLine;
        }));
        setLines(parsed);
        setActiveId(parsed[0].id);
        setProjectTitle(file.name.replace(/\.(srt|str|lrc)$/i, '') || '字幕翻填工程');
        flash(`已从 ${formatLabel} 新建 ${parsed.length} 句歌词工程`);
      }

      setSubtitleName(file.name);
      setSelectedCell(0);
      setLooping(false);
      setFollowLyrics(true);
    } catch (error) {
      console.error(error);
      flash('歌词时间轴分析失败，请检查文件内容');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleSvp = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';
    if (file.size > 20 * 1024 * 1024) {
      flash('这个 SVP 太大了，请先精简到 20MB 以内');
      return;
    }
    try {
      const project = parseSvpProject(await file.text());
      const defaultTrack = project.tracks.reduce((best, track) => track.notes.length > best.notes.length ? track : best);
      setSvpImport({ fileName: file.name, project, trackId: defaultTrack.id, maximumSyllables: 18 });
      setImportOpen(false);
    } catch (error) {
      console.error(error);
      flash(error instanceof Error ? error.message : 'SVP 工程读取失败');
    }
  };

  const confirmSvpImport = async () => {
    if (!svpImport) return;
    setAnalyzing(true);
    try {
      const imported = await importSvpTrack(svpImport.project, svpImport.trackId, svpImport.maximumSyllables);
      const timestamp = Date.now();
      const nextLines: LyricLine[] = imported.map((line, index) => ({
        ...line,
        id: `svp-${timestamp}-${index}`,
      }));
      setLines(nextLines);
      setActiveId(nextLines[0].id);
      setProjectTitle(svpImport.fileName.replace(/\.svp$/i, '') || 'SVP 翻填工程');
      setSelectedCell(0);
      setSubtitleName('');
      setLooping(false);
      setFollowLyrics(true);
      setSvpImport(null);
      flash(`已从 SVP 拆出 ${nextLines.length} 句，原工程没有改动`);
    } catch (error) {
      console.error(error);
      flash(error instanceof Error ? error.message : 'SVP 轨道分析失败');
    } finally {
      setAnalyzing(false);
    }
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
    if (followLyrics && !looping) {
      const nextLine = lines.find((line) => line.start != null
        && audio.currentTime >= line.start
        && (line.end == null || audio.currentTime < line.end));
      if (nextLine && nextLine.id !== activeId) {
        setActiveId(nextLine.id);
        setSelectedCell(0);
      }
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

  const handleBackground = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';
    try {
      const backgroundImage = await compressBackground(file);
      setTheme((current) => ({ ...current, backgroundImage, backgroundName: file.name }));
      flash('背景只保存在这台设备');
    } catch (error) {
      flash(error instanceof Error ? error.message : '背景图片读取失败');
    }
  };

  const applyThemePreset = (accent: string, background: string, panel: string) => {
    setTheme((current) => ({ ...current, accent, background, panel }));
  };

  const runAiAssistant = async () => {
    if (!aiKey.trim()) {
      flash('先填入自己的智谱 API Key');
      return;
    }
    setAiLoading(true);
    setAiResult('');
    try {
      const selectedLines = aiScope === 'all' ? lines : [activeLine];
      const response = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: aiKey,
          endpoint: aiConfig.endpoint,
          model: aiConfig.model,
          task: aiTask,
          scope: aiScope,
          projectTitle,
          focus: aiFocus,
          lyrics: selectedLines.map((line) => {
            const rhyme = lineRhymes.get(line.id);
            return {
              index: lines.findIndex((candidate) => candidate.id === line.id) + 1,
              source: line.source,
              pronunciation: line.tokens.map((item) => item.label).join(' '),
              target: line.target.filter((cell) => cell !== '—').join(''),
              rhyme: rhyme?.final ?? '',
            };
          }),
        }),
      });
      const result = await response.json() as { content?: string; error?: string };
      if (!response.ok || !result.content) throw new Error(result.error || 'AI 暂时没有返回结果');
      setAiResult(result.content);
    } catch (error) {
      setAiResult(`没有完成分析：${error instanceof Error ? error.message : '请检查接口配置'}`);
    } finally {
      setAiLoading(false);
    }
  };

  const copyAiResult = async () => {
    if (!aiResult) return;
    await navigator.clipboard.writeText(aiResult);
    flash('AI 建议已复制，不会写进词格');
  };

  const pronunciationLabel = useMemo(
    () => activeLine?.tokens.map((item) => item.label).join(' ') ?? '',
    [activeLine],
  );

  if (!activeLine) return null;

  return (
    <main className="app-shell" style={themeStyle}>
      <input ref={svpRef} type="file" accept=".svp,application/json" onChange={handleSvp} hidden />
      <input ref={backgroundRef} type="file" accept="image/*" onChange={handleBackground} hidden />
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
          <button className="help-button" onClick={openTutorial} aria-label="打开新手教程"><span>？</span><b>新手教程</b></button>
          <button className="button button-quiet" onClick={() => setPreviewOpen(true)}>全局预览</button>
          <button className="button button-ai" onClick={() => setAiOpen(true)}>✦ AI 参谋</button>
          <button className="button button-quiet" onClick={() => setAppearanceOpen(true)}>外观</button>
          <button className="button button-quiet" onClick={() => svpRef.current?.click()}>导入 SVP β</button>
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
              const rhyme = lineRhymes.get(line.id);
              return (
                <button
                  className={`line-item ${line.id === activeId ? 'active' : ''}`}
                  key={line.id}
                  ref={(element) => {
                    if (element) lineButtonRefs.current.set(line.id, element);
                    else lineButtonRefs.current.delete(line.id);
                  }}
                  onClick={() => { setActiveId(line.id); setSelectedCell(0); }}
                >
                  <span className="line-index">{String(index + 1).padStart(2, '0')}</span>
                  <span className="line-copy"><span lang="ja">{line.source}</span><small>{line.id === activeId ? '正在编辑' : filled ? '已有填词' : '尚未填写'}{rhyme?.final && <em> · {rhyme.final} 韵</em>}</small></span>
                  <span className="line-count">{count}<small>字</small></span>
                </button>
              );
            })}
          </div>
          <button className="copy-all" onClick={copyLyrics}>复制整首中文歌词</button>
          <div className="local-note"><span className="lock-icon">●</span><p><strong>仅保存在这台设备</strong><br />歌词和音频不会上传。</p></div>
        </aside>

        <section className="editor-panel" ref={editorPanelRef}>
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
              <div><span className="step-number">01</span><h2>实际唱法</h2><p>连读自动合格；“可连”位置可点一下确认</p></div>
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
                  <button className={`phoneme-token ${item.kind} ${item.linkCandidate ? 'link-candidate' : ''} ${!item.counted ? 'not-counted' : ''}`} key={item.id} onClick={() => toggleToken(item.id)} title={item.kind === 'linked' ? '两个音连读为一个中文格；点击拆回两格' : item.linkCandidate ? '这里可能发生元音连读；点击与前一音合成一格' : item.counted ? '计入基础字数；点击改为可吸收' : '不计入基础字数；点击改为普通发音'}>
                    <span>{item.label}</span>
                    {!item.counted && <small>吸收</small>}
                    {item.kind === 'long' && item.counted && <small>长音</small>}
                    {item.kind === 'linked' && <small>连读</small>}
                    {item.linkCandidate && <small>可连</small>}
                    {item.kind === 'uncertain' && <small>待确认</small>}
                  </button>
                ))}
              </div>
            )}

            {activeLine.svp && (
              <div className="svp-note-panel">
                <div className="svp-note-heading">
                  <span><b>SVP 音符</b> · {activeLine.svp.trackName}</span>
                  <small>v{activeLine.svp.version} · {formatTime(activeLine.start ?? 0)}–{formatTime(activeLine.end ?? 0)}</small>
                </div>
                <div className="svp-note-scroll" aria-label="SVP 音符时间线">
                  <div className="svp-note-flow">
                    {activeLine.svp.notes.map((note) => {
                      const width = Math.max(42, Math.min(112, note.durationSeconds * 92));
                      const pitchOffset = Math.min(44, (activeSvpPitchRange.maximum - note.pitch) * 2.2);
                      return (
                        <div
                          className={`svp-note ${note.role}`}
                          key={note.id}
                          style={{ width: `${width}px`, marginTop: `${pitchOffset}px` }}
                          title={`${note.lyric} · MIDI ${note.pitch} · ${Math.round(note.durationSeconds * 1000)}ms`}
                        >
                          <b>{note.role === 'hold' ? '—' : note.lyric}</b>
                          <small>{note.role === 'hold' ? '续音' : note.role === 'syllable' ? '拆音' : `${Math.round(note.durationSeconds * 1000)}ms`}</small>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            <div className="analysis-note"><span className="analysis-spark">✦</span>{activeLine.uncertain ? '英文先按标准发音估算；如果原唱采用日式或特殊唱法，请点“编辑唱法”按听到的结果修改。' : `当前唱法为 ${pronunciationLabel}；“+”表示两个音连读占一个中文格，点击可拆开。`}</div>
          </section>

          <section className="editor-section target-section">
            <div className="section-title-row">
              <div><span className="step-number">02</span><h2>中文填词</h2><p>填字后显示拼音；句尾自动标出韵脚</p></div>
              <div className="mini-toolbar" aria-label="编辑工具">
                <button onClick={mergeCell}>合并为延音</button>
                <button onClick={splitCell}>拆一格</button>
                <button className="active" onClick={addSustain}>＋ 延音</button>
                <button onClick={removeCell}>删除格</button>
              </div>
            </div>

            <div className="lyric-grid" aria-label="中文逐格编辑器">
              {activeLine.target.map((cell, index) => (
                <label className={`lyric-cell ${cell === '—' ? 'sustain' : ''} ${chinesePronunciation.cells[index]?.rhyme ? 'rhyme' : ''} ${selectedCell === index ? 'selected' : ''}`} key={`${activeLine.id}-${index}`} onClick={() => setSelectedCell(index)}>
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
                  {chinesePronunciation.cells[index] && <small className="cell-pinyin">{chinesePronunciation.cells[index]?.syllable}</small>}
                </label>
              ))}
              <button className="add-cell" aria-label="添加一格" onClick={splitCell}>＋</button>
            </div>

            <div className="change-ledger">
              <div><span className={delta < 0 ? 'minus' : 'neutral'}>{delta < 0 ? delta : '—'}</span><p><strong>延音与合并</strong><small>少起一个中文读音</small></p></div>
              <div><span className={delta > 0 ? 'plus' : 'neutral'}>{delta > 0 ? `＋${delta}` : '—'}</span><p><strong>拆音设计</strong><small>在长音里增加落字</small></p></div>
              {chinesePronunciation.rhyme && <span className="rhyme-badge">韵脚 <b>{chinesePronunciation.rhyme.character}</b> · {chinesePronunciation.rhyme.syllable} · <strong>{chinesePronunciation.rhyme.final} 韵</strong></span>}
              <span className={`balanced ${delta !== 0 ? 'shifted' : ''}`}>{delta === 0 ? '当前与基础建议持平' : delta > 0 ? `当前比建议多 ${delta} 字` : `当前比建议少 ${Math.abs(delta)} 字`}</span>
            </div>
          </section>
        </section>

        <aside className="listen-panel">
          <div className="listen-heading"><span className="eyebrow">听感校对</span><h2>这一句怎么唱</h2></div>
          <div className="audio-card">
            <input ref={fileRef} type="file" accept="audio/*" onChange={handleAudio} hidden />
            <input ref={subtitleRef} type="file" accept=".srt,.str,.lrc,application/x-subrip,text/plain" onChange={handleSubtitle} hidden />
            <audio ref={audioRef} src={audioUrl || undefined} onLoadedMetadata={(event) => { setDuration(event.currentTarget.duration); event.currentTarget.playbackRate = rate; }} onTimeUpdate={handleTimeUpdate} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
            <div className="waveform" aria-hidden="true">{Array.from({ length: 38 }, (_, index) => <i key={index} style={{ height: `${18 + ((index * 17) % 54)}%` }} />)}</div>
            <input className="audio-slider" type="range" min="0" max={duration || 1} step="0.01" value={Math.min(currentTime, duration || 1)} onChange={(event) => { const value = Number(event.target.value); setCurrentTime(value); if (audioRef.current) audioRef.current.currentTime = value; }} aria-label="音频进度" />
            <div className="audio-time"><span>{formatTime(currentTime)}</span><span>{formatTime(duration)}</span></div>
            <div className="transport"><button className="speed-button" onClick={cycleRate}>{rate}×</button><button className="play-button" aria-label={playing ? '暂停' : '播放'} onClick={togglePlay}>{playing ? 'Ⅱ' : '▶'}</button><button className={`loop-button ${looping ? 'on' : ''}`} onClick={() => { setLooping((value) => !value); setFollowLyrics(false); }}>↻ 循环</button></div>
            {audioName ? <p className="audio-name" title={audioName}>{audioName}</p> : <button className="upload-audio" onClick={() => fileRef.current?.click()}>上传歌曲音频</button>}
            <div className="subtitle-actions">
              <button disabled={analyzing} onClick={() => subtitleRef.current?.click()}>{analyzing ? '识别中…' : '导入 SRT / LRC'}</button>
              <button className={followLyrics ? 'on' : ''} onClick={() => { setFollowLyrics((value) => !value); setLooping(false); }}>↕ {followLyrics ? '正在跟随' : '跟随歌词'}</button>
            </div>
            {subtitleName && <p className="subtitle-name" title={subtitleName}>时间轴 · {subtitleName}</p>}
            <div className="marker-actions"><button onClick={() => setMarker('start')}>设为句首</button><button onClick={() => setMarker('end')}>设为句尾</button></div>
            <div className="marker-time"><span>A {formatTime(activeLine.start ?? 0)}</span><span>B {activeLine.end != null ? formatTime(activeLine.end) : '未设置'}</span></div>
          </div>
          <div className="legend-card"><h3>格子说明</h3><p><span className="legend-dot normal" />普通发音 <small>建议填一字</small></p><p><span className="legend-dot candidate" />连读候选 <small>点一下与前音合并</small></p><p><span className="legend-dot linked" />连读 <small>两个音合占一字，可拆</small></p><p><span className="legend-dot long" />长音 <small>默认一字，可拆</small></p><p><span className="legend-dot absorbed" />可吸收 <small>默认不添字</small></p></div>
          <div className="tip-card"><span>提示</span><p>基础建议不是硬性答案。只要唱起来顺，你可以把延音移动到任何位置。</p></div>
          <div className="creator-credit"><span>策划与制作</span><strong>北艾sama</strong></div>
        </aside>
      </div>

      {previewOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewOpen(false); }}>
          <section className="preview-modal" role="dialog" aria-modal="true" aria-labelledby="preview-title">
            <button className="modal-close" aria-label="关闭全局预览" onClick={() => setPreviewOpen(false)}>×</button>
            <div className="preview-header">
              <div><span className="eyebrow">整首翻填总览</span><h2 id="preview-title">{projectTitle}</h2><p>从头看到尾，检查字数、句尾和整体押韵。</p></div>
              <div className="preview-stats"><span><b>{lines.length}</b> 句</span><span><b>{previewStats.completed}</b> 已填</span><span><b>{lines.length - previewStats.completed}</b> 待填</span></div>
            </div>
            <div className="preview-toolbar">
              <label><input type="checkbox" checked={previewShowPronunciation} onChange={(event) => setPreviewShowPronunciation(event.target.checked)} /> 显示发音与拼音</label>
              <div className="preview-rhymes">
                <span>常用韵脚</span>
                {previewStats.commonRhymes.length
                  ? previewStats.commonRhymes.map(([rhyme, count]) => <b key={rhyme}>{rhyme} · {count}</b>)
                  : <small>填几句中文后自动汇总</small>}
              </div>
              <button onClick={copyLyrics}>复制中文歌词</button>
            </div>
            <div className="preview-list">
              {lines.map((line, index) => {
                const chinese = analyzeChineseCells(line.target);
                const target = line.target.map((cell) => cell || '□').join('');
                const hasDraft = line.target.some((cell) => cell.trim() && cell !== '—');
                return (
                  <button className={`preview-line ${line.id === activeId ? 'active' : ''}`} key={line.id} onClick={() => { setActiveId(line.id); setSelectedCell(0); setPreviewOpen(false); }}>
                    <span className="preview-line-index">{String(index + 1).padStart(2, '0')}</span>
                    <span className="preview-line-body">
                      <span className="preview-source" lang="ja">{line.source}</span>
                      {previewShowPronunciation && <small className="preview-pronunciation">{line.tokens.map((item) => item.label).join(' ')}</small>}
                      <strong className={hasDraft ? '' : 'empty'}>{target}</strong>
                      {previewShowPronunciation && hasDraft && <small className="preview-pinyin">{chinese.cells.map((cell) => cell?.syllable ?? '·').join(' ')}</small>}
                    </span>
                    <span className="preview-line-meta">
                      {line.start != null && <small>{formatTime(line.start)}</small>}
                      <b>{baseCount(line.tokens)} 字</b>
                      {chinese.rhyme?.final && <em>{chinese.rhyme.final} 韵</em>}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {appearanceOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAppearanceOpen(false); }}>
          <section className="appearance-modal" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
            <button className="modal-close" aria-label="关闭外观设置" onClick={() => setAppearanceOpen(false)}>×</button>
            <span className="eyebrow">只装饰你的工作台</span>
            <h2 id="appearance-title">自定义配色与背景</h2>
            <p>颜色和图片仅保存在这台设备，不会上传。</p>

            <div className="theme-presets" aria-label="主题预设">
              <button className="theme-preset lime" onClick={() => applyThemePreset('#c8f36b', '#0d1214', '#151b1d')}><i /><span>酸橙夜</span></button>
              <button className="theme-preset sakura" onClick={() => applyThemePreset('#ff91bb', '#130f15', '#1c161f')}><i /><span>樱花黑</span></button>
              <button className="theme-preset ocean" onClick={() => applyThemePreset('#66e2dc', '#091315', '#101d20')}><i /><span>深海青</span></button>
              <button className="theme-preset violet" onClick={() => applyThemePreset('#b99cff', '#100e17', '#191624')}><i /><span>夜紫</span></button>
            </div>

            <div className="color-controls">
              <label><span>强调色</span><input type="color" value={theme.accent} onChange={(event) => setTheme((current) => ({ ...current, accent: event.target.value }))} /><code>{theme.accent}</code></label>
              <label><span>底色</span><input type="color" value={theme.background} onChange={(event) => setTheme((current) => ({ ...current, background: event.target.value }))} /><code>{theme.background}</code></label>
              <label><span>卡片色</span><input type="color" value={theme.panel} onChange={(event) => setTheme((current) => ({ ...current, panel: event.target.value }))} /><code>{theme.panel}</code></label>
            </div>

            <div className="background-setting">
              <div className="background-preview" style={{ backgroundImage: theme.backgroundImage ? `url(${JSON.stringify(theme.backgroundImage)})` : undefined }}><span>{theme.backgroundImage ? '当前背景' : '还没有背景图'}</span></div>
              <div>
                <strong>自定义背景图片</strong>
                <small>{theme.backgroundName || '支持常见图片格式，自动压缩后保存在浏览器'}</small>
                <span><button onClick={() => backgroundRef.current?.click()}>选择图片</button>{theme.backgroundImage && <button className="quiet" onClick={() => setTheme((current) => ({ ...current, backgroundImage: '', backgroundName: '' }))}>移除</button>}</span>
              </div>
            </div>
            <label className="opacity-control"><span>背景可见度 <b>{Math.round(theme.backgroundOpacity * 100)}%</b></span><input type="range" min="0.05" max="0.65" step="0.05" value={theme.backgroundOpacity} onChange={(event) => setTheme((current) => ({ ...current, backgroundOpacity: Number(event.target.value) }))} /></label>
            <div className="modal-actions"><button onClick={() => setTheme(defaultTheme)}>恢复默认</button><button className="analyze-button" onClick={() => setAppearanceOpen(false)}>应用外观</button></div>
          </section>
        </div>
      )}

      {aiOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="ai-modal" role="dialog" aria-modal="true" aria-labelledby="ai-title">
            <button className="modal-close" aria-label="关闭 AI 参谋" onClick={() => setAiOpen(false)}>×</button>
            <div className="ai-heading"><span className="ai-mark">✦</span><div><span className="eyebrow">GLM-4.7 创作研究助手</span><h2 id="ai-title">给你线索，不替你写</h2><p>可以直译、找韵脚、分析意象和音乐背景；结果不会自动进入中文词格。</p></div></div>

            <div className="ai-layout">
              <div className="ai-controls">
                <div className="ai-task-list">
                  {(Object.entries(aiTaskLabels) as Array<[AiTask, { title: string; note: string }]>).map(([task, copy]) => (
                    <button className={aiTask === task ? 'selected' : ''} key={task} onClick={() => { setAiTask(task); setAiResult(''); }}><b>{copy.title}</b><small>{copy.note}</small></button>
                  ))}
                </div>
                <div className="ai-scope"><span>分析范围</span><button className={aiScope === 'current' ? 'selected' : ''} onClick={() => setAiScope('current')}>当前第 {activeIndex + 1} 句</button><button className={aiScope === 'all' ? 'selected' : ''} onClick={() => setAiScope('all')}>整首 {lines.length} 句</button></div>
                <label className="ai-focus"><span>特别想了解什么？<small>可不填</small></span><textarea value={aiFocus} onChange={(event) => setAiFocus(event.target.value)} placeholder="例如：这句的主语是谁？有没有宗教隐喻？" /></label>
              </div>

              <div className="ai-output">
                {aiResult ? <pre>{aiResult}</pre> : <div className="ai-empty"><span>✦</span><b>{aiTaskLabels[aiTask].title}</b><p>{aiTaskLabels[aiTask].note}。AI 不会提供可直接粘进格子的中文歌词。</p></div>}
                {aiResult && <button className="copy-ai" onClick={copyAiResult}>复制这份建议</button>}
              </div>
            </div>

            <details className="ai-config" open={!aiKey}>
              <summary>配置自己的智谱接口</summary>
              <div>
                <label><span>API Key</span><input type="password" value={aiKey} onChange={(event) => setAiKey(event.target.value)} placeholder="只在当前页面内存中使用" autoComplete="off" /></label>
                <label><span>模型</span><select value={aiConfig.model} onChange={(event) => setAiConfig((current) => ({ ...current, model: event.target.value }))}><option value="glm-4.7-flash">glm-4.7-flash（免费）</option><option value="glm-4.7-flashx">glm-4.7-flashx</option><option value="glm-4.7">glm-4.7</option></select></label>
                <label className="ai-endpoint"><span>官方接口地址</span><input value={aiConfig.endpoint} onChange={(event) => setAiConfig((current) => ({ ...current, endpoint: event.target.value }))} /></label>
              </div>
              <p>Key 不会写入本机存储，刷新页面后需要重新填写；目前仅连接智谱官方域名。</p>
            </details>
            <div className="ai-footer"><span>护栏：禁止逐格代写、成品歌词和假装听过本机音频</span><button disabled={aiLoading} onClick={runAiAssistant}>{aiLoading ? 'GLM 正在整理线索…' : `开始${aiTaskLabels[aiTask].title} →`}</button></div>
          </section>
        </div>
      )}

      {importOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !analyzing) setImportOpen(false); }}>
          <section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
            <button className="modal-close" aria-label="关闭" onClick={() => setImportOpen(false)}>×</button>
            <span className="eyebrow">新建歌词工程</span>
            <h2 id="import-title">把原歌词粘贴进来</h2>
            <p>每一行会作为一句。支持日语、英语和日英混合歌词。</p>
            <textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={'どうして どうして 私だけ\n乾燥し切った眼でlove-la-villain'} autoFocus />
            <div className="modal-help"><span>日语</span> 自动生成假名和分格罗马音 <span>英语</span> 自动生成 IPA，可按原唱修改</div>
            <button className="svp-import-shortcut" onClick={() => svpRef.current?.click()}>已有 SynthV 工程？导入 SVP β</button>
            <div className="modal-actions"><button onClick={() => setImportOpen(false)}>取消</button><button className="analyze-button" disabled={!importText.trim() || analyzing} onClick={analyzeLyrics}>{analyzing ? '正在加载发音辞典…' : '分析歌词 →'}</button></div>
          </section>
        </div>
      )}

      {svpImport && (
        <div className="modal-backdrop" role="presentation">
          <section className="svp-import-modal" role="dialog" aria-modal="true" aria-labelledby="svp-import-title">
            <button className="modal-close" aria-label="取消导入 SVP" onClick={() => setSvpImport(null)}>×</button>
            <span className="eyebrow">实验性 SVP 导入</span>
            <h2 id="svp-import-title">选择要翻填的歌唱轨道</h2>
            <p>{svpImport.fileName} · SVP v{svpImport.project.version} · 原文件只读</p>

            <div className="svp-track-list">
              {svpImport.project.tracks.map((track) => (
                <button className={track.id === svpImport.trackId ? 'selected' : ''} key={track.id} onClick={() => setSvpImport((current) => current ? { ...current, trackId: track.id } : current)}>
                  <span><b>{track.name}</b><small>{track.detectedLanguage === 'zh' ? '检测到中文' : track.detectedLanguage === 'ja' ? '检测到日语' : track.detectedLanguage === 'latin' ? '罗马音/英语' : track.language === 'japanese' ? '日语轨道' : '混合歌词'}</small></span>
                  <span><strong>{track.notes.length}</strong><small>音符 · {formatTime(track.durationSeconds)}</small></span>
                </button>
              ))}
            </div>

            <div className="svp-phrase-setting">
              <span><b>自动分句长度</b><small>句子太碎或太长时，可以换一档</small></span>
              <div>{[12, 18, 24].map((value) => <button className={svpImport.maximumSyllables === value ? 'selected' : ''} key={value} onClick={() => setSvpImport((current) => current ? { ...current, maximumSyllables: value } : current)}>{value === 12 ? '短句' : value === 18 ? '常规' : '长句'}</button>)}</div>
            </div>

            <div className="svp-import-note">会读取歌词、音高、时值、休止与音符组；歌曲音频仍需单独上传。</div>
            <div className="modal-actions"><button onClick={() => setSvpImport(null)}>取消</button><button className="analyze-button" disabled={analyzing} onClick={confirmSvpImport}>{analyzing ? '正在拆分音符…' : '导入所选轨道 →'}</button></div>
          </section>
        </div>
      )}

      {tutorialOpen && (
        <div className="modal-backdrop tutorial-backdrop" role="presentation">
          <section className="tutorial-modal" role="dialog" aria-modal="true" aria-labelledby="tutorial-title">
            <span className="tutorial-kicker">第一次来？别慌</span>
            <h2 id="tutorial-title">一分钟学会词格</h2>
            <p className="tutorial-lead">只记住一句：<strong>上面一个发音格，下面通常填一个中文字。</strong></p>

            <div className="tutorial-demo" aria-label="一个连读发音格对应一个中文字">
              <span className="tutorial-sound"><b>na+i</b><small>连读一格</small></span>
              <span className="tutorial-arrow">→</span>
              <span className="tutorial-character">你</span>
            </div>

            <ol className="tutorial-steps">
              <li><span>1</span><p><strong>导入你的材料</strong><small>可以粘贴歌词，也可以导入 SVP、SRT 或 LRC，罗马音会自动出来。</small></p></li>
              <li><span>2</span><p><strong>先看上面的发音格</strong><small>普通格填一字；灰色“吸收”不用填；“可连”听着连起来就点它。</small></p></li>
              <li><span>3</span><p><strong>再填下面的中文格</strong><small>可以整句粘贴。格子下方会显示拼音，句尾会告诉你是什么韵。</small></p></li>
              <li><span>4</span><p><strong>最后跟着歌听一遍</strong><small>上传歌曲和 SRT/LRC，打开“跟随歌词”，词格会自己翻到当前句。</small></p></li>
              <li><span>5</span><p><strong>从全局看看整首歌</strong><small>“全局预览”检查整首押韵；“AI 参谋”只帮你查意思和找灵感，不会替你填格子。</small></p></li>
            </ol>

            <div className="tutorial-footer">
              <label><input type="checkbox" checked={hideTutorialNextTime} onChange={(event) => setHideTutorialNextTime(event.target.checked)} /> 下次打开不再自动显示</label>
              <button onClick={closeTutorial}>我会啦，开始填词 →</button>
            </div>
          </section>
        </div>
      )}

      {notice && <div className="toast" role="status">{notice}</div>}
    </main>
  );
}
