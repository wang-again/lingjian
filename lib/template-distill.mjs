import { parseBlocks, canonicalHeading, chineseNumber } from './html-blocks.mjs';
import { UserError } from './providers.mjs';

// 从用户自己提供的范文里提炼“结构资产”：章节顺序、常用表格列、固定术语。
// 只做确定性抽取，不调用模型，也不复制范文正文；结果必须由用户确认后才保存。

const NOISE_SECTIONS = new Set(['来源与许可', '参考来源', '资料来源', '填写与检查', '版本说明', '附录', '致谢']);
const GENERIC_COLUMNS = new Set(['备注', '说明', '序号', '合计', '小计', '总计']);
const TERM_STOP = new Set(['API', 'PDF', 'DOCX', 'DOC', 'XLSX', 'XLS', 'PPTX', 'PPT', 'URL', 'HTTP', 'HTTPS', 'ID', 'OK', 'AI', 'CPU', 'GPU', 'MB', 'GB', 'KB', 'TBD', 'TODO']);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const ratio = (value, total) => total <= 1 ? 0 : value / (total - 1);

function analyzeSample(sample) {
  const blocks = parseBlocks(sample.html);
  const h2 = blocks.filter(block => block.tag === 'h2');
  const h3 = blocks.filter(block => block.tag === 'h3');
  const source = h2.length >= 2 ? h2 : h3.length >= 2 ? h3 : blocks.filter(block => block.tag === 'h4');
  const seen = new Set();
  const sections = [];
  for (const heading of source) {
    const canonical = canonicalHeading(heading.text);
    if (!canonical || NOISE_SECTIONS.has(canonical) || seen.has(canonical)) continue;
    seen.add(canonical);
    sections.push({ title: canonical, raw: heading.text, blockIndex: heading.blockIndex });
  }
  const tables = new Map();
  for (const block of blocks.filter(item => item.tag === 'table' && item.rows?.length)) {
    const previous = [...blocks].reverse().find(item => /^h[2-4]$/.test(item.tag) && item.blockIndex < block.blockIndex);
    const key = previous ? canonicalHeading(previous.text) : '';
    const headers = block.rows[0].map(clean).filter(Boolean).slice(0, 12);
    if (!headers.length) continue;
    tables.set(key, [...(tables.get(key) || []), headers]);
  }
  const labelled = [];
  for (const block of blocks) {
    if (!/^(p|li)$/.test(block.tag)) continue;
    const match = /^([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9（）()·\-]{1,14})[：:]/.exec(block.text);
    if (match) labelled.push(match[1]);
  }
  return { id: sample.id, title: clean(sample.title) || '未命名文档', sections, tables, labelled };
}

