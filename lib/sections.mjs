// 章节工作台的确定性基础：从正文里读出章节边界，并支持只改某一章的正文。
// 不解析整棵 DOM，只按标题标签定界，因此对粘贴进来的 div 包裹同样成立；
// 所有替换都是原文切片，不重建 HTML，未涉及的章节一个字符都不会动。

import { blockText, canonicalHeading, countWords, sourceCitation } from './html-blocks.mjs';

const HEADING = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;

function readHeadings(html) {
  const source = String(html ?? '');
  const headings = [];
  for (const match of source.matchAll(HEADING)) {
    const text = blockText(match[2]);
    if (!text) continue;
    headings.push({
      level: Number(match[1]),
      title: text,
      canonical: canonicalHeading(text) || text,
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return headings;
}

// 章节层级的选择规则：有多个一级标题就用一级；只有一个一级标题时，它更像是文档标题，
// 改用二级；再退到三级。这样“一、项目背景”式的中文报告和“# 标题 + ## 章节”都能对。
function chapterLevel(headings) {
  const counts = new Map();
  for (const heading of headings) counts.set(heading.level, (counts.get(heading.level) || 0) + 1);
  if ((counts.get(1) || 0) >= 2) return 1;
  for (const level of [2, 3, 4, 5, 6]) if (counts.get(level)) return level;
  return 1;
}

export function sectionMap(html) {
  const source = String(html ?? '');
  const headings = readHeadings(source);
  const words = countWords(source);
  if (!headings.length) return { level: 0, total: 0, words, sections: [] };
  const level = chapterLevel(headings);
  const chapters = headings.filter(heading => heading.level === level);
  const seen = new Map();
  const sections = chapters.map((heading, index) => {
    const key = (() => {
      const count = (seen.get(heading.canonical) || 0) + 1;
      seen.set(heading.canonical, count);
      return `h${heading.level}:${heading.canonical}#${count}`;
    })();
    const next = chapters[index + 1];
    const bodyStart = heading.end;
    const bodyEnd = next ? next.start : source.length;
    const body = source.slice(bodyStart, bodyEnd);
    const bodyWords = countWords(body);
    return {
      key, index, level: heading.level, tag: `h${heading.level}`,
      title: heading.title, canonical: heading.canonical,
      start: heading.start, bodyStart, bodyEnd, end: bodyEnd,
      words: bodyWords,
      paragraphs: (body.match(/<p\b/gi) || []).length,
      tables: (body.match(/<table\b/gi) || []).length,
      lists: (body.match(/<(ul|ol)\b/gi) || []).length,
      citations: (body.match(sourceCitation) || []).length,
      placeholders: (body.match(/(待补充|待确认|待完善|待填写|TBD|TODO)/g) || []).length,
      subheadings: headings.filter(item => item.start > bodyStart && item.start < bodyEnd && item.level > level).length,
      empty: bodyWords === 0
    };
  });
  return { level, total: sections.length, words, sections };
}

export function findSection(map, key, title = '') {
  if (!map || !Array.isArray(map.sections)) return null;
  const byKey = map.sections.find(section => section.key === key);
  if (byKey) return byKey;
  // 标题被改过时任务仍能定位：退回按标题精确匹配，仍找不到就交给调用方报错，不静默错配。
  if (!title) return null;
  const canonical = canonicalHeading(title) || title;
  return map.sections.find(section => section.canonical === canonical) || null;
}

export function sectionBody(html, key, title = '') {
  const map = sectionMap(html);
  const section = findSection(map, key, title);
  if (!section) return null;
  return String(html).slice(section.bodyStart, section.bodyEnd);
}

export function replaceSectionBody(html, key, inner, title = '') {
  const source = String(html ?? '');
  const section = findSection(sectionMap(source), key, title);
  if (!section) return null;
  // 保留章节标题本身，只替换标题之后的正文；相邻章节的原始字节不受影响。
  return `${source.slice(0, section.bodyStart)}${inner}${source.slice(section.bodyEnd)}`;
}

export function removeSection(html, key, title = '') {
  const source = String(html ?? '');
  const section = findSection(sectionMap(source), key, title);
  if (!section) return null;
  return `${source.slice(0, section.start)}${source.slice(section.end)}`;
}

export function moveSection(html, key, delta, title = '') {
  const source = String(html ?? '');
  const map = sectionMap(source);
  const section = findSection(map, key, title);
  if (!section) return null;
  const target = map.sections[section.index + (delta > 0 ? 1 : -1)];
  if (!target) return null;
  const [first, second] = delta > 0 ? [section, target] : [target, section];
  // 相邻两章整体交换：[first 起, first 止) 与 [second 起, second 止) 首尾相接。
  return `${source.slice(0, first.start)}${source.slice(second.start, second.end)}${source.slice(first.start, first.end)}${source.slice(second.end)}`;
}

export function insertSection(html, { afterKey = '', afterTitle = '', title, body = '', level = 0 } = {}) {
  const source = String(html ?? '');
  const map = sectionMap(source);
  const heading = String(title || '').trim();
  if (!heading) throw new Error('章节标题不能为空。');
  const tag = Math.max(1, Math.min(6, level || map.level || 2));
  const block = `<h${tag}>${heading.replace(/[<>&]/g, value => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[value])}</h${tag}>${body}`;
  if (!map.sections.length) return `${source}${source && !source.endsWith('\n') ? '\n' : ''}${block}`;
  const anchor = afterKey ? findSection(map, afterKey, afterTitle) : null;
  if (afterKey && !anchor) return null;
  const position = anchor ? anchor.end : map.sections[map.sections.length - 1].end;
  return `${source.slice(0, position)}${block}${source.slice(position)}`;
}

export function sectionOutline(html, { max = 40 } = {}) {
  const map = sectionMap(html);
  return map.sections.slice(0, max).map((section, index) => `${index + 1}. ${section.title}（约 ${section.words} 字${section.empty ? '，尚未填写' : ''}）`).join('\n');
}

export function sectionStats(html) {
  const map = sectionMap(html);
  const filled = map.sections.filter(section => !section.empty).length;
  return {
    level: map.level,
    total: map.total,
    filled,
    empty: map.total - filled,
    words: map.words,
    averageWords: map.total ? Math.round(map.sections.reduce((sum, section) => sum + section.words, 0) / map.total) : 0
  };
}
