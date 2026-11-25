import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRecoveryStore, sameDraftContent } from '../public/recovery.js';
import { language, t, uiHtml } from '../public/i18n.js';

// Exercise the actual browser save lifecycle with a controllable local response.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^(?:localizePage|bindLanguages|boot)\(\);\s*$/gm, '');
function browser({ storageUnavailable = false } = {}) {
  const events = {}, requests = [], status = { textContent: '' }, nodes = new Map([['save-status', status]]);
  const values = new Map(), storage = { get length() { return values.size; }, key: i => [...values.keys()][i], getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  const drafts = createRecoveryStore({ tabId: 'test-tab', storage: () => storageUnavailable ? null : storage, session: () => null });
  const context = vm.createContext({
    createRecoveryStore: () => drafts,
    sameDraftContent,
    language, t, uiHtml,
    document: { getElementById: id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: true, close() {}, reset() {} }); return nodes.get(id); } },
    window: { addEventListener(name, handler) { (events[name] ||= []).push(handler); } },
    clearTimeout, structuredClone,
    fetch(path, options) {
      return new Promise((resolve, reject) => requests.push({
        path, token: options.headers['X-Workspace-Token'], body: options.body && JSON.parse(options.body), reject,
        unauthorized() { resolve({ ok: false, status: 401, json: async () => ({ error: '会话过期' }) }); },
        tokenChanged() { resolve({ ok: false, status: 403, json: async () => ({ error: '会话已更新', code: 'WORKSPACE_TOKEN_CHANGED' }) }); },
        conflict() { resolve({ ok: false, status: 409, json: async () => ({ error: '文档版本发生变化' }) }); },
        bootstrap(user, token) { resolve({ ok: true, json: async () => ({ user, token }) }); },
        complete(revision) { resolve({ ok: true, json: async () => ({ document: { revision, history: [], updatedAt: '2026-11-17' } }) }); }
      }));
    }
  });
  vm.runInContext(source + `
    refreshAiControls = () => {}; renderDocuments = () => {}; renderCurrent = () => {};
    globalThis.app = { state, saveCurrent, refreshDocuments };
  `, context);
  const { state, saveCurrent } = context.app;
  const doc = { id: 'one', title: '标题', html: '<p>原文</p>', sources: [], revision: 1, _dirty: true };
  state.doc = doc; state.documents = [doc];
  return { ...context.app, doc, requests, status, drafts,
    closingIsBlocked() {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      for (const handler of events.beforeunload) handler(event);
      return event.prevented;
    }
  };
}

test('保存请求尚未完成时关闭页面仍提醒，确认保存后解除', async () => {
  const b = browser();
  assert.equal(b.closingIsBlocked(), true);
  const saving = b.saveCurrent();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.requests.length, 1);
  assert.equal(b.doc._dirty, false);
  assert.equal(b.closingIsBlocked(), true);
  b.requests[0].complete(2); await saving;
  assert.equal(b.doc.revision, 2);
  assert.equal(b.status.textContent, '已保存');
  assert.equal(b.closingIsBlocked(), false);
  assert.equal(b.drafts.list('local').length, 0);
});

test('保存失败保留未保存提醒，重试成功后解除', async () => {
  const b = browser(), saving = b.saveCurrent();
  const failed = assert.rejects(saving, /离线/);
  await new Promise(resolve => setImmediate(resolve));
  b.requests[0].reject(new Error('离线')); await failed;
  assert.equal(b.doc._dirty, true);
  assert.equal(b.drafts.list('local')[0].document.html, b.doc.html);
  assert.equal(b.closingIsBlocked(), true);
  const retry = b.saveCurrent();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.closingIsBlocked(), true);
  b.requests[1].complete(2); await retry;
  assert.equal(b.closingIsBlocked(), false);
});

test('会话过期清空工作区前保留原账号草稿，重新登录可恢复且不包含令牌', async () => {
  const b = browser(); b.state.user = { id: 'alice' }; b.state.token = 'must-not-save-token';
  const saving = b.saveCurrent(), failed = assert.rejects(saving, /会话过期/);
  await new Promise(resolve => setImmediate(resolve));
  b.requests[0].unauthorized(); await failed;
  assert.equal(b.state.doc, null); assert.equal(b.state.documents.length, 0);
  const drafts = b.drafts.list('alice'); assert.equal(drafts.length, 1);
  assert.equal(drafts[0].document.html, '<p>原文</p>');
  assert.ok(!JSON.stringify(drafts).includes('must-not-save-token'));
  assert.equal(b.drafts.list('bob').length, 0);
});

