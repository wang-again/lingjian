import {trackAiEdit, aiUndoInput} from './lib/ai-edits.mjs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createStore } from './lib/store.mjs';
import { templates } from './lib/templates.mjs';
import { normalizeBrief } from './lib/document-brief.mjs';
import { distillTemplate } from './lib/template-distill.mjs';
import { buildEvidenceLedger } from './lib/evidence.mjs';
import { runDeliveryCheck, trackDeliveryIssues } from './lib/delivery-check.mjs';
import { updateAnnotations } from './lib/annotations.mjs';
import { sectionMap, moveSection, removeSection, insertSection } from './lib/sections.mjs';
import { normalizeTasks, normalizeLocks, nextQueued, resolveTaskSection, scopedDocument, chapterInstruction, applyChapterResult, applyWholeResult } from './lib/chapter-tasks.mjs';
import { normalizeProject, addProjectSources, searchProject, mergeSources, PROJECT_LIMITS } from './lib/projects.mjs';
import { runBatchAudit, BATCH_LIMIT } from './lib/batch-audit.mjs';
import { validateRecipe, builtinRecipes, recipeFromTasks, tasksFromRecipe, RECIPE_LIMIT } from './lib/recipes.mjs';
import { UserError, validateProvider, runModel, endpointFor, listProviderModels, connectionDiagnostic } from './lib/providers.mjs';
import { providerPresets } from './lib/provider-presets.mjs';
import { createDocx } from './lib/docx.mjs';
import { runWritingTask } from './lib/writing.mjs';
import { skillCatalog } from './lib/skills.mjs';
import { OfficeService } from './lib/office.mjs';
import { handleOffice } from './lib/office-http.mjs';
import { handleTemplates } from './lib/template-http.mjs';
import { Accounts, KeyVault } from './lib/accounts.mjs';
import { acquireDataLock } from './lib/data-lock.mjs';
import { handleAdmin } from './lib/admin-http.mjs';
import { backupLimit, createBackupManager } from './lib/backups.mjs';
import { openEventStream } from './lib/sse.mjs';
import { configuredPort, loadProjectEnv } from './lib/runtime.mjs';
import { createAssetIndex, serveAsset } from './lib/static-assets.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const maxBody = 3_000_000;
// Document text can use up to six JSON bytes per UTF-16 code unit.
const maxDocumentBody = 10_000_000;
const idValid = id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id);
function string(value, max, label) {
  if (typeof value !== 'string' || value.length > max) throw new UserError(`${label}格式不正确或超过长度限制。`);
  return value;
}
function validateDocument(input, previous, { customTemplates = [] } = {}) {
  const title = string(input.title, 200, '标题').trim() || '未命名文档';
  const html = string(input.html, 1_000_000, '正文');
  if (!Array.isArray(input.sources) || input.sources.length > 20) throw new UserError('每篇文档最多添加 20 份参考资料。');
  const sources = input.sources.map(source => ({ id: idValid(source.id) ? source.id : crypto.randomUUID(), name: string(source.name, 200, '资料名称'), text: string(source.text, 300_000, '资料内容'), enabled: source.enabled !== false }));
  if (sources.reduce((sum, item) => sum + item.text.length, 0) > 500_000) throw new UserError('单篇文档参考资料总量不能超过 50 万字符。');
  // 简报可以留空；省略该字段时保留上一次的值，避免旧客户端保存时把简报清掉。
  const brief = input.brief === undefined ? previous?.brief ?? null : normalizeBrief(input.brief);
  const knownTemplate = templates.some(item => item.id === input.templateId) || customTemplates.some(item => item.id === input.templateId);
  const templateId = knownTemplate ? input.templateId : null;
  const history = [...(previous?.history || [])];
  if (!input.aiCheckpoint && input.snapshot && previous && (previous.html !== html || previous.title !== title)) {
    history.unshift({ id: crypto.randomUUID(), title: previous.title, html: previous.html, at: new Date().toISOString(), label: String(input.snapshot).slice(0, 80) });
  }
  // 任务队列、章节锁定和项目归属由专用接口维护：保存正文时不能由旧客户端带着旧值覆盖，
  // 因此这里一律沿用上一次的值，而不是读取请求体。
  const tasks = Array.isArray(previous?.tasks) ? previous.tasks : [];
  const locks = previous?.locks && typeof previous.locks === 'object' ? previous.locks : {};
  const projectId = previous?.projectId || null;
  const annotations = previous?.annotations || [];
  return trackAiEdit(previous, { id: previous?.id || crypto.randomUUID(), title, html, templateId, brief: brief || null, sources, history: history.slice(0, 20), revision: (previous?.revision || 0) + 1, createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), evidence: previous?.evidence || null, delivery: previous?.delivery || null, annotations, tasks, locks, projectId }, input.aiCheckpoint);
}
function validateCustomTemplate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UserError('模板格式不正确。');
  const title = string(input.title, 80, '模板名称').trim();
  if (!title) throw new UserError('请填写模板名称。');
  if (!Array.isArray(input.sections) || !input.sections.length || input.sections.length > 30) throw new UserError('模板应包含 1–30 个章节。');
  const sections = input.sections.map(section => {
    if (typeof section !== 'string' || !section.trim() || section.length > 100) throw new UserError('章节名称应为 1–100 字。');
    return section.trim();
  });
  const content = string(input.content, 100_000, '模板正文').trim();
  if (!content) throw new UserError('模板正文不能为空。');
  const description = string(input.description ?? '', 500, '模板说明').trim();
  const rules = string(input.rules ?? '', 2000, '模板写作规范').trim();
  const variables = Array.isArray(input.variables) ? input.variables.slice(0, 30).map(item => ({
    name: string(item?.name, 60, '变量名').trim(),
    section: typeof item?.section === 'string' ? item.section.slice(0, 100) : ''
  })).filter(item => item.name) : [];
  const origin = input.origin && typeof input.origin === 'object' ? input.origin : {};
  const samples = Array.isArray(origin.samples) ? origin.samples.slice(0, 5).map(item => ({
    id: idValid(item?.id) ? item.id : '',
    title: string(item?.title ?? '', 200, '范文名称').trim()
  })).filter(item => item.title) : [];
  const confidence = Number.isFinite(origin.confidence) ? Math.max(0, Math.min(100, Math.round(origin.confidence))) : null;
  const usage = Array.isArray(input.usage)
    ? input.usage.slice(0, 8).map(item => string(item, 200, '使用说明').trim()).filter(Boolean)
    : [];
  return {
    title, category: '我的模板',
    subtitle: string(input.subtitle ?? '', 200, '副标题').trim() || `我的结构模板 · ${sections.length} 个章节`,
    description: description || '根据自己提供的范文提炼的私有结构模板。',
    rules: rules || '按章节顺序写作；缺少的数据标注“待补充”，不虚构。',
    sections, content, variables,
    language: '中文', editorLabel: '使用我的模板',
    usage: usage.length ? usage : ['核对章节与表格列是否符合本次用途。', '补充文档简报后再起草。', '交付前运行交付体检。'],
    assets: [{ id: 'markdown', format: 'MD', label: '中文 Markdown 模板', generated: true }],
    color: 'sand', tag: '我的模板',
    origin: { kind: 'distilled', createdAt: new Date().toISOString(), samples, confidence },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}
