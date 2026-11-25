import { UserError } from './providers.mjs';

// 文档简报是“这次要写给谁、为什么写、依据什么”的最小状态。
// 它只是任务约束，不会被当成事实证据；因此单独建模，避免和参考资料混在一起。

export const BRIEF_FIELDS = [
  { key: 'purpose', label: '写作目的', hint: '这份文档要解决什么问题、支持什么决定' },
  { key: 'audience', label: '目标读者', hint: '谁会读、他们已知道什么、关心什么' },
  { key: 'scope', label: '范围与边界', hint: '包含什么、不包含什么、时间或对象范围' },
  { key: 'sourcePolicy', label: '资料与引用策略', hint: '哪些资料可用、如何标注依据、哪些必须待确认' }
];

function text(value, max, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new UserError(`文档简报中的${label}应为文字。`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new UserError(`文档简报中的${label}不能超过 ${max} 个字符。`);
  return trimmed;
}

function list(value, max, itemMax, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw new UserError(`文档简报中的${label}应为最多 ${max} 项的列表。`);
  return value.map(item => text(item, itemMax, label)).filter(Boolean);
}

export function normalizeBrief(input) {
  if (input === undefined) return null;
  if (input === null || input === '') return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new UserError('文档简报格式不正确。');
  const fields = {
    purpose: text(input.purpose, 500, '写作目的'),
    audience: text(input.audience, 300, '目标读者'),
    scope: text(input.scope, 500, '范围与边界'),
    keyPoints: list(input.keyPoints, 12, 300, '关键事实'),
    terminology: (() => {
      if (input.terminology === undefined || input.terminology === null) return [];
      if (!Array.isArray(input.terminology) || input.terminology.length > 30) throw new UserError('文档简报中的术语应为最多 30 项。');
      return input.terminology.map(item => {
        if (!item || typeof item !== 'object') throw new UserError('术语条目格式不正确。');
        const term = text(item.term, 60, '术语');
        const definition = text(item.definition, 200, '术语说明');
        return term ? { term, definition } : null;
      }).filter(Boolean);
    })(),
    constraints: text(input.constraints, 800, '交付约束'),
    sourcePolicy: text(input.sourcePolicy, 500, '资料与引用策略')
  };
  const filled = Object.values(fields).some(value => Array.isArray(value) ? value.length > 0 : Boolean(value));
  return filled ? { ...fields, updatedAt: new Date().toISOString() } : null;
}

export function briefFilled(brief) {
  if (!brief) return 0;
  const checks = [brief.purpose, brief.audience, brief.scope, brief.sourcePolicy, brief.keyPoints?.length, brief.terminology?.length, brief.constraints];
  return checks.filter(Boolean).length;
}

export function briefStats(brief) {
  const total = 7, filled = briefFilled(brief);
  return { filled, total, percent: Math.round(filled / total * 100) };
}

export function briefGaps(brief) {
  if (!brief) return [{ field: 'brief', label: '文档简报', severity: 'normal', hint: '尚未填写写作目的、读者和范围，AI 只能按通用结构起草。' }];
  const gaps = [];
  if (!brief.purpose) gaps.push({ field: 'purpose', label: '写作目的', severity: 'important', hint: '未说明这份文档要解决什么问题。' });
  if (!brief.audience) gaps.push({ field: 'audience', label: '目标读者', severity: 'important', hint: '未说明读者是谁，语气和详略难以判断。' });
  if (!brief.scope) gaps.push({ field: 'scope', label: '范围与边界', severity: 'normal', hint: '未说明包含与不包含的内容。' });
  if (!brief.keyPoints?.length) gaps.push({ field: 'keyPoints', label: '关键事实', severity: 'normal', hint: '未列出必须准确写入的事实、数字或结论。' });
  if (!brief.sourcePolicy) gaps.push({ field: 'sourcePolicy', label: '资料与引用策略', severity: 'normal', hint: '未说明哪些资料可用、如何标注依据。' });
  if (!brief.terminology?.length) gaps.push({ field: 'terminology', label: '术语口径', severity: 'info', hint: '如有内部叫法或统一口径，建议写明，便于全文一致。' });
  if (!brief.constraints) gaps.push({ field: 'constraints', label: '交付约束', severity: 'info', hint: '页数、字数、格式或截止时间等要求可写在这里。' });
  return gaps;
}

export function briefPrompt(brief) {
  if (!brief) return '';
  const lines = [];
  if (brief.purpose) lines.push(`- 写作目的：${brief.purpose}`);
  if (brief.audience) lines.push(`- 目标读者：${brief.audience}`);
  if (brief.scope) lines.push(`- 范围与边界：${brief.scope}`);
  if (brief.keyPoints?.length) lines.push(`- 必须准确写入的关键事实：${brief.keyPoints.join('；')}`);
  if (brief.terminology?.length) lines.push(`- 术语与统一口径：${brief.terminology.map(item => item.definition ? `${item.term}＝${item.definition}` : item.term).join('；')}`);
  if (brief.constraints) lines.push(`- 交付约束：${brief.constraints}`);
  if (brief.sourcePolicy) lines.push(`- 资料与引用策略：${brief.sourcePolicy}`);
  if (!lines.length) return '';
  return `文档简报（用户提供的任务约束，不是资料证据）：\n${lines.join('\n')}\n写作时遵守上述约束；简报没有提供的数字、日期、结论一律标注“待补充”，不得自行补全。`;
}
