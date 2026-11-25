// 可复用任务配方：把“先补哪几章、再核依据、最后体检”的固定套路存下来，一键排进任务队列。
// 配方本身是纯数据，展开成任务只依赖配方与当前章节结构，因此同一配方重放两次得到同一串步骤。

export const RECIPE_LIMIT = 20;
export const STEP_LIMIT = 12;
export const STEP_KINDS = ['chapter', 'whole', 'check', 'evidence'];
export const STEP_TARGETS = ['empty', 'all', 'key'];

const text = (value, max) => String(value ?? '').trim().slice(0, max);

export function validateRecipe(input, previous = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配方格式不正确。');
  const name = text(input.name, 60);
  if (!name) throw new Error('请填写配方名称。');
  if (!Array.isArray(input.steps) || !input.steps.length) throw new Error('配方至少需要一个步骤。');
  if (input.steps.length > STEP_LIMIT) throw new Error(`一个配方最多 ${STEP_LIMIT} 个步骤。`);
  const steps = input.steps.map((step, index) => {
    const kind = STEP_KINDS.includes(step?.kind) ? step.kind : 'chapter';
    const title = text(step?.title, 80) || `步骤 ${index + 1}`;
    const instruction = text(step?.instruction, 1500);
    const target = kind === 'chapter' ? (STEP_TARGETS.includes(step?.target) ? step.target : 'empty') : 'whole';
    const chapterKey = target === 'key' ? text(step?.chapterKey, 200) : '';
    const chapterTitle = target === 'key' ? text(step?.chapterTitle, 200) : '';
    if (target === 'key' && !chapterKey && !chapterTitle) throw new Error(`第 ${index + 1} 步：请指定要写的章节。`);
    if (kind === 'chapter' && !instruction) throw new Error(`第 ${index + 1} 步：章节步骤需要填写写作要求。`);
    return { id: `step-${index + 1}`, kind, title, instruction, target, chapterKey, chapterTitle };
  });
  return {
    id: previous?.id || `recipe-${crypto.randomUUID().slice(0, 8)}`,
    name,
    description: text(input.description, 300),
    builtin: Boolean(previous?.builtin),
    createdAt: previous?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps
  };
}

export function builtinRecipes() {
  return [
    {
      id: 'builtin-fill-empty', name: '补全空缺章节', builtin: true,
      description: '为每个还没有内容的章节各排一个写作任务，写完再跑一次体检。',
      createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
      steps: [
        { id: 'step-1', kind: 'chapter', title: '补全空缺章节', target: 'empty', chapterKey: '', chapterTitle: '', instruction: '按文档简报与本章小标题补全内容；缺少的数据写“待补充”，不虚构。' },
        { id: 'step-2', kind: 'check', title: '交付体检', target: 'whole', chapterKey: '', chapterTitle: '', instruction: '汇总结构与依据检查。' }
      ]
    },
    {
      id: 'builtin-draft-then-check', name: '全文起草后体检', builtin: true,
      description: '整篇重新起草一次，再核依据、跑交付体检。',
      createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
      steps: [
        { id: 'step-1', kind: 'whole', title: '整篇起草', target: 'whole', chapterKey: '', chapterTitle: '', instruction: '按文档简报与模板规范重写全文，保留已有事实与数据。' },
        { id: 'step-2', kind: 'evidence', title: '核依据', target: 'whole', chapterKey: '', chapterTitle: '', instruction: '逐条核对正文说法与资料原文。' },
        { id: 'step-3', kind: 'check', title: '交付体检', target: 'whole', chapterKey: '', chapterTitle: '', instruction: '给出交付结论。' }
      ]
    },
    {
      id: 'builtin-verify-first', name: '先核依据再体检', builtin: true,
      description: '不改正文，先看哪些说法没有依据，再决定改哪里。',
      createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
      steps: [
        { id: 'step-1', kind: 'evidence', title: '核依据', target: 'whole', chapterKey: '', chapterTitle: '', instruction: '逐条核对正文说法与资料原文。' },
        { id: 'step-2', kind: 'check', title: '交付体检', target: 'whole', chapterKey: '', chapterTitle: '', instruction: '给出交付结论。' }
      ]
    }
  ];
}

export function recipeFromTasks(tasks, { name, description = '' } = {}) {
  const list = (Array.isArray(tasks) ? tasks : []).filter(task => task.status !== 'running');
  if (!list.length) throw new Error('当前队列是空的，先排几个任务再存为配方。');
  const steps = list.slice(0, STEP_LIMIT).map((task, index) => ({
    id: `step-${index + 1}`,
    kind: STEP_KINDS.includes(task.kind) ? task.kind : 'chapter',
    title: text(task.title, 80) || `步骤 ${index + 1}`,
    instruction: text(task.instruction, 1500),
    target: task.kind === 'chapter' ? (task.chapterKey ? 'key' : 'empty') : 'whole',
    chapterKey: task.chapterKey || '',
    chapterTitle: task.chapterTitle || ''
  }));
  return validateRecipe({ name, description, steps });
}

// 展开成队列任务：每个步骤按目标章节展开，章节不存在时跳过而不是让整条队列失败。
export function tasksFromRecipe(recipe, document, { limit = 20 } = {}) {
  const sections = Array.isArray(document?.sections) ? document.sections : [];
  const tasks = [];
  for (const step of recipe.steps) {
    if (tasks.length >= limit) break;
    const base = { kind: step.kind, title: step.title, instruction: step.instruction, recipeId: recipe.id, recipeName: recipe.name };
    if (step.kind !== 'chapter') { tasks.push({ ...base, kind: step.kind === 'whole' ? 'whole' : step.kind }); continue; }
    const targets = step.target === 'key'
      ? sections.filter(section => section.key === step.chapterKey || section.title === step.chapterTitle)
      : step.target === 'all' ? sections : sections.filter(section => section.empty);
    for (const section of targets) {
      if (tasks.length >= limit) break;
      tasks.push({ ...base, kind: 'chapter', title: `${step.title} · ${section.title}`, chapterKey: section.key, chapterTitle: section.title });
    }
  }
  if (!tasks.length) throw new Error('这份配方在当前文档里没有可执行的步骤：可能所有章节都已填写，或指定章节已不存在。');
  return tasks;
}

export function expandRecipeForDocument(recipe, document) {
  // 展开只需要章节级信息，这里用最小结构避免把整篇正文带进响应。
  const sections = (document?.sections || []).map(section => ({ key: section.key, title: section.title, empty: section.empty }));
  return tasksFromRecipe(recipe, { sections });
}

export function stepSummary(recipe) {
  return recipe.steps.map(step => `${step.kind === 'chapter' ? '章节' : step.kind === 'whole' ? '整篇' : step.kind === 'check' ? '体检' : '依据'}：${step.title}`).join(' → ');
}
