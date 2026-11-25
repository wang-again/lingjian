// Only document content is retained. Credentials and model settings never enter drafts.
export function sameDraftContent(a, b) {
  return a.title === b.title && a.html === b.html
    && (a.templateId || null) === (b.templateId || null)
    && JSON.stringify(a.sources || []) === JSON.stringify(b.sources || []);
}

export function createRecoveryStore({
  storage = () => globalThis.localStorage,
  session = () => globalThis.sessionStorage,
  tabId = globalThis.crypto.randomUUID()
} = {}) {
  const prefix = owner => `lingjian.recovery.${encodeURIComponent(owner)}.`;
  const key = (owner, doc) => `${prefix(owner)}${tabId}.${doc.id}`;
  const memory = new Map();
  const stores = [storage, session];
  const content = doc => ({ id: doc.id, title: doc.title, html: doc.html, templateId: doc.templateId || null, sources: doc.sources || [], history: doc.history || [], createdAt: doc.createdAt || new Date().toISOString(), updatedAt: doc.updatedAt || new Date().toISOString() });
  function read(getStore, k) {
    try { return getStore().getItem(k); } catch { return null; }
  }
  function save(owner, doc) {
    const k = key(owner, doc);
    const value = JSON.stringify({ document: content(doc), savedAt: new Date().toISOString() });
    try {
      storage().setItem(k, value);
      memory.delete(k);
      try { session().removeItem(k); } catch {}
      return 'local';
    } catch {
      try {
        session().setItem(k, value);
        memory.delete(k);
        return 'session';
      } catch {
        memory.set(k, value);
        return null;
      }
    }
  }
  function acknowledge(owner, doc) {
    try {
      const k = key(owner, doc), raw = current(k);
      if (raw) {
        const saved = JSON.parse(raw).document;
        if (sameDraftContent(saved, doc)) discard(owner, { key: k, raw });
      }
    } catch {}
  }
  function current(k) {
    return memory.get(k) ?? read(session, k) ?? read(storage, k);
  }
  function list(owner) {
    const keys = new Set(memory.keys());
    for (const getStore of stores) {
      try {
        const s = getStore();
        for (let i = 0; i < s.length; i++) keys.add(s.key(i));
      } catch {}
    }
    const result = [];
    for (const k of keys) {
      if (!k?.startsWith(prefix(owner))) continue;
      try {
        const raw = current(k), value = JSON.parse(raw);
        if (typeof value?.document?.title === 'string' && typeof value.document.html === 'string' && typeof value.savedAt === 'string' && Number.isFinite(Date.parse(value.savedAt))) {
          result.push({ document: value.document, savedAt: value.savedAt, key: k, raw });
        }
      } catch {}
    }
    return result.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
  function discard(owner, { key: k, raw }) {
    if (!k.startsWith(prefix(owner)) || current(k) !== raw) return false;
    for (const getStore of stores) {
      try {
        const s = getStore();
        if (s.getItem(k) !== null) s.removeItem(k);
      } catch {
        if (read(getStore, k) !== null) return false;
      }
    }
    memory.delete(k);
    return true;
  }
  const hasVolatile = owner => [...memory.keys()].some(k => k.startsWith(prefix(owner)));
  return { save, acknowledge, list, discard, hasVolatile };
}
