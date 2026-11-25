import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryStore } from '../public/recovery.js';
import { documentBackup } from '../public/backup-ui.js';

function storage() {
  const data = new Map();
  return { get length() { return data.size; }, key: index => [...data.keys()][index], getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), data };
}
const doc = { id: 'doc-one', title: '未保存标题', html: '<p>恢复正文</p>', sources: [{ id: 'source', name: '背景', text: '资料内容', enabled: true }], history: [], createdAt: '2026-11-17T01:00:00Z', updatedAt: '2026-11-17T01:00:00Z', apiKey: 'must-not-persist', _dirty: true };
test('恢复草稿刷新后可见，按账号和窗口隔离，确认保存只清除当前窗口', () => {
  const s = storage(), a = createRecoveryStore({ storage: () => s, tabId: 'a' }), b = createRecoveryStore({ storage: () => s, tabId: 'b' });
  assert.equal(a.save('alice', doc), 'local'); b.save('alice', { ...doc, html: '<p>另一窗口</p>' }); a.save('bob', doc);
  const reload = createRecoveryStore({ storage: () => s, tabId: 'reloaded' });
  assert.equal(reload.list('alice').length, 2); assert.equal(reload.list('bob').length, 1);
  assert.ok(!JSON.stringify([...s.data.values()]).includes('must-not-persist'));
  a.acknowledge('alice', doc);
  assert.equal(a.list('alice').length, 1); assert.match(a.list('alice')[0].document.html, /另一窗口/);
  assert.equal(a.discard('alice', a.list('bob')[0]), false);
  assert.equal(a.list('bob').length, 1);
});
test('较旧确认不能删除新内容，存储被禁用或配额不足时明确返回失败', () => {
  const s = storage(), r = createRecoveryStore({ storage: () => s, tabId: 'a' });
  r.save('alice', doc); r.acknowledge('alice', { ...doc, html: '<p>旧响应</p>' });
  assert.equal(r.list('alice').length, 1);
  const blocked = createRecoveryStore({ storage: () => { throw Error('quota'); }, session: () => null, tabId: 'b' });
  assert.equal(blocked.save('alice', doc), null);
  assert.equal(blocked.list('alice')[0].document.html, doc.html);
  assert.equal(blocked.hasVolatile('alice'), true);
  s.setItem('lingjian.recovery.alice.bad', '{');
  s.setItem('lingjian.recovery.alice.bad-date', JSON.stringify({ document: doc, savedAt: null }));
  assert.equal(r.list('alice').length, 1);
});

test('本地存储满时优先保留此标签页草稿，刷新后可恢复，不会误删更新版本', () => {
  const a = storage(), b = storage();
  const tab = createRecoveryStore({ storage: () => a, session: () => b, tabId: 'tab' });
  tab.save('alice', doc);
  const before = tab.list('alice')[0];
  a.setItem = () => { throw Error('quota'); };
  assert.equal(tab.save('alice', { ...doc, html: '<p>更新草稿</p>' }), 'session');
  const reload = createRecoveryStore({ storage: () => a, session: () => b, tabId: 'reload' });
  assert.equal(reload.list('alice').length, 1);
  assert.equal(reload.list('alice')[0].document.html, '<p>更新草稿</p>');
  assert.equal(reload.discard('alice', before), false);
  assert.equal(reload.discard('alice', reload.list('alice')[0]), true);
  assert.equal(reload.list('alice').length, 0);
});
test('下载备份仅含文档白名单字段，草稿恢复保留资料和历史', () => {
  const result = documentBackup([doc]);
  assert.equal(result.product, 'lingjian'); assert.equal(result.version, 1);
  assert.deepEqual(result.documents[0].sources, doc.sources);
  assert.ok(!JSON.stringify(result).includes('must-not-persist'));
  assert.ok(!JSON.stringify(result).includes('_dirty'));
});