function extractTerms(samples) {
  const counts = new Map();
  const bump = (term, weight = 1) => {
    const value = clean(term);
    if (value.length < 2 || value.length > 40) return;
    counts.set(value, (counts.get(value) || 0) + weight);
  };
  for (const sample of samples) {
    for (const block of parseBlocks(sample.html)) {
      for (const match of block.text.matchAll(/[「“"《]([^」”"》]{2,24})[」”"》]/g)) bump(match[1]);
      for (const match of block.text.matchAll(/\b([A-Z][A-Za-z0-9._-]{1,30})\b/g)) if (!TERM_STOP.has(match[1])) bump(match[1], 0.5);
    }
  }
  return [...counts.entries()]
    .filter(([term, count]) => count >= 1.5 || (count >= 1 && /[\u4e00-\u9fa5]/.test(term)))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .slice(0, 20)
    .map(([term, count]) => ({ term, occurrences: Math.round(count) }));
}

function formatHeading(index, title, numbered) {
  return numbered ? `${chineseNumber(index + 1)}、${title}` : title;
}

export function distillTemplate(samples, { title = '', description = '' } = {}) {
  if (!Array.isArray(samples) || !samples.length) throw new UserError('请至少选择一份自己的文档作为范文。');
  if (samples.length > 5) throw new UserError('一次最多用 5 份范文提炼模板，避免结构互相冲突。');
  for (const sample of samples) {
    if (!sample || typeof sample.id !== 'string' || typeof sample.html !== 'string') throw new UserError('范文数据不完整，请刷新后重试。');
    if (sample.html.length > 1_000_000) throw new UserError('单份范文过大，请精简后再提炼。');
  }
  const analyses = samples.map(analyzeSample).filter(item => item.sections.length || item.tables.size);
  if (!analyses.length) throw new UserError('所选文档没有可识别的章节标题，无法提炼结构。请先用一级/二级标题组织正文。');

  const merged = new Map();
  let union = 0;
  for (const analysis of analyses) {
    const total = analysis.sections.length;
    analysis.sections.forEach((section, index) => {
      if (!merged.has(section.title)) { merged.set(section.title, { title: section.title, samples: 0, positions: [], tables: [] }); union++; }
      const entry = merged.get(section.title);
      entry.samples++;
      entry.positions.push(ratio(index, total));
      const headers = analysis.tables.get(section.title) || [];
      for (const row of headers) for (const header of row) if (header && !GENERIC_COLUMNS.has(header)) entry.tables.push(header);
    });
  }
  const threshold = Math.max(1, Math.ceil(analyses.length * 0.5));
  let kept = [...merged.values()].filter(entry => entry.samples >= threshold);
  if (kept.length < 2) kept = [...merged.values()].slice(0, 12);
  kept.sort((a, b) => a.positions.reduce((sum, value) => sum + value, 0) / a.positions.length - b.positions.reduce((sum, value) => sum + value, 0) / b.positions.length);
  kept = kept.slice(0, 16);

  const columns = new Map();
  for (const entry of kept) {
    const counted = new Map();
    for (const column of entry.tables) counted.set(column, (counted.get(column) || 0) + 1);
    columns.set(entry.title, [...counted.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([column]) => column));
  }
  const variables = [];
  for (const [section, list] of columns) for (const column of list) variables.push({ name: column, section });
  for (const analysis of analyses) for (const label of analysis.labelled) variables.push({ name: label, section: '' });
  const variableMap = new Map();
  for (const variable of variables) {
    if (GENERIC_COLUMNS.has(variable.name) || variable.name.length > 20) continue;
    const existing = variableMap.get(variable.name);
    if (existing) existing.count++; else variableMap.set(variable.name, { ...variable, count: 1 });
  }
  const finalVariables = [...variableMap.values()].sort((a, b) => b.count - a.count).slice(0, 16);

  const numbering = analyses.filter(item => item.sections.some(section => /^[（(]?[一二三四五六七八九十百]+[）)、.．]/.test(section.raw))).length;
  const numbered = numbering >= Math.ceil(analyses.length / 2);
  const terms = extractTerms(samples);
  const name = clean(title) || (analyses.length === 1 ? `${analyses[0].title}（结构模板）` : `${analyses[0].title}等 ${analyses.length} 份范文（结构模板）`);
  if (name.length > 80) throw new UserError('模板名称不能超过 80 个字符。');

  const sections = kept.map(entry => entry.title);
  const agreement = union ? kept.length / union : 0;
  const confidence = Math.round((agreement * 0.55 + Math.min(1, analyses.length / 3) * 0.45) * 100);

  const body = kept.map((entry, index) => {
    const list = columns.get(entry.title) || [];
    if (!list.length) return `## ${formatHeading(index, entry.title, numbered)}\n\n按范文中的本节内容撰写；缺失信息标注“待补充”。`;
    return `## ${formatHeading(index, entry.title, numbered)}\n\n| ${list.join(' | ')} |\n| ${list.map(() => '---').join(' | ')} |\n| ${list.map(() => '待补充').join(' | ')} |\n\n按表格列出本节的实际信息；无依据的单元格标注“待补充”。`;
  }).join('\n\n');

  const content = `# ${name}\n\n> 这是从 ${analyses.length} 份范文提炼的内容骨架（章节一致度约 ${Math.round(agreement * 100)}%）。请先核对章节与表格列，再填写实际信息；没有依据的内容一律标注“待补充”。\n\n${body}\n\n## 填写与检查\n\n- 先补充文档简报：目的、读者、范围与资料策略。\n- 核对章节顺序是否符合本次用途，可增删但保留编号连续。\n- 表格列来自范文的常见列名，请按实际数据调整。\n- 交付前运行「交付体检」，逐项处理占位符与无依据表述。\n\n## 参考范文\n\n${analyses.map(item => `- ${item.title}`).join('\n')}`;

  const rules = `以 ${analyses.length} 份范文提炼的结构为骨架，章节顺序为：${sections.join('、')}。沿用范文中的术语与统计口径（${terms.slice(0, 8).map(item => item.term).join('、') || '以实际资料为准'}）；缺少的数据、日期和结论标注“待补充”，不得虚构。每个章节先写事实与依据，再写解释和建议；引用资料时标注来源。`;

  return {
    template: {
      id: '',
      title: name,
      category: '我的模板',
      subtitle: `从 ${analyses.length} 份范文提炼 · ${sections.length} 个章节`,
      description: clean(description) || `根据你提供的 ${analyses.length} 份文档提炼的私有结构模板。章节、表格列和术语均可编辑。`,
      rules,
      sections,
      content,
      language: '中文',
      editorLabel: '使用我的模板',
      usage: [
        '先核对章节顺序与表格列是否符合本次用途。',
        '在「文档简报」中补充目的、读者、范围与资料策略。',
        '没有资料支持的数字和结论保留“待补充”，不要自行补全。',
        '完成后运行「交付体检」，再导出或交付。'
      ],
      assets: [{ id: 'markdown', format: 'MD', label: '中文 Markdown 模板', generated: true }],
      color: 'sand',
      tag: '我的模板',
      variables: finalVariables,
      origin: {
        kind: 'distilled',
        createdAt: new Date().toISOString(),
        samples: analyses.map(item => ({ id: item.id, title: item.title })),
        confidence,
        agreement: Math.round(agreement * 100),
        terms
      }
    },
    confidence
  };
}
