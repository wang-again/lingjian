import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecipe, builtinRecipes, recipeFromTasks, tasksFromRecipe, stepSummary } from '../lib/recipes.mjs';
import { sectionMap } from '../lib/sections.mjs';

const HTML = '<h2>一、背景</h2><p>已有内容。</p><h2>二、方案</h2><p></p><h2>三、预算</h2><p></p>';
const sections = () => sectionMap(HTML).sections;

test('配方校验：名称必填、步骤数量有界、章节步骤必须写要求', () => {
  assert.throws(() => validateRecipe({ name: '', steps: [{ kind: 'check' }] }), /配方名称/);
  assert.throws(() => validateRecipe({ name: '空配方', steps: [] }), /至少需要一个步骤/);
  assert.throws(() => validateRecipe({ name: '太多', steps: Array.from({ length: 13 }, () => ({ kind: 'check' })) }), /最多 12 个步骤/);
  assert.throws(() => validateRecipe({ name: '缺要求', steps: [{ kind: 'chapter', target: 'empty' }] }), /写作要求/);
  assert.throws(() => validateRecipe({ name: '缺章节', steps: [{ kind: 'chapter', target: 'key', instruction: '写' }] }), /指定要写的章节/);
  const recipe = validateRecipe({ name: '正常配方', steps: [{ kind: 'check', title: '体检' }] });
  assert.match(recipe.id, /^recipe-/);
  assert.equal(recipe.steps[0].target, 'whole');
  assert.equal(recipe.steps[0].id, 'step-1');
});

test('内置配方可直接使用，且都不是可删除的用户配方', () => {
  const builtin = builtinRecipes();
  assert.equal(builtin.length, 3);
  assert.ok(builtin.every(item => item.builtin && item.id.startsWith('builtin-')));
  assert.ok(builtin.some(item => item.id === 'builtin-fill-empty'));
  assert.match(stepSummary(builtin[0]), /章节：补全空缺章节 → 体检：交付体检/);
});

test('按空缺章节展开：只排空章节，再追加体检步骤', () => {
  const recipe = builtinRecipes()[0];
  const tasks = tasksFromRecipe(recipe, { sections: sections() });
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks.slice(0, 2).map(task => task.chapterTitle), ['二、方案', '三、预算']);
  assert.equal(tasks[0].kind, 'chapter');
  assert.equal(tasks[2].kind, 'check');
  assert.equal(tasks[0].recipeId, recipe.id);
  assert.ok(tasks[0].title.includes('补全空缺章节'));
});

test('按全部章节与指定章节展开', () => {
  const all = validateRecipe({ name: '全章', steps: [{ kind: 'chapter', target: 'all', instruction: '补全' }] });
  assert.equal(tasksFromRecipe(all, { sections: sections() }).length, 3);
  const last = sections()[2];
  const one = validateRecipe({ name: '单章', steps: [{ kind: 'chapter', target: 'key', chapterKey: last.key, instruction: '写预算' }] });
  const tasks = tasksFromRecipe(one, { sections: sections() });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].chapterKey, last.key);
  const missing = validateRecipe({ name: '失配', steps: [{ kind: 'chapter', target: 'key', chapterKey: 'h2:不存在#1', instruction: '写' }] });
  assert.throws(() => tasksFromRecipe(missing, { sections: sections() }), /没有可执行的步骤/);
});

test('从当前队列存配方：保留章节绑定与写作要求', () => {
  const tasks = [
    { kind: 'chapter', title: '写方案', instruction: '分三步', chapterKey: 'h2:方案#1', chapterTitle: '二、方案', status: 'queued' },
    { kind: 'check', title: '体检', instruction: '', chapterKey: '', chapterTitle: '', status: 'queued' }
  ];
  const recipe = recipeFromTasks(tasks, { name: '我的套路' });
  assert.equal(recipe.steps.length, 2);
  assert.equal(recipe.steps[0].target, 'key');
  assert.equal(recipe.steps[0].chapterKey, 'h2:方案#1');
  assert.equal(recipe.steps[1].kind, 'check');
  assert.throws(() => recipeFromTasks([], { name: '空' }), /队列是空的/);
});

test('同一配方在同一文档上重放两次，展开出的步骤完全一致', () => {
  const recipe = validateRecipe({ name: '重放', steps: [{ kind: 'chapter', target: 'all', instruction: '补全' }, { kind: 'check', title: '体检' }] });
  const first = tasksFromRecipe(recipe, { sections: sections() });
  const second = tasksFromRecipe(recipe, { sections: sections() });
  assert.deepEqual(first.map(task => [task.kind, task.title, task.chapterKey]), second.map(task => [task.kind, task.title, task.chapterKey]));
});
