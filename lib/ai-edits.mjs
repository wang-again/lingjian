import {randomUUID} from 'node:crypto';
import {UserError} from './providers.mjs';

export function trackAiEdit(previous, next, edit) {
  if (!edit) return {...next, aiEdit: previous?.aiEdit || null};
  if (!previous || typeof edit.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(edit.id || '') || !['streaming','complete','interrupted'].includes(edit.status)) throw new UserError('AI 修改记录无效。');
  const current = previous.aiEdit;
  if (current?.id === edit.id) {
    if (current.status !== 'streaming' || current.appliedRevision !== previous.revision) throw new UserError('正文已在本轮 AI 修改之外更新，请保留当前内容并重新生成。', 409);
    return {...next, aiEdit: {...current, status: edit.status, appliedRevision: next.revision}};
  }
  if (next.html === previous.html && next.title === previous.title) return {...next, aiEdit: current || null};
  const snapshot = {id: randomUUID(), title: previous.title, html: previous.html, at: new Date().toISOString(), label: 'AI 修改前'};
  return {...next, history: [snapshot, ...next.history].slice(0,20), aiEdit: {id: edit.id, historyId: snapshot.id, status: edit.status, appliedRevision: next.revision}};
}

export function aiUndoInput(previous, input) {
  const edit = previous.aiEdit;
  if (!edit || input.undoAiEdit !== edit.id) throw new UserError('这轮 AI 修改已变化或已撤回，请刷新后重试。', 409);
  const snapshot = previous.history.find(item => item.id === edit.historyId);
  if (!snapshot) throw new UserError('原文快照已不在历史版本中，无法撤回本轮修改。', 409);
  if (edit.appliedRevision !== previous.revision && input.allowLaterEdits !== true) throw new UserError('AI 修改后还有其他编辑，请确认后再恢复原文。', 409);
  return {...previous, html: snapshot.html, title: snapshot.title, snapshot: '撤回 AI 修改前'};
}
