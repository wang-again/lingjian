// 编辑器正文的结构化读取：只按块级元素解释 HTML，不引入 DOM 依赖。
// 模板提炼、证据台账和交付体检都基于这里的同一份块序列，避免三套解析各自漂移。

const ENTITY = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”', mdash: '—', hellip: '…' };

export function decodeEntities(value) {
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, code) => {
    if (code[0] === '#') {
      const point = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      if (!Number.isFinite(point) || point < 1 || point > 0x10ffff) return match;
      try { return String.fromCodePoint(point); } catch { return match; }
    }
    return ENTITY[code.toLowerCase()] ?? match;
  });
}

export function blockText(html) {
  return decodeEntities(String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(/<[^>]*>/g, ''))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

const tablePattern = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
const blockPattern = /<(h[1-6]|p|li|blockquote|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const cellPattern = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;

// 表格整体算一个块：单元格合并、行内空值仍能按原表格核对。
function readTables(html) {
  const tables = [];
  for (const match of html.matchAll(tablePattern)) {
    const rows = [...match[1].matchAll(rowPattern)].map(row => [...row[1].matchAll(cellPattern)].map(cell => blockText(cell[2])));
    tables.push({ index: match.index, rows: rows.filter(row => row.length) });
  }
  return tables;
}

export function parseBlocks(html, { limit = 5000 } = {}) {
  const source = String(html ?? '');
  const tables = readTables(source);
  // 用等长空格遮住表格，保证普通块的 match.index 与原文位置一致。
  const masked = source.replace(tablePattern, match => ' '.repeat(match.length));
  const blocks = [];
  for (const match of masked.matchAll(blockPattern)) {
    const text = blockText(match[2]);
    if (!text) continue;
    const tag = match[1].toLowerCase();
    blocks.push({ index: match.index, tag, level: /^h[1-6]$/.test(tag) ? Number(tag[1]) : 0, text });
    if (blocks.length >= limit) break;
  }
  for (const table of tables) {
    const text = table.rows.flat().filter(Boolean).join(' ');
    blocks.push({ index: table.index, tag: 'table', level: 0, text, rows: table.rows });
  }
  blocks.sort((a, b) => a.index - b.index);
  return blocks.slice(0, limit).map((block, order) => ({ ...block, blockIndex: order }));
}

export const sourceCitation = /[\[【]\s*(?:资料|source)\s*[：:]\s*([^\]】]{1,200}?)\s*[\]】]/gi;

export function splitSentences(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return [];
  return (value.match(/[^。！？；!?;\n]+[。！？；!?;]?/g) || [value])
    .map(item => item.trim())
    .filter(item => item.length >= 2);
}

export function plainText(html) {
  return parseBlocks(html).map(block => block.text).join('\n');
}

export function countWords(html) {
  return plainText(html).replace(/\s/g, '').length;
}

// 把标题里的“一、”“（二）”“第 3 章”等编号剥掉，用于跨范文合并同名章节。
export function canonicalHeading(value) {
  return String(value ?? '')
    .replace(/^[\s　]*(?:第[一二三四五六七八九十百千0-9]+[章节部分篇]|[（(]?[一二三四五六七八九十百千]+[）)、.．]|[0-9]+[、.．)）])\s*/u, '')
    .replace(/[：:]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const chineseDigits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
export function chineseNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 99) return String(value);
  if (number < 10) return chineseDigits[number];
  const tens = Math.floor(number / 10), ones = number % 10;
  return `${tens === 1 ? '' : chineseDigits[tens]}十${ones ? chineseDigits[ones] : ''}`;
}
