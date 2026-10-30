// 链接分享解析：B站 / 网易云 / 小红书 / QQ音乐 → 标题 + 简介 + 封面
// 只做解析，不碰聊天流程；后面再接进 agent 的 [[分享:url]] 指令。
import { logger } from './log.js';

const log = logger('share');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const SITES = [
  { re: /bilibili\.com|b23\.tv/i, name: 'B站' },
  { re: /music\.163\.com|163cn\.tv|y\.music\.163\.com/i, name: '网易云' },
  { re: /xiaohongshu\.com|xhslink\.com/i, name: '小红书' },
  { re: /y\.qq\.com|qq\.com\/nryqq/i, name: 'QQ音乐' },
  { re: /douyin\.com|iesdouyin\.com/i, name: '抖音' },
  { re: /weibo\.com|weibo\.cn/i, name: '微博' },
];

function siteOf(url) {
  for (const s of SITES) if (s.re.test(url)) return s.name;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function meta(html, prop) {
  const pats = [
    new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
  ];
  for (const p of pats) {
    const m = p.exec(html);
    if (m) return decode(m[1]).trim();
  }
  return '';
}

function decode(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * 解析一个分享链接。失败时也返回 site + url，不抛错。
 * @returns {Promise<{url:string, site:string, title:string, desc:string, cover:string, ok:boolean}>}
 */
export async function preview(url) {
  const site = siteOf(url);
  const out = { url, site, title: '', desc: '', cover: '', ok: false };
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return out;
    const html = (await res.text()).slice(0, 400000);
    out.title = meta(html, 'og:title') || (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [, ''])[1].trim();
    out.desc = meta(html, 'og:description') || meta(html, 'description');
    out.cover = meta(html, 'og:image');
    out.title = decode(out.title).replace(/\s*[-_|]\s*(哔哩哔哩|网易云音乐|小红书).*$/, '').slice(0, 80);
    out.desc = decode(out.desc).slice(0, 160);
    if (out.cover.startsWith('//')) out.cover = 'https:' + out.cover;
    out.ok = !!(out.title || out.cover);
    log.info(`解析 ${site}：${out.title || '(无标题)'}`);
  } catch (err) {
    log.warn('解析失败 ' + url + ': ' + err.message);
  }
  return out;
}

/** 拼成可以直接发到 QQ 的一段文字 */
export function format(p) {
  const head = p.site ? `【${p.site}】` : '';
  const title = p.title || p.url;
  const desc = p.desc && p.desc !== p.title ? `\n${p.desc}` : '';
  return `${head}${title}${desc}\n${p.url}`;
}
