import { UserError } from './providers.mjs';

// 模型可以控制 spec_json / content_json 等参数。深层嵌套会让 JSON.parse 之后
// 的递归校验、路径改写或上游解析爆栈，因此先按「层数 + 节点数」做预算校验。
// 用显式栈遍历，校验器本身不会因为 10 万层嵌套而溢出。
export function assertJsonBudget(value, { label = '工具参数', maxDepth = 8, maxNodes = 20_000 } = {}) {
  const stack = [[value, 0]];
  let nodes = 0;
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (!item || typeof item !== 'object') continue;
    if (depth >= maxDepth) throw new UserError(`${label}的嵌套层级超过 ${maxDepth} 层，请简化后重试。`);
    for (const child of Array.isArray(item) ? item : Object.values(item)) {
      if (++nodes > maxNodes) throw new UserError(`${label}的字段数量超过 ${maxNodes} 个，请简化后重试。`);
      if (child && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return value;
}
