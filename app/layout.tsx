import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '词格 · 中文翻填助手',
  description: '把日语与英语歌词拆成实际唱法格，辅助完成自然、顺口的中文填词。',
  openGraph: {
    title: '词格 · 中文翻填助手',
    description: '听懂原唱，填进中文。把日语与英语歌词拆成实际唱法格。',
    siteName: '词格',
    locale: 'zh_CN',
    type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: '词格 · 中文翻填助手' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '词格 · 中文翻填助手',
    description: '听懂原唱，填进中文。',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
