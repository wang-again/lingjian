import test from 'node:test';
import assert from 'node:assert/strict';
import { distillTemplate } from '../lib/template-distill.mjs';

const sampleA = {
  id: 'a', title: '华东区项目复盘',
  html: '<h2>一、项目概述</h2><p>独特句子甲：本项目服务制造业客户，采用订阅制收费。</p><h2>二、实施计划</h2><table><tr><th>阶段</th><th>负责人</th><th>时间</th><th>备注</th></tr><tr><td>一期</td><td>张三</td><td>3 月</td><td>无</td></tr></table><h2>三、风险与应对</h2><p>需求变更需要每周确认。</p>'
};
const sampleB = {
  id: 'b', title: '华南区项目复盘',
  html: '<h2>一、项目概述</h2><p>另一个项目的背景说明。</p><h2>二、实施计划</h2><table><tr><th>阶段</th><th>负责人</th><th>时间</th></tr><tr><td>一期</td><td>李四</td><td>4 月</td></tr></table><h2>三、风险与应对</h2><p>预算存在不确定性。</p>'
};

test('两份同构范文提炼出共同章节、表格列与变量', () => {
  const { template, confidence } = distillTemplate([sampleA, sampleB], { title: '区域复盘模板' });
  assert.equal(template.title, '区域复盘模板');
  assert.deepEqual(template.sections, ['项目概述', '实施计划', '风险与应对']);
  assert.equal(template.category, '我的模板');
  assert.ok(confidence >= 60, `置信度应足以提示结构稳定，实际 ${confidence}`);
  assert.match(template.content, /\| 阶段 \| 负责人 \| 时间 \|/);
  assert.ok(!template.content.includes('备注'), '通用列名不应进入模板表格');
  assert.ok(!template.content.includes('独特句子甲'), '不应把范文正文复制进模板');
  const names = template.variables.map(item => item.name);
  for (const name of ['阶段', '负责人', '时间']) assert.ok(names.includes(name), `变量应包含 ${name}`);
  assert.equal(template.origin.samples.length, 2);
  assert.equal(template.origin.kind, 'distilled');
  assert.deepEqual(template.assets, [{ id: 'markdown', format: 'MD', label: '中文 Markdown 模板', generated: true }]);
});

test('不同编号格式也能合并同一章节，并按多数风格生成编号', () => {
  const sampleC = { id: 'c', title: '制度稿', html: '<h2>（一）适用范围</h2><p>适用于全部门店。</p><h2>（二）操作流程</h2><p>按步骤执行。</p><h2>（三）检查记录</h2><p>每月检查一次。</p>' };
  const sampleD = { id: 'd', title: '制度稿二', html: '<h2>一、适用范围</h2><p>适用于总部。</p><h2>二、操作流程</h2><p>按流程执行。</p><h2>三、检查记录</h2><p>每季度检查。</p>' };
  const { template } = distillTemplate([sampleC, sampleD], {});
  assert.deepEqual(template.sections, ['适用范围', '操作流程', '检查记录']);
  assert.match(template.content, /## 一、适用范围/);
  assert.match(template.title, /结构模板/);
});

test('没有标题、超过五份或数据不完整时拒绝提炼', () => {
  assert.throws(() => distillTemplate([{ id: 'x', title: '无标题文档', html: '<p>只有正文，没有章节。</p>' }], {}), /没有可识别的章节标题/);
  assert.throws(() => distillTemplate([], {}), /至少选择一份/);
  assert.throws(() => distillTemplate(new Array(6).fill(sampleA), {}), /最多用 5 份/);
  assert.throws(() => distillTemplate([{ id: 'x', title: 'x', html: 123 }], {}), /范文数据不完整/);
});
