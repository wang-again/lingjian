import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages } from '../lib/prompts.mjs';
import { makePayload } from '../lib/providers.mjs';

const src = 'data:image/png;base64,iVBORw0KGgo=';
const document = { title: '片段验证', html: `<p>不应改动的前文</p><table><tr><td>原数据</td></tr></table><p><img src="${src}" alt="图"></p><p>不应改动的后文</p>`, sources: [] };
const input = { mode: 'rewrite', prompt: '保留原图，将说明改为示意图，表格增加备注列。', selection: '| 数据 |\n| --- |\n| 原数据 |\n\n![图](fragment-image:1)', fragment: { rich: true, images: [{ id: '1', src }] } };

test('片段请求携带表格结构和实际图片，Chat 与 Responses 均使用正确的视觉输入', () => {
  const messages = buildMessages(document, input);
  const context = JSON.parse(messages[1].content);
  assert.equal(context.selectedText, input.selection);
  assert.ok(context.currentDocument.includes('不应改动的前文'));
  assert.ok(messages[0].content.includes('不要修改其他章节'));
  assert.ok(!messages[0].content.includes('不输出 Markdown 标记'));
  const config = { model: 'fixture', protocol: 'chat', maxTokens: 4096, temperature: null };
  const chat = makePayload(config, messages, false);
  assert.deepEqual(chat.messages[2].content[1], { type: 'image_url', image_url: { url: src } });
  const responses = makePayload({ ...config, protocol: 'responses' }, messages, false);
  assert.deepEqual(responses.input[2].content[1], { type: 'input_image', image_url: src });
  assert.equal(responses.input[2].content[0].type, 'input_text');
});

test('拒绝伪造、远程、重复与过量片段图片，阻止任意 URL 随任务发送', () => {
  const call = images => buildMessages(document, { ...input, fragment: { rich: true, images } });
  for (const images of [
    [{ id: '1', src: 'https://example.com/private.png' }],
    [{ id: '1', src: 'data:image/png;base64,YWJj' }],
    [{ id: '1', src }, { id: '1', src }],
    Array.from({ length: 5 }, (_, i) => ({ id: String(i + 1), src })),
    'invalid'
  ]) assert.throws(() => call(images), /图片/);
});

test('纯文字选区保持原有纯文本替换协议，非修改任务不携带图片', () => {
  const messages = buildMessages(document, { ...input, fragment: undefined, selection: '原文' });
  assert.equal(messages.length, 3);
  assert.ok(messages[0].content.includes('不输出 Markdown 标记'));
  assert.equal(buildMessages(document, { ...input, mode: 'write' }).length, 3);
});
