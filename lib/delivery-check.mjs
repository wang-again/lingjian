import { parseBlocks, countWords, canonicalHeading, sourceCitation } from './html-blocks.mjs';
import { briefGaps, briefStats } from './document-brief.mjs';
import { buildEvidenceLedger } from './evidence.mjs';

// 交付体检：把确定性的结构与依据检查汇总成一份“能不能交、先改哪几处”的结论。
// “通过”只代表以下已执行检查通过，不代表事实、图片内容或页面排版已验证。

const PLACEHOLDER = /(待补充|待确认|待完善|待填写|TBD|TODO|XXX|xxx)/g;
const SEVERITY_WEIGHT = { blocker: 22, warn: 7, info: 2 };
const SEVERITY_LABEL = { blocker: '必须处理', warn: '建议确认', info: '提示' };

function sourceName(source) {
  return String(source?.name || '').replace(/\.(docx|pdf|xlsx|xlsm|pptx|txt|md|markdown|csv)$/i, '');
}

function findSource(name, sources) {
  const bare = String(name || '').trim();
  const normalized = sourceName({ name: bare });
  return sources.find(source => source.name === bare)
    || sources.find(source => sourceName(source) === normalized)
    || sources.find(source => source.name.includes(normalized) || normalized.includes(sourceName(source)));
}

function chineseToNumber(value) {
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  if (/^十[一二三四五六七八九]$/.test(value)) return 10 + digits[value[1]];
  if (/^[一二三四五六七八九]十$/.test(value)) return digits[value[0]] * 10;
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(value)) return digits[value[0]] * 10 + digits[value[2]];
  return digits[value] ?? null;
}

