import { NextRequest, NextResponse } from 'next/server';

type AiTask = 'translate' | 'rhyme' | 'imagery' | 'music';

type AiRequest = {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  task?: AiTask;
  scope?: 'current' | 'all';
  projectTitle?: string;
  focus?: string;
  lyrics?: Array<{
    index: number;
    source: string;
    pronunciation: string;
    target: string;
    rhyme: string;
  }>;
};

const taskInstructions: Record<AiTask, string> = {
  translate: '逐句给出忠实的中文散文直译，标明歧义、主语省略和文化语境。明确说明这不是按音节或字数适配的填词。',
  rhyme: '分析原歌词的句尾听感和现有中文草稿的韵脚。推荐 2 至 4 组可选中文韵母，并且每组只给单个关键词素材，不得写成完整歌词句。',
  imagery: '梳理叙事视角、核心意象、潜在隐喻和可延展的画面方向。可以给单个关键词和概念，但不得给成品歌词句。',
  music: '只根据歌词文本推测歌曲场景、情绪曲线、力度变化、演唱口吻和可能的编曲氛围。明确标注这是文本推测，没有分析用户本机音频。',
};

function completionUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.hostname !== 'open.bigmodel.cn') {
    throw new Error('目前只允许连接智谱官方 HTTPS 接口');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/chat/completions')) url.pathname = `${path}/chat/completions`;
  return url.toString();
}

export async function POST(request: NextRequest) {
  let body: AiRequest;
  try {
    body = await request.json() as AiRequest;
  } catch {
    return NextResponse.json({ error: '请求内容无法读取' }, { status: 400 });
  }

  const apiKey = body.apiKey?.trim();
  const model = body.model?.trim().toLowerCase();
  const task = body.task;
  const lyrics = body.lyrics?.slice(0, 160) ?? [];
  const focus = body.focus?.trim().slice(0, 500) ?? '';

  if (!apiKey) return NextResponse.json({ error: '请先填写自己的智谱 API Key' }, { status: 400 });
  if (!task || !taskInstructions[task]) return NextResponse.json({ error: '请选择一种分析方式' }, { status: 400 });
  if (!lyrics.length) return NextResponse.json({ error: '没有可以分析的歌词' }, { status: 400 });
  if (!model || !/^glm-4\.7(?:-flashx?)?$/.test(model)) {
    return NextResponse.json({ error: '模型仅支持 GLM-4.7、GLM-4.7-Flash 或 GLM-4.7-FlashX' }, { status: 400 });
  }
  if (/(写|生成|代写|填满|逐格|对齐).{0,10}(歌词|填词|中文)|(歌词|填词).{0,10}(写|生成|代写|成品)/u.test(focus)) {
    return NextResponse.json({ error: 'AI 参谋不能代写中文填词，请改成询问语义、韵脚、意象或音乐背景' }, { status: 400 });
  }

  let endpoint: string;
  try {
    endpoint = completionUrl(body.endpoint || 'https://open.bigmodel.cn/api/paas/v4');
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '接口地址无效' }, { status: 400 });
  }

  const lyricContext = lyrics.map((line) => [
    `${String(line.index).padStart(2, '0')}. 原文：${line.source}`,
    line.pronunciation ? `   发音：${line.pronunciation}` : '',
    line.target ? `   中文草稿：${line.target}${line.rhyme ? `（${line.rhyme} 韵）` : ''}` : '   中文草稿：未填写',
  ].filter(Boolean).join('\n')).join('\n');

  const system = [
    '你是“词格”的中文翻填前期研究助手。你的工作是帮助用户理解和构思，不是替用户写歌词。',
    '绝对禁止：创作、续写或改写任何可直接唱用的中文歌词；按字数、音节或词格给出适配句；给出候选成品歌词；假装已经听过用户本机音频。',
    '允许：忠实的散文直译；语义和文化说明；韵母方向；单个关键词素材；意象、隐喻、叙事和音乐氛围建议。',
    '如果用户要求代写，简短拒绝后把问题改写成可提供的研究建议。回答使用简洁中文，以小标题和要点组织，不要使用 Markdown 表格。',
  ].join('\n');

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              `工程：${body.projectTitle || '未命名翻填工程'}`,
              `范围：${body.scope === 'all' ? '整首歌词' : '当前句'}`,
              `本次任务：${taskInstructions[task]}`,
              focus ? `用户特别想了解：${focus}` : '',
              '',
              lyricContext,
            ].filter(Boolean).join('\n'),
          },
        ],
        thinking: { type: 'disabled' },
        temperature: 0.45,
        max_tokens: 2400,
        stream: false,
      }),
    });

    const raw = await response.text();
    let result: { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } } = {};
    try {
      result = JSON.parse(raw) as typeof result;
    } catch {
      // The upstream response may be plain text when its gateway rejects a request.
    }
    if (!response.ok) {
      return NextResponse.json({ error: result.error?.message || `智谱接口返回 ${response.status}` }, { status: response.status >= 500 ? 502 : 400 });
    }
    const content = result.choices?.[0]?.message?.content?.trim();
    if (!content) return NextResponse.json({ error: '模型没有返回可显示的建议' }, { status: 502 });
    return NextResponse.json({ content, model });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '无法连接智谱接口' }, { status: 502 });
  }
}
