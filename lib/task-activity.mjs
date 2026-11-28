import { randomUUID } from 'node:crypto';

export function taskActivity(onEvent, label, { status = 'running', ...details } = {}) {
  const id = randomUUID();
  const update = (nextStatus, changes = {}) => onEvent('activity', { id, label, ...details, ...changes, status: nextStatus });
  update(status);
  return update;
}