test('浏览器存储被禁用时，会话过期在原页面保留可供原账号恢复的草稿', async () => {
  const b = browser({ storageUnavailable: true });
  b.state.user = { id: 'alice' }; b.state.token = 'old';
  const saving = b.saveCurrent(), failed = assert.rejects(saving, /会话过期/);
  await new Promise(resolve => setImmediate(resolve));
  b.requests[0].unauthorized(); await failed;
  assert.equal(b.state.doc, null);
  assert.equal(b.drafts.list('alice')[0].document.html, b.doc.html);
  assert.equal(b.drafts.list('bob').length, 0);
  assert.equal(b.closingIsBlocked(), true);
});

test('单机服务换令牌后重试原保存和版本，后续编辑依然作为独立修改', async () => {
  const b = browser(); b.state.token = 'before-restart';
  const saving = b.saveCurrent();
  await new Promise(resolve => setImmediate(resolve));
  b.requests[0].tokenChanged();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.requests[1].path, '/api/bootstrap');
  b.doc.sources.push({ id: 'new-source', name: '新资料', text: '追加', enabled: true });
  b.doc._dirty = true;
  b.requests[1].bootstrap(null, 'after-restart');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.requests[2].token, 'after-restart');
  assert.deepEqual(b.requests[2].body, b.requests[0].body);
  b.requests[2].complete(2); await saving;
  assert.equal(b.doc._dirty, true);
  assert.equal(b.drafts.list('local')[0].document.sources[0].id, 'new-source');
});

test('令牌更新后若文档版本冲突，保留修改和原版本；账号切换时不重发正文', async () => {
  for (const user of [{ id: 'alice' }, { id: 'bob' }]) {
    const b = browser(); b.state.user = { id: 'alice' }; b.state.token = 'before';
    const saving = b.saveCurrent();
    const failed = assert.rejects(saving, user.id === 'alice' ? /版本发生变化/ : /账号已切换/);
    await new Promise(resolve => setImmediate(resolve));
    b.requests[0].tokenChanged();
    await new Promise(resolve => setImmediate(resolve));
    b.requests[1].bootstrap(user, 'after');
    await new Promise(resolve => setImmediate(resolve));
    if (user.id === 'alice') {
      assert.equal(b.requests[2].body.revision, 1);
      b.requests[2].conflict();
    } else {
      assert.equal(b.requests.length, 2);
      assert.equal(b.state.doc, null);
    }
    await failed;
    assert.equal(b.drafts.list('alice')[0].document.html, b.doc.html);
  }
});

test('恢复其他草稿期间保留未保存和保存中的文档，服务器新版本不改写本地保存基线', async () => {
  const b = browser();
  const saving = b.saveCurrent();
  await new Promise(resolve => setImmediate(resolve));
  b.refreshDocuments([{ id: 'copy', html: '<p>恢复副本</p>', revision: 1 }, { id: b.doc.id, html: '<p>服务器的新版本</p>', revision: 2 }]);
  assert.equal(b.state.doc, b.doc);
  assert.equal(b.doc.revision, 1);
  assert.equal(b.state.documents.length, 2);
  b.doc.html = '<p>继续编辑</p>'; b.doc._dirty = true;
  b.requests[0].complete(2); await saving;
  b.refreshDocuments([{ id: 'copy', html: '<p>恢复副本</p>', revision: 1 }]);
  assert.equal(b.state.doc.html, '<p>继续编辑</p>');
  assert.equal(b.closingIsBlocked(), true);
});

test('仅在当前内容与成功恢复的草稿一致时才退出未保存状态', () => {
  const b = browser();
  const restored = structuredClone(b.doc);
  const saved = { id: b.doc.id, html: '<p>服务器的新版本</p>', revision: 2 };
  b.doc.html = '<p>恢复预览后继续编辑</p>';
  b.refreshDocuments([saved], restored);
  assert.equal(b.state.doc, b.doc);
  assert.equal(b.closingIsBlocked(), true);
  b.refreshDocuments([saved], structuredClone(b.doc));
  assert.equal(b.state.doc, saved);
  assert.equal(b.closingIsBlocked(), false);
});

test('保存中继续编辑按新版本排队提交，旧响应不能清除新修改', async () => {
  const b = browser(), first = b.saveCurrent();
  await new Promise(resolve => setImmediate(resolve));
  b.doc.html = '<p>继续编辑</p>'; b.doc._dirty = true;
  const second = b.saveCurrent();
  b.requests[0].complete(2); await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.requests[1].body.html, '<p>继续编辑</p>');
  assert.equal(b.requests[1].body.revision, 2);
  assert.equal(b.closingIsBlocked(), true);
  b.requests[1].complete(3); await second;
  assert.equal(b.doc.revision, 3);
  assert.equal(b.closingIsBlocked(), false);
});
