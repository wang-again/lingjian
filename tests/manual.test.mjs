import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 手册最容易出的问题不是写得不好，而是慢慢和界面脱节：按钮改名了、入口挪走了，读者照着找不到。
// 这里把手册与真实界面绑在一起，改名时测试先失败。
const read = file => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const html = read('index.html');
const app = read('app.js');
const css = read('styles.css');

const manualSection = html.slice(html.indexOf('<section id="manual-view"'), html.indexOf('<section id="admin-view"'));

test('手册是应用内的一个视图，并且侧栏有入口', () => {
  assert.ok(manualSection.length > 2000, '手册内容过短');
  assert.ok(html.includes('data-view="manual"'), '侧栏缺少使用手册入口');
  assert.ok(app.includes("'admin', 'manual'"), 'setView 没有接管 manual 视图的显示与隐藏');
  assert.ok(app.includes('manual:'), '面包屑缺少「使用手册」映射');
  assert.ok(app.includes('manual-open'), '进入手册时没有切换到打印样式');
});

test('手册目录的每个锚点都指向真实章节', () => {
  const anchors = [...manualSection.matchAll(/class="manual-nav"[\s\S]*?<\/nav>/g)]
    .flatMap(block => [...block[0].matchAll(/href="#([a-z-]+)"/g)].map(match => match[1]));
  assert.ok(anchors.length >= 6, `目录锚点不足：${anchors.length}`);
  const targets = new Set([...manualSection.matchAll(/id="(manual-[a-z]+)"/g)].map(match => match[1]));
  const missing = anchors.filter(anchor => !targets.has(anchor));
  assert.deepEqual(missing, [], '目录指向不存在的章节：' + missing.join('、'));
});

test('手册提到的按钮在页面上真实存在', () => {
  // 左侧是手册里的叫法，右侧是界面实际的元素 id。
  const BUTTONS = {
    简报: 'brief-button',
    依据: 'evidence-button',
    体检: 'delivery-button',
    章节: 'studio-button',
    历史版本: 'history-button',
    导出文档: 'export-button',
    模板中心: 'distill-template',
    文件处理: 'office-upload',
    备份全部文档: 'backup-workspace'
  };
  const missing = [];
  for (const [label, id] of Object.entries(BUTTONS)) {
    if (!manualSection.includes(label)) missing.push(`手册没写「${label}」`);
    if (!html.includes(`id="${id}"`)) missing.push(`界面找不到 #${id}`);
  }
  assert.deepEqual(missing, [], missing.join('；'));
  assert.ok(manualSection.includes('id="manual-print"') && html.includes('id="manual-print"'), '缺少打印入口');
});

test('打印手册时只隐藏手册自身的导航，不影响正文打印', () => {
  const print = css.slice(css.lastIndexOf('@media print'));
  assert.ok(print.includes('body.manual-open'), '打印规则应限定在手册打开时');
  assert.ok(/body\.manual-open \.sidebar/.test(print), '打印时没有隐藏侧栏');
  assert.ok(/body\.manual-open \.manual-view\{overflow:visible/.test(print), '打印时手册仍被视口裁切');
  assert.ok(!/(^|\})\s*\.sidebar,/.test(print), '打印规则不应波及普通页面');
  assert.ok(app.includes('afterprint'), '打印后应把折叠的问答恢复原状');
});
