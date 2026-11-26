import { UserError } from './providers.mjs';

const limit = 100;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);

function text(value, length, label, required = false) {
  if (typeof value !== 'string' || value.length > length || (required && !value.trim())) {
    throw new UserError(`${label}为空或超过长度限制。`);
  }
  return value;
}

function anchor(input) {
  return {
    quote: text(input?.quote, 800, '批注原文', true),
    prefix: text(input?.prefix, 32, '批注上文'),
    suffix: text(input?.suffix, 32, '批注下文')
  };
}

export function updateAnnotations(items, input, id) {
  if (!id) {
    if (!validId(input?.id)) throw new UserError('批注编号无效。');
    const note = text(input.note, 1000, '批注内容', true).trim();
    const position = anchor(input.anchor);
    const existing = items.find(item => item.id === input.id);
    if (existing) {
      if (existing.note === note && JSON.stringify(existing.anchor) === JSON.stringify(position)) return items;
      throw new UserError('这条批注已保存，请重新打开批注列表。', 409);
    }
    if (items.length >= limit) throw new UserError('每篇文档最多保留 100 条批注。');
    return [...items, { id: input.id, note, anchor: position, resolved: false }];
  }
  if (!items.some(item => item.id === id)) throw new UserError('没有找到这条批注。', 404);
  const changed = input?.anchor
    ? { anchor: anchor(input.anchor) }
    : { resolved: input?.resolved };
  if ('resolved' in changed && typeof changed.resolved !== 'boolean') throw new UserError('请提交有效的批注状态。');
  return items.map(item => item.id === id ? { ...item, ...changed } : item);
}

export function restoreAnnotations(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) throw new UserError('备份中的批注无效或超过数量限制。');
  const ids = new Set();
  return value.map(item => {
    if (!validId(item?.id) || ids.has(item.id) || typeof item.resolved !== 'boolean') throw new UserError('备份中的批注无效。');
    ids.add(item.id);
    return { id: item.id, note: text(item.note, 1000, '批注内容', true), anchor: anchor(item.anchor), resolved: item.resolved };
  });
}