export function runDeliveryCheck({ document, ledger = null } = {}) {
  if (!document || typeof document.html !== 'string') throw new Error('缺少可检查的文档正文。');
  const html = document.html;
  const blocks = parseBlocks(html);
  const text = blocks.map(block => block.text).join('\n');
  const sources = Array.isArray(document.sources) ? document.sources : [];
  const enabledSources = sources.filter(source => source.enabled !== false);
  const words = countWords(html);
  const issues = [];
  const add = (category, severity, title, detail, suggestion, location = '', evidence = []) => {
    issues.push({ id: `d${issues.length + 1}`, category, severity, title, detail, suggestion, location, evidence });
  };

  if (words < 30) add('content', 'blocker', '正文内容过少', `当前正文约 ${words} 字，尚未形成可交付内容。`, '补充正文后再运行体检。');

  // 1. 占位符：交付前最明确、最该先处理的阻断项。
  const placeholders = new Map();
  blocks.forEach(block => {
    for (const match of block.text.matchAll(PLACEHOLDER)) {
      const key = match[1];
      const entry = placeholders.get(key) || { count: 0, blocks: [] };
      entry.count++;
      if (!entry.blocks.includes(block.blockIndex + 1) && entry.blocks.length < 6) entry.blocks.push(block.blockIndex + 1);
      placeholders.set(key, entry);
    }
  });
  // 同一处占位内容往往成组出现；合并为一条阻断项，避免多个近义词把分数压到失真。
  if (placeholders.size) {
    const all = [...placeholders.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8);
    const total = all.reduce((sum, [, item]) => sum + item.count, 0);
    const blocks = [...new Set(all.flatMap(([, item]) => item.blocks))].slice(0, 6);
    add('placeholder', 'blocker', `仍有 ${total} 处未补齐内容（${all.map(([name]) => name).join('、')}）`, `占位内容出现在第 ${blocks.join('、')} 段附近，说明信息尚未补齐。`, '补齐实际信息；确实无法确认的，改为明确的待确认说明和责任人。', `第 ${blocks[0]} 段`);
  }

  // 2. 标题结构：层级跳跃、重复章节、空章节、编号断档。
  const headings = blocks.filter(block => /^h[2-4]$/.test(block.tag));
  if (!headings.length && words > 300) add('structure', 'warn', '正文没有章节标题', '长篇正文没有二级及以上标题，读者难以定位，AI 也难以按章节处理。', '按内容层次补充二级标题，每节聚焦一个问题。');
  let previousLevel = 0;
  for (const heading of headings.slice(0, 200)) {
    if (previousLevel && heading.level > previousLevel + 1) add('structure', 'warn', `标题层级跳跃：${heading.text.slice(0, 30)}`, `上一级标题为 H${previousLevel}，此处直接使用 H${heading.level}，层级不连续。`, '补齐中间层级，或把该标题提升一级。', `第 ${heading.blockIndex + 1} 段`);
    previousLevel = heading.level;
  }
  const seen = new Map();
  for (const heading of headings.slice(0, 200)) {
    const key = canonicalHeading(heading.text).replace(/\s+/g, '');
    if (seen.has(key)) add('structure', 'warn', `章节标题重复：${heading.text.slice(0, 30)}`, `与第 ${seen.get(key) + 1} 段标题相同，容易造成结构混乱。`, '合并重复章节，或改成能区分内容的标题。', `第 ${heading.blockIndex + 1} 段`);
    else seen.set(key, heading.blockIndex);
  }
  for (const [index, heading] of headings.slice(0, 200).entries()) {
    const next = blocks[heading.blockIndex + 1];
    const nextHeading = headings[index + 1];
    const endsSection = !next || (nextHeading && next.blockIndex === nextHeading.blockIndex && nextHeading.level <= heading.level);
    if (endsSection) add('structure', 'warn', `章节没有正文：${heading.text.slice(0, 30)}`, '标题之后直接进入下一个同级标题，本节没有可交付内容。', '补充本节内容，或删除空章节。', `第 ${heading.blockIndex + 1} 段`);
  }
  const numbered = headings.filter(heading => /^[（(]?([一二三四五六七八九十]+)[）)、.．]/.test(heading.text));
  if (numbered.length >= 3) {
    const sequence = numbered.map(heading => ({ value: chineseToNumber(/^[（(]?([一二三四五六七八九十]+)[）)、.．]/.exec(heading.text)[1]), text: heading.text }));
    const broken = sequence.filter((item, index) => item.value !== index + 1);
    if (broken.length) add('structure', 'info', '章节编号不连续', `检测到 ${broken.length} 处编号与顺序不一致（如「${broken[0].text.slice(0, 24)}」）。`, '统一编号方式，并用自动编号减少手工调整。', '', broken.slice(0, 3).map(item => ({ quote: item.text.slice(0, 60) })));
  }

  // 3. 表格：列数不齐、空单元格。
  const tables = blocks.filter(block => block.tag === 'table' && block.rows?.length);
  tables.forEach((table, index) => {
    const width = table.rows[0].length;
    const uneven = table.rows.map((row, rowIndex) => ({ rowIndex, width: row.length })).filter(row => row.width !== width);
    if (uneven.length) add('table', 'warn', `第 ${index + 1} 个表格列数不一致`, `表头有 ${width} 列，但第 ${uneven.slice(0, 5).map(row => row.rowIndex + 1).join('、')} 行的列数为 ${uneven[0].width}。`, '补齐或合并单元格，保证每行列数一致。', '表格');
    const cells = table.rows.flat();
    const empty = cells.filter(cell => !String(cell || '').trim()).length;
    if (cells.length && empty / cells.length > 0.4) add('table', 'info', `第 ${index + 1} 个表格空单元格较多`, `${cells.length} 个单元格中有 ${empty} 个为空。`, '补齐必要数据；不需要的列可以删除。', '表格');
  });

  // 4. 引用：正文引用是否指向当前资料。
  const cited = [...new Set([...text.matchAll(sourceCitation)].map(match => match[1].trim()).filter(Boolean))];
  const missing = cited.filter(name => !findSource(name, sources));
  if (missing.length) add('citation', 'blocker', `有 ${missing.length} 个引用指向不存在的资料`, `未找到：${missing.slice(0, 5).join('、')}。`, '修正资料名称，或先添加对应资料；不要保留无法核对的引用。', '引用标记', missing.slice(0, 3).map(name => ({ quote: `[资料：${name}]` })));
  if (enabledSources.length && !cited.length && words > 300) add('citation', 'info', '正文没有标注资料引用', `已启用 ${enabledSources.length} 份资料，但正文中没有出现 [资料：名称] 标记。`, '在关键数据或结论后标注来源，便于交付时核对。');

  // 5. 文档简报：缺失关键信息会影响读者与范围判断。
  const gaps = briefGaps(document.brief);
  if (!document.brief) add('brief', 'info', '未填写文档简报', '没有说明写作目的、读者和范围，交付前难以判断内容是否合适。', '补充简报后再让 AI 起草或审阅。');
  else {
    for (const gap of gaps.filter(item => item.severity !== 'info').slice(0, 4)) add('brief', gap.severity === 'important' ? 'warn' : 'info', `简报缺少${gap.label}`, gap.hint, '在「文档简报」中补充。');
    for (const term of (document.brief.terminology || []).slice(0, 10)) {
      if (term.term && !text.includes(term.term)) add('brief', 'info', `简报术语未在正文出现：${term.term}`, '简报中约定的术语没有出现在正文，可能漏写或用了别的叫法。', '确认是否需要补充，或从简报中移除该术语。');
    }
  }

  // 6. 依据台账：把“无依据、引用失效、数字缺失”纳入交付结论。
  const evidence = ledger || buildEvidenceLedger({ html, sources, brief: document.brief || null });
  if (evidence.claims.length) {
    const blocking = evidence.claims.filter(claim => claim.status === 'broken');
    if (blocking.length) add('evidence', 'blocker', `有 ${blocking.length} 条引用无法核对`, blocking.slice(0, 3).map(claim => claim.note).join(' '), '修正引用名称或停用状态，再重新核验。', '依据台账');
    const unverified = evidence.claims.filter(claim => claim.status === 'unverified');
    if (unverified.length) add('evidence', 'warn', `有 ${unverified.length} 条说法未找到资料依据`, `例如「${unverified[0].plain.slice(0, 60)}」。`, '补充资料来源，或把断言改成待确认/限定表述。', '依据台账', unverified.slice(0, 3).map(claim => ({ quote: claim.plain.slice(0, 80) })));
    const weak = evidence.claims.filter(claim => ['weak', 'needs-check'].includes(claim.status));
    if (weak.length) add('evidence', 'info', `有 ${weak.length} 条依据需要人工确认`, '这些说法只有部分重合，未达到逐字依据标准。', '打开依据台账逐条核对原文与引用对象。');
    if (evidence.claims.length >= 5 && evidence.summary.coverage < 50) add('evidence', 'warn', '依据覆盖率偏低', `当前 ${evidence.summary.total} 条关键说法中，可核对依据覆盖约 ${evidence.summary.coverage}%。`, '优先为数字、结论和对外承诺补充依据。');
  }

  // 7. 日期格式：同一文档混用多种写法会影响正式交付。
  const dateFormats = [
    { pattern: /\d{4}年\d{1,2}月\d{1,2}日/g, label: '2026年1月1日' },
    { pattern: /\d{4}-\d{1,2}-\d{1,2}/g, label: '2026-01-01' },
    { pattern: /\d{4}\/\d{1,2}\/\d{1,2}/g, label: '2026/1/1' },
    { pattern: /\d{4}\.\d{1,2}\.\d{1,2}/g, label: '2026.1.1' }
  ].filter(format => format.pattern.test(text));
  if (dateFormats.length > 1) add('consistency', 'info', '日期写法不统一', `正文同时使用 ${dateFormats.map(item => item.label).join('、')}。`, '统一为一种日期格式，避免读者误解。');

  const counts = { blocker: 0, warn: 0, info: 0 };
  for (const issue of issues) counts[issue.severity]++;
  // 报告要能存入工作区并一次读完：超长文档的同类问题只保留前 99 项。
  if (issues.length > 100) {
    const dropped = issues.length - 99;
    issues.splice(99, issues.length, { id: 'd100', category: 'content', severity: 'info', title: `另有 ${dropped} 项同类问题未展开`, detail: '问题数量超过单次报告上限，报告只列出前 100 项；评分仍按全部问题计算。', suggestion: '先处理已列出的高优先级项，再运行一次体检。', location: '', evidence: [], severityLabel: SEVERITY_LABEL.info });
  }
  const score = Math.max(0, 100 - Object.entries(SEVERITY_WEIGHT).reduce((sum, [severity, weight]) => sum + counts[severity] * weight, 0));
  const grade = counts.blocker ? 'blocked' : counts.warn === 0 && score >= 85 ? 'ready' : 'review';
  const gradeLabel = { blocked: '需处理后交付', review: '建议确认后交付', ready: '未发现阻断项' }[grade];
  const summary = grade === 'blocked'
    ? `发现 ${counts.blocker} 项必须先处理的问题，暂不建议交付。`
    : grade === 'review'
      ? `未发现阻断项，但有 ${counts.warn} 项建议确认。`
      : '已执行的检查未发现阻断项。';

  return {
    version: 1,
    at: new Date().toISOString(),
    grade,
    gradeLabel,
    score,
    summary,
    counts,
    issues: issues.map(issue => ({ ...issue, severityLabel: SEVERITY_LABEL[issue.severity] })),
    stats: {
      words,
      blocks: blocks.length,
      headings: headings.length,
      tables: tables.length,
      sources: enabledSources.length,
      citations: cited.length,
      claims: evidence.claims.length,
      evidenceCoverage: evidence.summary.coverage
    },
    brief: briefStats(document.brief),
    evidence: evidence.summary,
    scope: '本次只检查可提取文字、标题结构、表格列数、引用标记与依据记录；不核对图片内容、外部事实、页面排版、Office 公式计算或文件级格式。'
  };
}