async function readJson(req, limit = maxBody) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new UserError('请求需要使用 JSON 格式。', 415);
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new UserError('请求内容过大。', 413);
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new UserError('JSON 格式不正确。'); }
}

export async function createApp({ dataDir = join(root, '.data'), port = Number(process.env.PORT || 3210), authMode = process.env.LINGJIAN_AUTH_MODE || 'local', listenHost = process.env.HOST || '127.0.0.1', publicOrigin = process.env.APP_ORIGIN || '', registration = process.env.ALLOW_REGISTRATION !== '0', inviteCode = process.env.REGISTRATION_INVITE_CODE || '', keyEncryptionKey = process.env.LINGJIAN_KEY_ENCRYPTION_KEY || '', modelAllowedHosts = process.env.MODEL_ALLOWED_HOSTS || '', sessionOptions = {} } = {}) {
  if (!['accounts', 'local'].includes(authMode)) throw new Error('LINGJIAN_AUTH_MODE 仅支持 accounts 或 local。');
  const remote = !['127.0.0.1', 'localhost', '::1'].includes(listenHost);
  if (authMode === 'local' && (remote || publicOrigin)) throw new Error('单机模式禁止对外监听或设置公网地址，请使用账号模式。');
  let configuredOrigin;
  if (publicOrigin) {
    configuredOrigin = new URL(publicOrigin);
    if (configuredOrigin.protocol !== 'https:' || configuredOrigin.username || configuredOrigin.password || configuredOrigin.search || configuredOrigin.hash || configuredOrigin.pathname !== '/') throw new Error('APP_ORIGIN 必须为完整的 HTTPS 站点来源，如 https://docs.example.com。');
  }
  if (remote && !configuredOrigin) throw new Error('对外监听时必须设置 APP_ORIGIN 为实际 HTTPS 域名，并配置 HTTPS 反向代理。');
  if (configuredOrigin && registration && !inviteCode) throw new Error('对外开放注册时必须设置 REGISTRATION_INVITE_CODE；也可设置 ALLOW_REGISTRATION=0。');
  const allowedHosts = new Set([...providerPresets.map(item => new URL(item.baseUrl).hostname), 'api.openai.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com', ...modelAllowedHosts.split(',').map(item => item.trim().toLowerCase()).filter(Boolean)]);
  const assertProvider = config => {
    const url = new URL(config.baseUrl);
    if (configuredOrigin && (url.protocol !== 'https:' || url.port && url.port !== '443' || !allowedHosts.has(url.hostname))) throw new UserError('服务器模式仅允许管理员授权的 HTTPS 模型域名，请联系管理员配置 MODEL_ALLOWED_HOSTS。', 403);
  };
  const master = keyEncryptionKey ? Buffer.from(keyEncryptionKey, 'base64') : null;
  if (master && (master.length !== 32 || master.toString('base64') !== keyEncryptionKey)) throw new Error('LINGJIAN_KEY_ENCRYPTION_KEY 必须为 32 字节随机密钥的标准 Base64 编码。');
  const releaseLock = await acquireDataLock(dataDir);
  // 启动时扫描一次 public/：新增页面或脚本无需再改第二处映射表。
  const assets = await createAssetIndex(join(root, 'public'));
  let accounts;
  try { accounts = authMode === 'accounts' ? await new Accounts(dataDir, { registration, inviteCode, ...sessionOptions }).init() : null; }
  catch (error) { await releaseLock(); throw error; }
  const contexts = new Map(), recoveryNotified = new WeakSet();
  const contextFor = async userId => {
    if (!contexts.has(userId)) contexts.set(userId, (async () => {
      const directory = userId === 'local' ? dataDir : join(dataDir, 'users', userId);
      const store = await createStore(directory), office = new OfficeService(directory);
      if (store.recovered) console.warn(`[工作区] 无法解析 ${store.recovered.file}（${store.recovered.reason}），已隔离为 ${store.recovered.backup}。`);
      const vault = await new KeyVault(join(directory, 'keys.json'), userId, master).init();
      return { store, office, vault, backups: createBackupManager(store, (input, previous) => validateDocument(input, previous, { customTemplates: store.state.customTemplates || [] })) };
    })().catch(error => { contexts.delete(userId); throw error; }));
    return contexts.get(userId);
  };
  let local;
  try { local = accounts ? null : await contextFor('local'); }
  catch (error) { accounts?.close(); await releaseLock(); throw error; }
  const localSession = { user: null, token: crypto.randomUUID(), keys: new Map() };
  let totalActive = 0;
  const activeByUser = new Map(), pendingRequests = new Set(), runningTasks = new Set();
  const handleRequest = async (req, res) => {
    // 每个请求一个短编号：500 时同时写进日志和响应，用户报错时可直接对号。
    // 编号必须在 try 内生成：它一旦抛错，响应就永远不会发出去。
    let requestId = '';
    const requestPath = String(req.url || '/').split('?')[0].slice(0, 200);
    let releaseWork = () => {};
    const requestAbort = new AbortController();
    res.once('close', () => { if (!res.writableEnded) requestAbort.abort(); });
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (configuredOrigin) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      requestId = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
      const host = req.headers.host;
      const actualPort = server.address()?.port;
      const origins = configuredOrigin ? [configuredOrigin.origin] : [`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`];
      if (!origins.some(origin => new URL(origin).host === host)) throw new UserError('请求地址不受信任，请使用配置的工作台地址。', 403);
      if (req.headers.origin && !origins.includes(req.headers.origin)) throw new UserError('请求来源不受信任。', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new UserError('请求来源不受信任。', 403);
      const url = new URL(req.url, origins[0]), path = url.pathname;
      const name = assets.get(path);
      if (req.method === 'GET' && name) return serveAsset(req, res, join(root, 'public', name), name);
      if (!path.startsWith('/api/')) throw new UserError('没有找到这个地址。', 404);
      const cookie = (value, maxAge) => res.setHeader('Set-Cookie', `lingjian_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${configuredOrigin ? '; Secure' : ''}`);
      if (req.method === 'GET' && path === '/api/auth/status') return send(200, { mode: authMode, registration: Boolean(accounts?.registration), inviteRequired: Boolean(inviteCode) });
      if (accounts && req.method === 'POST' && ['/api/auth/login', '/api/auth/register'].includes(path)) {
        const result = await accounts.signIn(await readJson(req, 4000), { register: path.endsWith('/register'), address: req.socket.remoteAddress });
        const previous = accounts.authenticate(req.headers.cookie); if (previous) accounts.logout(previous);
        cookie(result.cookie, Math.floor(accounts.sessionMs / 1000));
        return send(200, { user: result.session.user });
      }
      const session = accounts ? accounts.authenticate(req.headers.cookie) : localSession;
      if (!session) { cookie('', 0); throw new UserError('请登录；会话过期后需要重新填写未记住的密钥。', 401); }
      if (req.method !== 'GET' && req.headers['x-workspace-token'] !== session.token) {
        return send(403, { error: '工作区会话已更新，请重试保存或刷新页面。', code: 'WORKSPACE_TOKEN_CHANGED' });
      }
      if (accounts && req.method === 'POST' && path === '/api/auth/logout') {
        cookie('', 0); send(200, { ok: true }); accounts.logout(session); return;
      }
      if (accounts) {
        accounts.limit(`api:${session.user.id}`, 300, 60_000);
        const expensive = req.method !== 'GET' && /\/api\/(generate|providers\/(test|models)|office\/(agent|call|extract|upload|review\/apply))$/.test(path);
        if (expensive) {
          accounts.limit(`work:${session.user.id}`, 30, 60_000);
          const userId = session.user.id, activeForUser = activeByUser.get(userId) || 0;
          if (activeForUser >= 2 || totalActive >= 16) throw new UserError('正在处理其他任务，请稍后再试。', 429);
          activeByUser.set(userId, activeForUser + 1); totalActive++;
          releaseWork = () => { const remaining = activeByUser.get(userId) - 1; if (remaining) activeByUser.set(userId, remaining); else activeByUser.delete(userId); totalActive--; };
        }
        const cancel = () => { requestAbort.abort(); if (!res.writableEnded) res.destroy(); };
        session.abort.signal.addEventListener('abort', cancel, { once: true });
        res.once('close', () => session.abort.signal.removeEventListener('abort', cancel));
      }
      if(await handleAdmin({req,url,send,readJson,accounts,session,dataDir,activeByUser,activeCount:() => totalActive}))return;
      const { store, office, vault, backups } = await contextFor(session.user?.id || 'local');
      if (requestAbort.signal.aborted || session.abort?.signal.aborted) throw new UserError('会话已结束。', 401);
      // 项目资料与会话内的文档资料合并后交给写作、依据与体检，保证三处看到同一份资料集合。
      const projectFor = document => (store.state.projects || []).find(item => item.id === document?.projectId) || null;
      const withProjectSources = document => ({ ...document, sources: mergeSources(document.sources, projectFor(document)) });
      const recipeList = () => [...builtinRecipes(), ...(store.state.recipes || [])];
      const token = session.token, secrets = new Map();
      for (const provider of store.state.providers) {
        const origin = new URL(provider.baseUrl).origin, credential = session.keys.get(provider.id);
        let key = credential?.origin === origin ? credential.key : '';
        if (!key) { try { key = vault.get(provider.id, origin); } catch (error) { if (!(error instanceof UserError)) throw error; } }
        if (key) secrets.set(provider.id, key);
      }
      const publicProvider = provider => ({ ...provider, hasKey: secrets.has(provider.id), keySaved: vault.has(provider.id) });
      const keyFor = (input, config) => {
        assertProvider(config);
        const supplied = input.apiKey === undefined ? '' : string(input.apiKey, 4000, 'API 密钥').trim();
        if (supplied) return supplied;
        const origin = new URL(config.baseUrl).origin, credential = session.keys.get(config.id);
        const boundOrigin = credential?.origin || (vault.has(config.id) ? vault.entries[config.id].origin : null);
        if (boundOrigin && boundOrigin !== origin) throw new UserError('API 地址的来源已变更，请重新填写密钥，避免把原服务的密钥发送到其他地址。');
        return credential?.key || vault.get(config.id, origin) || '';
      };
      if (await handleTemplates({req,res,url,send,readJson,office,customTemplates:store.state.customTemplates||[]})) return;
      if (await handleOffice({req,res,url,send,readJson,office,providers:store.state.providers,secrets,documents:store.state.documents,assertProvider,keyForProvider: config => keyFor({}, config)})) return;
      if (req.method === 'GET' && path === '/api/bootstrap') {
        // 工作区解析失败时已隔离原文件；这里把备份路径提示一次，避免用户以为数据凭空消失。
        const notice = store.recovered && !recoveryNotified.has(store)
          ? (recoveryNotified.add(store), `工作区文件无法解析，已另存为 ${store.recovered.backup}，本次以空白文档启动。请保留该文件以便恢复。`)
          : undefined;
        return send(200, { token, user: session.user, canRememberKeys: Boolean(master), documents: store.state.documents, providers: store.state.providers.map(publicProvider), providerPresets, skills: skillCatalog, activeProviderId: store.state.activeProviderId, templates: [...templates, ...(store.state.customTemplates || [])], projects: store.state.projects || [], recipes: [...builtinRecipes(), ...(store.state.recipes || [])], lastAudit: store.state.lastAudit || null, ...(notice ? { notice } : {}) });
      }
      if (req.method === 'POST' && path === '/api/templates/distill') {
        const input = await readJson(req, 2_000_000);
        if (!Array.isArray(input.documentIds) || !input.documentIds.length || input.documentIds.length > 5 || input.documentIds.some(id => !idValid(id))) throw new UserError('请选择 1–5 篇自己的文档作为范文。');
        const unique = [...new Set(input.documentIds)];
        const samples = unique.map(id => store.state.documents.find(document => document.id === id));
        if (samples.some(item => !item)) throw new UserError('部分范文已不存在，请刷新后重选。', 404);
        if (typeof input.title === 'string' && input.title.length > 80) throw new UserError('模板名称不能超过 80 个字符。');
        if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 500)) throw new UserError('模板说明不能超过 500 个字符。');
        const { template, confidence } = distillTemplate(samples, { title: input.title, description: input.description });
        return send(200, { template, confidence });
      }
      if (req.method === 'POST' && path === '/api/templates') {
        const input = await readJson(req, 500_000);
        const template = validateCustomTemplate(input.template ?? input);
        const customTemplates = store.state.customTemplates || [];
        if (customTemplates.length >= 30) throw new UserError('最多保存 30 份自己的模板。请先删除不再使用的模板。');
        if (customTemplates.some(item => item.title === template.title)) throw new UserError('已有同名模板，请换一个名称。', 409);
        const saved = { ...template, id: `custom-${crypto.randomUUID().slice(0, 8)}` };
        store.state.customTemplates = [...customTemplates, saved];
        await store.persist();
        return send(201, { template: saved, templates: [...templates, ...store.state.customTemplates] });
      }
      if (req.method === 'DELETE' && path.startsWith('/api/templates/custom-')) {
        const id = path.split('/').pop();
        if (!idValid(id)) throw new UserError('模板 ID 不正确。');
        const customTemplates = store.state.customTemplates || [];
        if (!customTemplates.some(item => item.id === id)) throw new UserError('没有找到这份模板。', 404);
        store.state.customTemplates = customTemplates.filter(item => item.id !== id);
        // 删除模板后，已创建的文档仍保留正文，只解除模板关联，避免显示一个不存在的模板名。
        await store.updateDocuments(documents => documents.map(document => document.templateId === id ? { ...document, templateId: null } : document));
        return send(200, { ok: true, templates: [...templates, ...store.state.customTemplates] });
      }
      if (req.method === 'POST' && path === '/api/backups/preview') {
        const input = await readJson(req, backupLimit);
        return send(200, await backups.preview(input?.backup, input?.mode, session.token));
      }
      if (req.method === 'GET' && path.startsWith('/api/backups/snapshots/')) {
        const bytes = await backups.snapshot(path.slice('/api/backups/snapshots/'.length));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="lingjian-before-restore.json"', 'Content-Length': bytes.length });
        return res.end(bytes);
      }
      if (req.method === 'POST' && path === '/api/backups/apply') {
        const input = await readJson(req, 4000);
        return send(200, await backups.apply(input?.planId, session.token));
      }
      if (req.method === 'POST' && path === '/api/providers') {
        const input = await readJson(req), config = validateProvider(input);
        if (!idValid(config.id)) throw new UserError('配置 ID 不正确。');
        endpointFor(config);
        assertProvider(config);
        const existing = store.state.providers.findIndex(item => item.id === config.id);
        if (existing < 0 && store.state.providers.length >= 30) throw new UserError('最多保存 30 个模型配置。');
        const key = input.clearKey ? '' : keyFor(input, config);
        await vault.set(config.id, input.rememberKey && !input.clearKey ? key : '', new URL(config.baseUrl).origin);
        accounts?.forgetKey(session.user.id, config.id);
        session.keys.delete(config.id);
        if (key) session.keys.set(config.id, { key, origin: new URL(config.baseUrl).origin });
        if (key) secrets.set(config.id, key);
        else if (input.clearKey) secrets.delete(config.id);
        if (existing >= 0) store.state.providers[existing] = config; else store.state.providers.push(config);
        store.state.activeProviderId ||= config.id;
        await store.persist(); return send(200, { provider: publicProvider(config), activeProviderId: store.state.activeProviderId });
      }
      if (req.method === 'POST' && path === '/api/providers/models') {
        const input = await readJson(req);
        const config = validateProvider({ ...input, name: input.name || '模型列表', model: input.model || 'model-list' });
        const result = await listProviderModels(config, keyFor(input, config), { signal: requestAbort.signal });
        return send(200, result);
      }
      if (req.method === 'POST' && path === '/api/providers/test') {
        const input = await readJson(req), config = validateProvider(input);
        const key = keyFor(input, config);
        const started = Date.now();
        // Reasoning tokens count toward the output budget too. Respect the
        // configured limit so thinking models can finish even this short probe.
        const text = await runModel(config, key, [{ role: 'user', content: '请只回复：连接成功' }], { signal: requestAbort.signal });
        return send(200, { ok: true, elapsed: Date.now() - started, preview: text.slice(0, 150), diagnostic: connectionDiagnostic(config) });
      }
      if (req.method === 'PUT' && path === '/api/active-provider') {
        const input = await readJson(req);
        if (!store.state.providers.some(item => item.id === input.id)) throw new UserError('模型配置不存在。', 404);
        store.state.activeProviderId = input.id; await store.persist(); return send(200, { ok: true });
      }
      if (req.method === 'DELETE' && /^\/api\/providers\/[a-zA-Z0-9-]{1,80}\/key$/.test(path)) {
        const id = path.split('/')[3];
        const provider = store.state.providers.find(item => item.id === id);
        if (!provider) throw new UserError('模型配置不存在。', 404);
        await vault.set(id, '', ''); accounts?.forgetKey(session.user.id, id); session.keys.delete(id); secrets.delete(id);
        return send(200, { provider: publicProvider(provider) });
      }
      if (req.method === 'DELETE' && path.startsWith('/api/providers/')) {
        const id = path.split('/').pop();
        await vault.set(id, '', ''); accounts?.forgetKey(session.user.id, id); session.keys.delete(id);
        store.state.providers = store.state.providers.filter(item => item.id !== id); secrets.delete(id);
        if (store.state.activeProviderId === id) store.state.activeProviderId = store.state.providers[0]?.id || null;
        await store.persist(); return send(200, { ok: true, activeProviderId: store.state.activeProviderId });
      }
      if (req.method === 'POST' && path === '/api/documents') {
        const document = validateDocument(await readJson(req, maxDocumentBody), undefined, { customTemplates: store.state.customTemplates || [] });
        await store.updateDocuments(documents => {
          if (documents.length >= 200) throw new UserError('本版最多保存 200 篇文档。请先导出并清理不再使用的文档。');
          documents.unshift(document); return documents;
        });
        return send(201, { document });
      }
      // 只匹配 /api/documents/:id 本体；带子路径的请求（locks、tasks、outline…）交给后面的专用分支。
      const documentBodyMatch = /^\/api\/documents\/[a-zA-Z0-9-]{1,80}$/.exec(path);
      if (documentBodyMatch && ['PUT', 'DELETE'].includes(req.method)) {
        const id = path.split('/').pop();
        const deleting = req.method === 'DELETE';
        const input = await readJson(req, deleting ? maxBody : maxDocumentBody);
        if (deleting && !Number.isSafeInteger(input?.revision)) throw new UserError('删除前需要确认文档版本，请刷新页面后重试。');
        let document;
        await store.updateDocuments(documents => {
          const index = documents.findIndex(item => item.id === id);
          if (index < 0) throw new UserError('文档不存在。请刷新页面。', 404);
          const previous = documents[index];
          if (deleting) {
            if (input.revision !== (previous.revision ?? 0)) throw new UserError('文档已在其他窗口更新。请刷新页面，核对最新内容后再确认删除。', 409);
            documents.splice(index, 1);
            return documents;
          }
          if (input.revision !== previous.revision) throw new UserError('文档已在其他窗口更新。请先下载恢复草稿，再刷新页面或恢复为副本。', 409);
          document = input.undoAiEdit ? {...validateDocument(aiUndoInput(previous, input), previous, { customTemplates: store.state.customTemplates || [] }), aiEdit: null} : validateDocument(input, previous, { customTemplates: store.state.customTemplates || [] });
          documents[index] = document; return documents;
        });
        return send(200, deleting ? { ok: true } : { document });
      }
      const qualityMatch = /^\/api\/documents\/([a-zA-Z0-9-]{1,80})\/(evidence|delivery-check)$/.exec(path);
      if (req.method === 'POST' && qualityMatch) {
        const [, id, action] = qualityMatch;
        const input = await readJson(req, 4000);
        let evidence, report, revision;
        await store.updateDocuments(documents => {
          const document = documents.find(item => item.id === id);
          if (!document) throw new UserError('文档不存在。请刷新页面。', 404);
          if (!Number.isSafeInteger(input?.revision) || input.revision !== document.revision) throw new UserError('文档已更新。请等待保存完成后重新检查。', 409);
          evidence = buildEvidenceLedger({ html: document.html, sources: mergeSources(document.sources, projectFor(document)), brief: document.brief || null });
          document.evidence = { ...evidence, forRevision: document.revision };
          if (action === 'delivery-check') {
            const result = runDeliveryCheck({ document: { ...document, sources: mergeSources(document.sources, projectFor(document)) }, ledger: evidence });
            report = document.delivery = trackDeliveryIssues(result, document.delivery, document.revision);
          }
          revision = document.revision;
          return documents;
        });
        return send(200, action === 'delivery-check' ? { report, evidence, forRevision: revision } : { evidence, forRevision: revision });
      }
      // —— 章节工作台：结构读取、章节调整、任务队列 ——
      const idPath = suffix => new RegExp(`^/api/documents/([a-zA-Z0-9-]{1,80})/${suffix}$`);
      const annotationRoute = idPath('annotations(?:/([a-zA-Z0-9-]{1,80}))?').exec(path);
      if (annotationRoute && (annotationRoute[2] ? req.method === 'PATCH' : req.method === 'POST')) {
        const [, documentId, annotationId] = annotationRoute;
        const input = await readJson(req, 16_000);
        let annotations;
        await store.updateDocuments(documents => {
          const document = documents.find(item => item.id === documentId);
          if (!document) throw new UserError('文档不存在。请刷新页面。', 404);
          if (input?.revision !== document.revision) throw new UserError('文档已更新。请等待保存后重新选取原文。', 409);
          annotations = updateAnnotations(document.annotations || [], input, annotationId);
          document.annotations = annotations;
          document.updatedAt = new Date().toISOString();
          return documents;
        });
        return send(200, { annotations });
      }
      const deliveryIssue = idPath('delivery-issues/([a-zA-Z0-9-]{1,80})').exec(path);
      if (req.method === 'PATCH' && deliveryIssue) {
        const [, documentId, issueId] = deliveryIssue;
        const input = await readJson(req, 4000);
        if (typeof input?.confirmed !== 'boolean') throw new UserError('请提交有效的确认状态。');
        let report;
        await store.updateDocuments(documents => {
          const document = documents.find(item => item.id === documentId);
          if (!document) throw new UserError('文档不存在。请刷新页面。', 404);
          report = document.delivery;
          if (!report || report.forRevision !== document.revision || input.at !== report.at) {
            throw new UserError('检查结果已更新。请重新检查后再确认。', 409);
          }
          const issue = report.issues.find(item => item.id === issueId);
          if (!issue) throw new UserError('没有找到这条检查问题。', 404);
          issue.confirmed = input.confirmed;
          return documents;
        });
        return send(200, { report });
      }
      const sectionsMatch = idPath('sections').exec(path);
      if (req.method === 'GET' && sectionsMatch) {
        const document = store.state.documents.find(item => item.id === sectionsMatch[1]);
        if (!document) throw new UserError('文档不存在。请刷新页面。', 404);
        const map = sectionMap(document.html);
        return send(200, { sections: map.sections, level: map.level, words: map.words, locks: document.locks || {}, tasks: document.tasks || [], projectId: document.projectId || null });
      }
      const outlineMatch = idPath('outline').exec(path);
      if (req.method === 'POST' && outlineMatch) {
        const id = outlineMatch[1];
        const input = await readJson(req, 4000);
        let document;
        await store.updateDocuments(documents => {
          const index = documents.findIndex(item => item.id === id);
          if (index < 0) throw new UserError('文档不存在。请刷新页面。', 404);
          const previous = documents[index];
          if (input.revision !== previous.revision) throw new UserError('文档已更新。请等待保存完成后重试。', 409);
          const map = sectionMap(previous.html);
          let html;
          if (input.op === 'move') {
            if (!map.sections.some(section => section.key === input.key)) throw new UserError('没有找到这一章，标题可能已修改。', 404);
            html = moveSection(previous.html, input.key, input.delta > 0 ? 1 : -1);
            if (html === null) throw new UserError('这一章已经在边界位置，不能再移动。', 409);
          } else if (input.op === 'remove') {
            if (!map.sections.some(section => section.key === input.key)) throw new UserError('没有找到这一章，标题可能已修改。', 404);
            html = removeSection(previous.html, input.key);
          } else if (input.op === 'insert') {
            const title = string(input.title, 100, '章节标题').trim();
            if (!title) throw new UserError('请填写章节标题。');
            html = insertSection(previous.html, { afterKey: typeof input.afterKey === 'string' ? input.afterKey : '', title, body: '<p></p>', level: map.level || 2 });
            if (html === null) throw new UserError('没有找到插入位置，请刷新后重试。', 404);
          } else throw new UserError('不支持的章节操作。');
          document = validateDocument({ title: previous.title, html, sources: previous.sources, templateId: previous.templateId, brief: previous.brief, revision: previous.revision, snapshot: input.op === 'insert' ? `新增章节：${input.title}` : `章节调整：${input.op}` }, previous, { customTemplates: store.state.customTemplates || [] });
          // 章节被删或改名后，对应的锁与任务都失效，一并清理，避免留下永远执行不了的任务。
          const keys = new Set(sectionMap(document.html).sections.map(section => section.key));
          document.locks = Object.fromEntries(Object.entries(previous.locks || {}).filter(([key]) => keys.has(key)));
          if (input.op === 'remove') document.tasks = (previous.tasks || []).filter(task => task.chapterKey !== input.key);
          documents[index] = document;
          return documents;
        });
        const map = sectionMap(document.html);
        return send(200, { document, sections: map.sections, level: map.level });
      }
      const locksMatch = idPath('locks').exec(path);
      if (req.method === 'PUT' && locksMatch) {
        const input = await readJson(req, 4000);
        let locks = {};
        await store.updateDocuments(documents => {
          const document = documents.find(item => item.id === locksMatch[1]);
          if (!document) throw new UserError('文档不存在。请刷新页面。', 404);
          document.locks = normalizeLocks(input.locks, document.locks || {});
          locks = document.locks;
          return documents;
        });
        return send(200, { locks });
      }
      const tasksMatch = idPath('tasks').exec(path);
      if (req.method === 'POST' && tasksMatch) {
        const id = tasksMatch[1];
        const input = await readJson(req, 200_000);
        const incoming = Array.isArray(input.tasks) ? input.tasks : [input.task];
        if (!incoming.length || incoming.length > 20) throw new UserError('一次最多排 20 个任务。');
        let tasks = [];
        await store.updateDocuments(documents => {
          const document = documents.find(item => item.id === id);
          if (!document) throw new UserError('文档不存在。请刷新页面。', 404);
          const existing = Array.isArray(document.tasks) ? document.tasks : [];
          if (existing.length + incoming.length > 80) throw new UserError('队列最多 80 个任务，请先清理已完成的任务。');
          document.tasks = normalizeTasks([...existing, ...incoming.map(item => ({ ...item, status: 'queued' }))], existing);
          tasks = document.tasks;
          return documents;
        });
        return send(201, { tasks });
      }
      const taskMatch = /^\/api\/documents\/([a-zA-Z0-9-]{1,80})\/tasks\/(task-[a-zA-Z0-9]{1,20})$/.exec(path);
      if (taskMatch && ['DELETE', 'PATCH'].includes(req.method)) {
        const [, id, taskId] = taskMatch;
        // DELETE 通常不带请求体，只有 PATCH 需要解析状态。
        const input = req.method === 'PATCH' ? await readJson(req, 4000) : {};
        let tasks = [];
        await store.updateDocuments(documents => {
          const document = documents.find(item => item.id === id);
          if (!document) throw new UserError('文档不存在。请刷新页面。', 404);
          const list = Array.isArray(document.tasks) ? document.tasks : [];
          const task = list.find(item => item.id === taskId);
          if (!task) throw new UserError('任务不存在，可能已被删除。', 404);
          if (task.status === 'running') throw new UserError('任务正在执行，请等它结束后再操作。', 409);
          document.tasks = req.method === 'DELETE'
            ? list.filter(item => item.id !== taskId)
            : list.map(item => item.id === taskId ? { ...item, status: input.status === 'skipped' ? 'skipped' : 'queued', message: '', finishedAt: null } : item);
          tasks = document.tasks;
          return documents;
        });
        return send(200, { tasks });
      }
      const runMatch = idPath('tasks/run').exec(path);
      if (req.method === 'POST' && runMatch) {
        const id = runMatch[1];
        const input = await readJson(req, 4000);
        const document = store.state.documents.find(item => item.id === id);
        if (!document) throw new UserError('文档不存在。请刷新页面。', 404);
        if (Number.isSafeInteger(input.revision) && input.revision !== document.revision) throw new UserError('文档已更新。请等待保存完成后重试。', 409);
        const task = input.taskId ? (document.tasks || []).find(item => item.id === input.taskId) : nextQueued(document.tasks || []);
        if (!task) throw new UserError('队列里没有待执行的任务。');
        if (task.status === 'running') throw new UserError('这个任务已经在执行。', 409);
        const guardKey = `${session.user?.id || 'local'}:${id}`;
        if (runningTasks.has(guardKey)) throw new UserError('这篇文档已有任务在执行，等它结束后会自动继续。', 409);
        let config = null, key = '';
        if (task.kind === 'chapter' || task.kind === 'whole') {
          config = store.state.providers.find(item => item.id === (input.providerId || store.state.activeProviderId));
          if (!config) throw new UserError('请先在模型配置里添加一个模型。');
          key = keyFor({}, config);
        }
        const revision = document.revision;
        runningTasks.add(guardKey);
        await store.updateDocuments(documents => {
          const current = documents.find(item => item.id === id);
          if (!current) throw new UserError('文档不存在。', 404);
          if (current.revision !== revision) throw new UserError('文档已更新。请稍后重试。', 409);
          current.tasks = (current.tasks || []).map(item => item.id === task.id ? { ...item, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, message: '', revisionBefore: revision } : item);
          return documents;
        });
        try {
          // 章节存在性与锁定状态在调用模型之前判定；不通过就不消耗一次模型调用。
          let section = null;
          if (task.kind === 'chapter') {
            try { section = resolveTaskSection(document, task); }
            catch (error) { throw new UserError(error.message, 409); }
          }
          let html = null, ledger = null, report = null, message = '';
          if (task.kind === 'chapter' || task.kind === 'whole') {
            const sourceDocument = section ? scopedDocument(withProjectSources(document), section) : withProjectSources(document);
            const prompt = section ? chapterInstruction(section, task.instruction) : (task.instruction || '按文档简报与模板规范重写全文，保留已有事实与数据。');
            const text = await runWritingTask(config, key, sourceDocument, { mode: 'write', prompt, chapterTitle: section?.title || '', documentId: id, revision }, { signal: requestAbort.signal, office, customTemplates: store.state.customTemplates || [] });
            try { html = section ? applyChapterResult(document, section, text) : applyWholeResult(document, text); }
            catch (error) { throw new UserError(error.message, 422); }
            message = section ? `已写入《${section.title}》` : '已重写全文';
          } else if (task.kind === 'evidence' || task.kind === 'check') {
            const scoped = withProjectSources(document);
            ledger = buildEvidenceLedger({ html: document.html, sources: scoped.sources, brief: document.brief || null });
            if (task.kind === 'check') report = runDeliveryCheck({ document: scoped, ledger });
            message = task.kind === 'check' ? `体检完成：${report.grade}` : `核出 ${ledger.summary.total} 条关键说法`;
          } else throw new UserError('不支持的任务类型。');
          let updated;
          await store.updateDocuments(documents => {
            const index = documents.findIndex(item => item.id === id);
            if (index < 0) throw new UserError('文档不存在。', 404);
            const current = documents[index];
            if (current.revision !== revision) throw new UserError('执行期间正文被修改，本次结果未写入。请重试。', 409);
            const next = html
              ? validateDocument({ title: current.title, html, sources: current.sources, templateId: current.templateId, brief: current.brief, revision: current.revision, snapshot: `任务：${task.title}` }, current, { customTemplates: store.state.customTemplates || [] })
              : { ...current };
            next.tasks = (current.tasks || []).map(item => item.id === task.id ? { ...item, status: 'done', finishedAt: new Date().toISOString(), revisionAfter: next.revision, message } : item);
            if (ledger) next.evidence = { ...ledger, forRevision: next.revision };
            if (report) next.delivery = trackDeliveryIssues(report, current.delivery, next.revision);
            documents[index] = next;
            updated = next;
            return documents;
          });
          const map = sectionMap(updated.html);
          return send(200, { task: (updated.tasks || []).find(item => item.id === task.id), document: updated, sections: map.sections, level: map.level, remaining: (updated.tasks || []).filter(item => item.status === 'queued').length });
        } catch (error) {
          // 失败也必须落状态：任务停在 running 会让整条队列再也跑不动。
          await store.updateDocuments(documents => {
            const current = documents.find(item => item.id === id);
            if (!current) return documents;
            const conflict = error instanceof UserError && error.status === 409;
            current.tasks = (current.tasks || []).map(item => item.id === task.id ? { ...item, status: conflict ? 'queued' : 'failed', finishedAt: new Date().toISOString(), message: String(error.message || '执行失败').slice(0, 500) } : item);
            return documents;
          }).catch(() => {});
          throw error;
        } finally { runningTasks.delete(guardKey); }
      }
      // —— 项目知识空间 ——
      if (req.method === 'POST' && path === '/api/projects') {
        const input = await readJson(req, 20_000);
        const projects = store.state.projects || [];
        if (projects.length >= PROJECT_LIMITS.projects) throw new UserError(`最多保存 ${PROJECT_LIMITS.projects} 个项目。`);
        if (projects.some(item => item.name === String(input.name || '').trim())) throw new UserError('已有同名项目，请换一个名称。', 409);
        let project;
        try { project = normalizeProject(input); } catch (error) { throw new UserError(error.message); }
        store.state.projects = [...projects, project];
        await store.persist();
        return send(201, { project, projects: store.state.projects });
      }
      const projectMatch = /^\/api\/projects\/(project-[a-zA-Z0-9-]{1,40})(\/.*)?$/.exec(path);
      if (projectMatch) {
        const project = (store.state.projects || []).find(item => item.id === projectMatch[1]);
        if (!project) throw new UserError('项目不存在，可能已被删除。', 404);
        const rest = projectMatch[2] || '';
        if (req.method === 'PATCH' && !rest) {
          const input = await readJson(req, 20_000);
          const next = { ...project, name: string(input.name ?? project.name, PROJECT_LIMITS.name, '项目名称').trim() || project.name, description: string(input.description ?? project.description ?? '', PROJECT_LIMITS.description, '项目说明').trim(), updatedAt: new Date().toISOString() };
          store.state.projects = store.state.projects.map(item => item.id === project.id ? next : item);
          await store.persist();
          return send(200, { project: next });
        }
        if (req.method === 'DELETE' && !rest) {
          store.state.projects = store.state.projects.filter(item => item.id !== project.id);
          // 解绑文档但保留正文与资料，删项目不应该连带删内容。
          await store.updateDocuments(documents => documents.map(document => document.projectId === project.id ? { ...document, projectId: null } : document));
          return send(200, { ok: true, projects: store.state.projects });
        }
        if (req.method === 'POST' && rest === '/sources') {
          const input = await readJson(req, 2_000_000);
          const sources = Array.isArray(input.sources) ? input.sources : [input];
          if (!sources.length || sources.length > 10) throw new UserError('一次最多添加 10 份资料。');
          let next;
          try { next = addProjectSources(project, sources); } catch (error) { throw new UserError(error.message, error.message.includes('最多') || error.message.includes('不能超过') ? 409 : 400); }
          store.state.projects = store.state.projects.map(item => item.id === project.id ? next : item);
          await store.persist();
          return send(201, { project: next });
        }
        if (req.method === 'DELETE' && /^\/sources\/[a-zA-Z0-9-]{1,80}$/.test(rest)) {
          const sourceId = rest.split('/').pop();
          if (!(project.sources || []).some(item => item.id === sourceId)) throw new UserError('这份资料已不存在。', 404);
          const next = { ...project, sources: project.sources.filter(item => item.id !== sourceId), updatedAt: new Date().toISOString() };
          store.state.projects = store.state.projects.map(item => item.id === project.id ? next : item);
          await store.persist();
          return send(200, { project: next });
        }
        if (req.method === 'POST' && rest === '/search') {
          const input = await readJson(req, 4000);
          const query = string(input.query ?? '', 200, '检索词').trim();
          if (!query) throw new UserError('请填写要查的内容。');
          return send(200, searchProject(project, query, { limit: 12 }));
        }
      }
      const bindMatch = idPath('project').exec(path);
      if (req.method === 'POST' && bindMatch) {
        const input = await readJson(req, 4000);
        const projectId = input.projectId || null;
        if (projectId && !(store.state.projects || []).some(item => item.id === projectId)) throw new UserError('项目不存在。', 404);
        let document;
        await store.updateDocuments(documents => {
          const current = documents.find(item => item.id === bindMatch[1]);
          if (!current) throw new UserError('文档不存在。请刷新页面。', 404);
          current.projectId = projectId;
          document = current;
          return documents;
        });
        return send(200, { document });
      }
      if (req.method === 'POST' && path === '/api/batch-audit') {
        const input = await readJson(req, 4000);
        const ids = Array.isArray(input.ids) ? input.ids.filter(id => idValid(id)) : null;
        if (ids && ids.length > BATCH_LIMIT) throw new UserError(`一次最多审计 ${BATCH_LIMIT} 篇文档。`);
        const report = runBatchAudit({ documents: store.state.documents, ids, projects: store.state.projects || [] });
        store.state.lastAudit = report;
        await store.persist();
        return send(200, { report });
      }
      // —— 任务配方 ——
      if (req.method === 'POST' && path === '/api/recipes') {
        const input = await readJson(req, 100_000);
        const recipes = store.state.recipes || [];
        let recipe;
        try {
          recipe = input.fromDocumentId
            ? recipeFromTasks((store.state.documents.find(item => item.id === input.fromDocumentId)?.tasks) || [], { name: input.name, description: input.description })
            : validateRecipe(input.recipe ?? input);
        } catch (error) { throw new UserError(error.message, 400); }
        if (recipes.length >= RECIPE_LIMIT) throw new UserError(`最多保存 ${RECIPE_LIMIT} 个配方，请先删除不再使用的。`);
        if (recipes.some(item => item.name === recipe.name)) throw new UserError('已有同名配方，请换一个名称。', 409);
        store.state.recipes = [...recipes, recipe];
        await store.persist();
        return send(201, { recipe, recipes: recipeList() });
      }
      const recipeMatch = /^\/api\/recipes\/(recipe-[a-zA-Z0-9-]{1,40})(\/.*)?$/.exec(path);
      if (recipeMatch) {
        const recipe = (store.state.recipes || []).find(item => item.id === recipeMatch[1]);
        if (!recipe) throw new UserError('配方不存在，可能已被删除。', 404);
        if (req.method === 'DELETE' && !recipeMatch[2]) {
          store.state.recipes = store.state.recipes.filter(item => item.id !== recipe.id);
          await store.persist();
          return send(200, { ok: true, recipes: recipeList() });
        }
        if (req.method === 'POST' && recipeMatch[2] === '/apply') {
          const input = await readJson(req, 4000);
          const document = store.state.documents.find(item => item.id === input.documentId);
          if (!document) throw new UserError('文档不存在。请刷新页面。', 404);
          const map = sectionMap(document.html);
          let tasks;
          try { tasks = tasksFromRecipe(recipe, { sections: map.sections }); }
          catch (error) { throw new UserError(error.message, 409); }
          let saved = [];
          await store.updateDocuments(documents => {
            const current = documents.find(item => item.id === document.id);
            if (!current) throw new UserError('文档不存在。', 404);
            const existing = current.tasks || [];
            if (existing.length + tasks.length > 80) throw new UserError('队列最多 80 个任务，请先清理已完成的任务。');
            current.tasks = normalizeTasks([...existing, ...tasks.map(task => ({ ...task, status: 'queued' }))], existing);
            saved = current.tasks;
            return documents;
          });
          return send(201, { tasks: saved, added: tasks.length, recipe });
        }
      }
      if (req.method === 'POST' && path === '/api/generate') {
        const input = await readJson(req), config = store.state.providers.find(item => item.id === input.providerId);
        const document = store.state.documents.find(item => item.id === input.documentId);
        if (!config) throw new UserError('请先添加并选择一个模型配置。');
        assertProvider(config);
        if (!document) throw new UserError('当前文档不存在。', 404);
        if (document.revision !== input.revision) throw new UserError('文档版本发生变化，请保存后重试。', 409);
        const stream = openEventStream(res);
        try {
          const result = await runWritingTask(config, keyFor({}, config), withProjectSources(document), input, { signal: stream.signal, onEvent: stream.event, office, customTemplates: store.state.customTemplates || [] });
          stream.event('done', { ok: true, fileTask: result?.fileTask === true });
        } catch (error) { stream.event('error', { message: error.message }); }
        finally { stream.close(); }
        return;
      }
      if (req.method === 'POST' && path === '/api/export/docx') {
        // PNG export can be larger than the compact images stored in the editor.
        const input = await readJson(req, 24_000_000);
        const buffer = createDocx(string(input.title, 200, '标题'), input.blocks, input.images);
        res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': "attachment; filename=document.docx" });
        return res.end(buffer);
      }
      throw new UserError('没有找到这个地址。', 404);
    } catch (error) {
      const expected = error instanceof UserError;
      if (!res.headersSent && !res.destroyed) {
        send(error.status || 500, expected
          ? { error: error.message, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) }
          : { error: '服务发生错误，请检查终端或重试。', requestId });
      } else res.end();
      // 预期内的业务错误不刷屏；未预期异常必须带堆栈和路径，否则无法排查。
      if (!expected) console.error(`[${requestId}] ${req.method} ${requestPath} 未处理异常：\n${String(error?.stack || error?.message || error).slice(0, 4000)}`);
    } finally { releaseWork(); }
  };
  const server = http.createServer((req, res) => {
    const task = handleRequest(req, res); pendingRequests.add(task);
    // 处理器自身抛错时不会有人再写响应，这里必须留下痕迹，否则请求会一直挂着。
    task.finally(() => pendingRequests.delete(task)).catch(error => {
      console.error(`请求处理未返回响应：${req.method} ${String(req.url || '/').split('?')[0]}\n${String(error?.stack || error).slice(0, 4000)}`);
      if (!res.headersSent && !res.destroyed) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: '服务发生错误，请检查终端或重试。' })); }
      else if (!res.destroyed) res.end();
    });
  });
  const idleWorkers = accounts ? setInterval(() => {
    const online = new Set([...accounts.sessions.values()].map(session => session.user.id));
    for (const [id, pending] of contexts) if (!online.has(id)) pending.then(context => context.office.close()).catch(() => {});
  }, 60_000) : null;
  idleWorkers?.unref();
  const cleanup = () => { clearInterval(idleWorkers); accounts?.close(); localSession.keys.clear(); for (const pending of contexts.values()) pending.then(context => context.office.close()).catch(() => {}); };
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, listenHost, resolve); }); }
  catch (error) { cleanup(); await releaseLock(); throw error; }
  server.on('close', cleanup);
  let closing;
  return { server, store: local?.store, office: local?.office, accounts, url: configuredOrigin?.origin || `http://127.0.0.1:${server.address().port}`, close: () => closing ||= (async () => {
    cleanup(); server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.allSettled([...pendingRequests]); cleanup();
    await releaseLock();
  })() };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  (async () => {
    loadProjectEnv();
    return createApp({ port: configuredPort() });
  })().then(app => {
    console.log(`\n灵笺 · 文档工作台\n${app.url}\n\n${app.accounts ? '账号模式：文档与文件按用户隔离。密钥默认仅保留于登录会话。' : '单机模式：不登录，直接进入工作区；仅允许本机访问。'}按 Ctrl+C 结束服务。\n`);
    const shutdown=()=>{app.close().then(()=>process.exit(0));};
    process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  }).catch(error => { console.error(`启动失败：${error.code === 'EADDRINUSE' ? `${error.port} 端口已被占用。请访问已运行的工作台，或设置 PORT 使用其他端口。` : error.message}`); process.exitCode = 1; });
}
