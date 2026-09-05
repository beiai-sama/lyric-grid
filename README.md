# 词格 · 中文翻填助手

由北艾sama策划制作的中文翻填工作台。支持歌词与音符工程导入、逐格编辑、延音与吸收、拼音韵脚检查、音频与字幕跟随，以及辅助理解歌词的 AI 参谋。

## 本地运行

需要 Node.js 22.13 或更新版本及 npm。

```sh
npm ci
npm run dev
```

以终端显示的本地地址为准。生产构建使用 `npm run build`。

## 源码位置

- `app/page.tsx`：主要工作台和交互。
- `app/globals.css`：全局样式、配色和外观。
- `app/lab.tsx`：实验室。
- `lib/`：发音、拼音、字幕、SVP、MIDI、VOCALOID 工程处理及导出。
- `app/api/ai/route.ts`：AI 请求接口。
- `public/dict/`：日文分词所需词典资源。

## 上传与部署说明

本仓库保存项目源码、运行资源、依赖锁文件和 Git 历史。歌曲音频、用户提供的工程样本、浏览器中的填词工程、个人 AI 密钥及本机缓存不在此仓库中。浏览器里的工程请通过词格的导出功能另行备份。

当前项目使用 Vinext、Cloudflare Workers 和 Sites。`.openai/hosting.json` 保留原站点关联信息；它不是密钥。上传 GitHub 不会自动部署网站，也不会修复原托管平台的访问拦截。GitHub Pages 不能直接运行本项目的服务端接口。迁移到其他托管平台时，需要适配构建、运行环境和接口。

使用文档是独立项目：`https://github.com/beiai-sama/lyric-grid-docs`。
