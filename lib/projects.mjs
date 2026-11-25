// 项目知识空间：把多篇文档共用的资料放在项目上，一次维护、多篇引用。
// 检索是确定性的字面匹配（中文二元组 + 英文词），不引入向量库，离线也能复现。

export const PROJECT_LIMITS = {
  projects: 40,
  sources: 30,
  sourceText: 200_000,
  totalText: 600_000,
  name: 60,
  description: 500
};

const text = (value, max) => String(value ?? '').trim().slice(0, max);
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);

export function normalizeProject(input, previous = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('项目格式不正确。');
  const name = text(input.name, PROJECT_LIMITS.name);
  if (!name) throw new Error('请填写项目名称。');
  return {
    id: previous?.id || `project-${crypto.randomUUID().slice(0, 8)}`,
    name,
    description: text(input.description ?? previous?.description, PROJECT_LIMITS.description),
    createdAt: previous?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sources: previous?.sources || []
  };
}

export function normalizeProjectSource(input) {
  if (!input || typeof input !== 'object') throw new Error('资料格式不正确。');
  const name = text(input.name, 200);
  const body = String(input.text ?? '');
  if (!name) throw new Error('请填写资料名称。');
  if (!body.trim()) throw new Error('资料内容不能为空。');
  if (body.length > PROJECT_LIMITS.sourceText) throw new Error(`单份资料不能超过 ${PROJECT_LIMITS.sourceText.toLocaleString('zh-CN')} 字符。`);
  return { id: validId(input.id) ? input.id : `ps-${crypto.randomUUID().slice(0, 8)}`, name, text: body, addedAt: new Date().toISOString() };
}

export function addProjectSources(project, inputs) {
  const sources = [...project.sources];
  for (const raw of inputs) {
    const source = normalizeProjectSource(raw);
    const duplicate = sources.find(item => item.name === source.name && item.text === source.text);
    if (duplicate) continue;
    if (sources.length >= PROJECT_LIMITS.sources) throw new Error(`一个项目最多保存 ${PROJECT_LIMITS.sources} 份资料。`);
    sources.push(source);
  }
  const total = sources.reduce((sum, item) => sum + item.text.length, 0);
  if (total > PROJECT_LIMITS.totalText) throw new Error(`项目资料总量不能超过 ${PROJECT_LIMITS.totalText.toLocaleString('zh-CN')} 字符，请删除不再使用的资料。`);
  return { ...project, sources, updatedAt: new Date().toISOString() };
}

export function projectStats(project) {
  const sources = Array.isArray(project?.sources) ? project.sources : [];
  const chars = sources.reduce((sum, item) => sum + item.text.length, 0);
  return { sources: sources.length, chars, updatedAt: project?.updatedAt || null };
}

// 中文按二元组切分，英文按词切分；查询很短时命中率优先，不做同义扩展。
export function queryTerms(query) {
  const value = String(query || '').replace(/\s+/g, ' ').trim();
  const terms = new Set();
  for (const word of value.toLowerCase().match(/[a-z0-9][a-z0-9._-]+/g) || []) terms.add(word);
  for (const run of value.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) { terms.add(run); continue; }
    for (let index = 0; index < run.length - 1; index++) terms.add(run.slice(index, index + 2));
  }
  return [...terms].slice(0, 24);
}

export function searchProject(project, query, { limit = 12, context = 60 } = {}) {
  const terms = queryTerms(query);
  if (!terms.length) return { terms: [], total: 0, matches: [] };
  const matches = [];
  for (const source of project?.sources || []) {
    const haystack = source.text.toLowerCase();
    let score = 0;
    let anchor = -1;
    for (const term of terms) {
      let index = haystack.indexOf(term);
      if (index < 0) continue;
      let hits = 0;
      while (index >= 0 && hits < 8) { hits++; index = haystack.indexOf(term, index + term.length); }
      score += hits * (term.length >= 2 ? 1 : 0.5);
      const first = haystack.indexOf(term);
      if (anchor < 0 || first < anchor) anchor = first;
    }
    if (score <= 0 || anchor < 0) continue;
    const start = Math.max(0, anchor - context);
    const end = Math.min(source.text.length, anchor + context * 2);
    matches.push({
      source: { id: source.id, name: source.name },
      score: Math.round(score * 10) / 10,
      offset: anchor,
      snippet: `${start > 0 ? '…' : ''}${source.text.slice(start, end).replace(/\s+/g, ' ')}${end < source.text.length ? '…' : ''}`
    });
  }
  matches.sort((a, b) => b.score - a.score || a.source.name.localeCompare(b.source.name));
  return { terms, total: matches.length, matches: matches.slice(0, limit) };
}

// 生成、依据、体检都用同一份合并结果：项目资料排在文档自有资料之后，重名同文不重复。
export function mergeSources(documentSources = [], project = null, { limit = 20, maxChars = 500_000 } = {}) {
  const merged = [];
  const seen = new Set();
  for (const source of Array.isArray(documentSources) ? documentSources : []) {
    const key = `${source.name}\u0000${String(source.text || '').slice(0, 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...source, origin: 'document' });
  }
  for (const source of project?.sources || []) {
    const key = `${source.name}\u0000${String(source.text || '').slice(0, 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ id: source.id, name: source.name, text: source.text, enabled: true, origin: 'project', projectName: project.name });
  }
  const kept = [];
  let chars = 0;
  for (const source of merged) {
    if (kept.length >= limit) break;
    if (chars + source.text.length > maxChars) continue;
    chars += source.text.length;
    kept.push(source);
  }
  return kept;
}

export function projectBrief(project) {
  const stats = projectStats(project);
  return `${project.name} · ${stats.sources} 份资料 · ${stats.chars.toLocaleString('zh-CN')} 字符`;
}
