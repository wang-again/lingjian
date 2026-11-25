import { providerPresets } from './provider-presets.mjs';

export class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// 超时语义：上游只要还在出数据就不算超时。idleMs 内没有任何新数据才中断；
// totalMs 是兜底上限，避免一直滴数据的异常连接永久占用实例。
export const TOTAL_REQUEST_LIMIT_MS = 30 * 60_000;
const MAX_MODEL_RESPONSE_BYTES = 8_000_000;

async function* boundedResponseChunks(body) {
  let bytes = 0;
  for await (const chunk of body || []) {
    bytes += chunk.byteLength;
    if (bytes > MAX_MODEL_RESPONSE_BYTES) throw new UserError('模型接口返回的数据过大。', 502);
    yield chunk;
  }
}

async function readResponseText(response) {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of boundedResponseChunks(response.body)) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

export function createIdleGuard(idleMs, { totalMs = TOTAL_REQUEST_LIMIT_MS } = {}) {
  const controller = new AbortController();
  const idle = Math.max(1, Number(idleMs) || 1);
  let reason = '', idleTimer;
  const touch = () => {
    if (reason) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!reason) { reason = 'idle'; controller.abort(); } }, idle);
    idleTimer.unref?.();
  };
  const totalTimer = setTimeout(() => { if (!reason) { reason = 'total'; controller.abort(); } }, Math.max(idle, totalMs));
  totalTimer.unref?.();
  touch();
  return {
    signal: controller.signal,
    touch,
    abort: (why = 'cancelled') => { if (!reason) reason = why; controller.abort(); },
    reason: () => reason,
    dispose: () => { clearTimeout(idleTimer); clearTimeout(totalTimer); }
  };
}

function timeoutMessage(config, why) {
  if (why === 'total') return `单次请求超过 ${Math.round(TOTAL_REQUEST_LIMIT_MS / 60_000)} 分钟上限，已中止。长文档请分章处理。`;
  return `已连续 ${config.timeout} 秒没有收到新的数据，已中止。若模型仍在生成，可在高级设置中延长超时或减小输入。`;
}

export function validateProvider(input) {
  const vendor = input.vendor || 'custom';
  if (vendor !== 'custom' && !providerPresets.some(item => item.id === vendor)) throw new UserError('不支持的模型服务商，请选择预设或自定义接口。');
  const name = String(input.name || '').trim();
  const model = String(input.model || '').trim();
  if (!name || name.length > 80) throw new UserError('请填写配置名称（不超过 80 字）。');
  if (!model || model.length > 200) throw new UserError('请填写服务商提供的准确模型 ID。');
  let url;
  try { url = new URL(String(input.baseUrl || '').trim()); } catch { throw new UserError('API 地址需要是完整的 http:// 或 https:// 地址。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new UserError('API 地址仅支持 HTTP/HTTPS，不能包含用户名、密码、查询参数或锚点。');
  const protocol = input.protocol || 'chat';
  if (!['chat', 'responses'].includes(protocol)) throw new UserError('不支持的接口协议。');
  const maxTokens = Number(input.maxTokens ?? 4096);
  const timeout = Number(input.timeout ?? 120);
  const tokenField = input.tokenField || 'max_tokens';
  if (!['max_tokens', 'max_completion_tokens', 'omit'].includes(tokenField)) throw new UserError('输出长度参数不正确。');
  if (!Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 65536) throw new UserError('输出长度应为 128–65536 的整数。');
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 600) throw new UserError('超时应为 10–600 秒的整数。');
  const temperature = input.temperature === '' || input.temperature == null ? null : Number(input.temperature);
  if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new UserError('温度应为 0–2，或留空以使用服务商默认值。');
  return { id: input.id || crypto.randomUUID(), vendor, name, baseUrl: url.href.replace(/\/$/, ''), model, protocol, maxTokens, timeout, tokenField, temperature, stream: input.stream !== false };
}

export function endpointFor(config) {
  const suffix = config.protocol === 'responses' ? '/responses' : '/chat/completions';
  const base = config.baseUrl.replace(/\/+$/, '');
  if (/\/(responses|chat\/completions)$/.test(base)) {
    if (!base.endsWith(suffix)) throw new UserError('完整接口地址与所选协议不匹配。请检查地址或切换协议。');
    return base;
  }
  return `${base}${suffix}`;
}

export function modelsEndpointFor(config) {
  const url = new URL(endpointFor(config).replace(/\/(responses|chat\/completions)$/, '/models'));
  if (config.vendor === 'bailian' && url.pathname.endsWith('/compatible-mode/v1/models')) {
    url.pathname = url.pathname.replace(/\/compatible-mode\/v1\/models$/, '/api/v1/models');
    url.searchParams.set('capabilities', 'TG');
    url.searchParams.set('page_size', '100');
    url.searchParams.set('page_no', '1');
  }
  if (config.vendor === 'siliconflow') url.searchParams.set('sub_type', 'chat');
  return url;
}

export async function listProviderModels(config, key, { signal } = {}) {
  const url = modelsEndpointFor(config);
  const timeoutSeconds = Math.min(config.timeout, 30);
  const timeout = AbortSignal.timeout(timeoutSeconds * 1000);
  const models = new Set();
  let truncated = false, received = 0;
  try {
    for (let page = 1; page <= 20; page++) {
      const response = await fetch(url, {
        redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }
      });
      if (response.status === 404 || response.status === 405) throw new UserError('该地址暂不支持获取模型列表，请使用内置列表或手动填写模型 ID。', 502);
      let json;
      const body = await readResponseText(response);
      try { json = JSON.parse(body); }
      catch { throw new UserError(`模型列表接口返回了非 JSON 数据（HTTP ${response.status}），请检查 API 地址。`, 502); }
      if (!response.ok || json.error) throw new UserError(`获取模型列表失败（HTTP ${response.status}）：${cleanMessage(json.error?.message || json.message || '请检查密钥与模型列表访问权限。', key)}`, 502);
      const rows = json.data ?? json.output?.models;
      if (!Array.isArray(rows)) throw new UserError('接口未返回可识别的模型列表，请使用内置列表或手动填写模型 ID。', 502);
      received += rows.length;
      for (const row of rows) {
        const id = row?.id ?? row?.model;
        if (typeof id === 'string' && id.trim() && id.length <= 200) models.add(id.trim());
      }
      if (!url.searchParams.has('page_no') || !rows.length || received >= Number(json.output?.total || 0)) break;
      if (page === 20) { truncated = true; break; }
      url.searchParams.set('page_no', String(page + 1));
    }
    if (!models.size) throw new UserError('平台没有返回可选模型，请检查账号权限，或使用内置列表及手动模型 ID。', 502);
    return { models: [...models].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })), truncated };
  } catch (error) {
    if (signal?.aborted) throw new UserError('已取消模型列表查询。');
    if (timeout.aborted) throw new UserError(`获取模型列表超过 ${timeoutSeconds} 秒，请稍后重试或使用内置列表。`, 504);
    if (error instanceof UserError) throw error;
    throw new UserError(`无法获取模型列表：${cleanMessage(error.cause?.message || error.message, key)}。可继续使用内置列表或手动填写。`, 502);
  }
}

export function makePayload(config, messages, stream = config.stream) {
  const base = { model: config.model, stream };
  if (config.temperature !== null) base.temperature = config.temperature;
  if (config.protocol === 'responses') {
    const input = messages.map(message => Array.isArray(message.content) ? { ...message, content: message.content.map(part => part.type === 'image_url' ? { type: 'input_image', image_url: part.image_url.url } : { type: 'input_text', text: part.text }) } : message);
    return { ...base, store: false, input, max_output_tokens: config.maxTokens };
  }
  if (config.tokenField !== 'omit') base[config.tokenField] = config.maxTokens;
  return { ...base, messages };
}

// Network chunks may split JSON, UTF-8 characters, CRLFs, or whole SSE events.
export async function* parseSSE(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  function consume(block) {
    return block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
  }
  for await (const chunk of boundedResponseChunks(body)) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 4_000_000) throw new UserError('接口返回了过大的单条流式事件。', 502);
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const data = consume(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      if (data) yield data;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) { const data = consume(buffer); if (data) yield data; }
}

function textFrom(content) {
  return typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text || '').join('') : '';
}

function cleanMessage(message, key) {
  let text = String(message || '服务商未返回错误详情。');
  if (key) text = text.split(key).join('[密钥已隐藏]');
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').slice(0, 800);
}

export function connectionDiagnostic(config, details = {}) {
  return { endpoint: endpointFor(config), model: config.model, protocol: config.protocol, stream: config.stream, ...details };
}

function diagnosticError(config, message, details, status = 502) {
  const error = new UserError(message, status);
  error.diagnostic = connectionDiagnostic(config, details);
  return error;
}

function upstreamError(response, json, config, key) {
  const detail = cleanMessage(json?.error?.message || json?.message || json?.error || '服务商未返回错误详情。', key);
  const rawCode = json?.error?.code || json?.code || json?.error?.type;
  const code = rawCode ? cleanMessage(rawCode, key) : '';
  const requestId = response.headers.get('x-request-id') || response.headers.get('request-id') || response.headers.get('x-siliconcloud-trace-id') || json?.request_id;
  const categories = { 401: 'authentication', 403: 'permission', 404: 'endpoint_or_model', 429: 'quota_or_rate_limit' };
  let hint = ({ 400: '请求参数不被当前模型接受', 401: '密钥无效或与当前地址不匹配', 403: '账号权限、服务开通或余额受限', 404: '接口路径或模型不存在', 429: '触发额度或频率限制' })[response.status] || '服务商请求失败';
  if (response.status === 400 && /(?:only support.*stream|stream.*(?:must|true)|non-streaming|enable_thinking.*stream)/i.test(detail)) hint += '，请启用流式输出后重试';
  if (response.status === 401 && config.vendor === 'bailian') hint += '；请核对北京/新加坡等地域以及按量付费/Coding Plan 密钥与地址是否配套';
  return diagnosticError(config, `${hint}（HTTP ${response.status}）${code ? ` [${code}]` : ''}：${detail}`, {
    category: categories[response.status] || (response.status >= 500 ? 'upstream_service' : 'parameters'), upstreamStatus: response.status,
    ...(code ? { upstreamCode: code } : {}), ...(requestId ? { requestId: cleanMessage(requestId, key).slice(0, 160) } : {})
  });
}

function networkError(error, config, key) {
  const codes = [...new Set([error.code, error.cause?.code, ...(error.cause?.errors || []).map(item => item.code)].filter(Boolean))];
  const code = codes[0] || '';
  const hints = {
    ENOTFOUND: '无法解析 API 域名，请核对地址及 DNS', EAI_AGAIN: 'DNS 解析暂时失败，请检查本机或服务器网络',
    ECONNREFUSED: 'API 地址或代理端口拒绝连接，请核对服务与端口', ECONNRESET: '连接被重置，请检查网络、代理或稍后重试',
    ETIMEDOUT: '连接 API 超时，请检查网络与代理', UND_ERR_CONNECT_TIMEOUT: '连接 API 超时，请检查网络与代理',
    EACCES: '系统或运行环境禁止网络连接，请检查网络访问权限', EPERM: '系统或运行环境禁止网络连接，请检查网络访问权限',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'API 证书链无法验证，请检查代理证书与系统信任配置',
    SELF_SIGNED_CERT_IN_CHAIN: '连接中出现不受信任的证书，请检查代理证书配置',
    DEPTH_ZERO_SELF_SIGNED_CERT: '接口使用了不受信任的自签名证书，请检查证书配置', CERT_HAS_EXPIRED: '接口或代理的 HTTPS 证书已过期'
  };
  const detail = cleanMessage(error.cause?.message || error.message, key);
  return diagnosticError(config, `${hints[code] || '无法连接模型接口，请检查地址、网络与代理'}${code ? `（${code}）` : ''}：${detail}`, { category: 'network', ...(codes.length ? { networkCodes: codes } : {}) });
}

async function providerJson(response, config, key) {
  const body = await readResponseText(response);
  let json;
  try { json = JSON.parse(body); }
  catch {
    if (!response.ok) throw upstreamError(response, { message: body.replace(/<[^>]*>/g, ' ').slice(0, 800) }, config, key);
    throw diagnosticError(config, `接口返回了非 JSON 数据（HTTP ${response.status}）。请填写模型 API 地址，不要填写控制台或聊天网页地址。`, { category: 'invalid_response', upstreamStatus: response.status });
  }
  if (!response.ok || json?.error) throw upstreamError(response, json, config, key);
  if (!json || typeof json !== 'object') throw diagnosticError(config, '接口返回了无效的模型响应，请检查 API 地址与协议。', { category: 'invalid_response', upstreamStatus: response.status });
  return json;
}

// Assemble a Chat tool turn before executing any calls: argument fragments and
// reasoning content must remain complete and in model context, never in the UI.
async function chatToolStream(response, config, key, onActivity = () => {}) {
  let content = '', reasoning = '', hasReasoning = false, completed = false, finishReason = null, usage, size = 0;
  const calls = new Map();
  for await (const data of parseSSE(response.body)) {
    onActivity();
    size += data.length;
    if (size > 2_000_000) throw new UserError('模型工具响应过大，请缩小任务范围。', 502);
    if (data === '[DONE]') { completed = true; continue; }
    let json;
    try { json = JSON.parse(data); } catch { throw new UserError('工具接口返回的流式数据不是合法 JSON。', 502); }
    if (json.error) throw upstreamError(response, json, config, key);
    if (json.usage) usage = json.usage;
    const choice = json.choices?.[0]; if (!choice) continue;
    const delta = choice.delta || {};
    content += textFrom(delta.content);
    if (typeof delta.reasoning_content === 'string') { reasoning += delta.reasoning_content; hasReasoning = true; }
    for (const part of delta.tool_calls || []) {
      const index = part.index ?? 0;
      if (!Number.isInteger(index) || index < 0 || index >= 32) throw new UserError('模型返回了无效的工具调用编号。', 502);
      const call = calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (part.id) call.id = part.id;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments !== undefined) {
        if (typeof part.function.arguments !== 'string') throw new UserError('模型工具参数不是有效的 JSON 文本。', 502);
        call.function.arguments += part.function.arguments;
      }
      calls.set(index, call);
    }
    if (choice.finish_reason) { finishReason = choice.finish_reason; completed = true; }
  }
  if (!completed) throw new UserError('模型工具连接提前结束，未收到完成标记；没有执行未完成的工具调用。', 502);
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (toolCalls.some(call => !call.id || !call.function.name)) throw new UserError('模型返回了不完整的工具调用。', 502);
  return { choices: [{ finish_reason: finishReason, message: { role: 'assistant', content: content || null, ...(hasReasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }], usage };
}

// Chat uses the configured streaming mode; the complete turn is assembled before
// tools run. Responses tool turns retain their supported JSON response format.
export async function modelToolTurn(config, key, conversation, tools, signal) {
  const guard = createIdleGuard(config.timeout * 1000);
  const cancel = () => guard.abort('cancelled');
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) guard.abort('cancelled');
  const payload = makePayload(config, conversation, config.protocol === 'chat' && config.stream !== false);
  const requestConfig = { ...config, stream: payload.stream };
  payload.tools = tools.map(tool => config.protocol === 'responses'
    ? { type:'function', name:tool.name, description:tool.description.slice(0,1800), parameters:tool.inputSchema, strict:false }
    : { type:'function', function:{name:tool.name, description:tool.description.slice(0,1800), parameters:tool.inputSchema} });
  try {
    const response = await fetch(endpointFor(config), {
      method:'POST', redirect:'error', signal: guard.signal,
      headers:{'Content-Type':'application/json', ...(key ? {Authorization:`Bearer ${key}`} : {})}, body:JSON.stringify(payload)
    });
    const json = response.ok && response.headers.get('content-type')?.includes('text/event-stream') && config.protocol === 'chat'
      ? await chatToolStream(response, requestConfig, key, guard.touch) : await providerJson(response, requestConfig, key);
    if (config.protocol === 'responses') {
      if (json.status && json.status !== 'completed') throw new UserError(`模型响应未完成：${json.incomplete_details?.reason || json.status}`,502);
      return { text:json.output_text || (json.output || []).filter(item=>item.type==='message').map(item=>textFrom(item.content)).join(''), calls:(json.output || []).filter(item=>item.type==='function_call').map(item=>({id:item.call_id,name:item.name,arguments:item.arguments})), append:json.output || [], usage:json.usage };
    }
    const choice = json.choices?.[0], message = choice?.message;
    if (choice?.finish_reason === 'length') throw new UserError('模型输出或工具参数达到长度上限，请提高输出长度或缩小任务。',502);
    if (choice?.finish_reason === 'content_filter') throw new UserError('内容被服务商过滤，工具规划未完成。',502);
    if (!message) throw new UserError('接口未返回有效的工具调用响应。',502);
    // DeepSeek and other thinking models require this field on later tool turns.
    // Keep it in model context only; the UI receives the final content separately.
    return {text:textFrom(message.content), calls:(message.tool_calls || []).map(call=>({id:call.id,name:call.function?.name,arguments:call.function?.arguments})), append:[{role:'assistant',content:message.content || null,...(typeof message.reasoning_content === 'string' ? {reasoning_content:message.reasoning_content} : {}),...(message.tool_calls?.length ? {tool_calls:message.tool_calls} : {})}],usage:json.usage};
  } catch (error) {
    const why = guard.reason();
    if (why === 'cancelled') throw new UserError('任务已停止，已经执行的文件操作会保留。',499);
    if (why === 'idle' || why === 'total') throw new UserError(timeoutMessage(config, why), 504);
    if (error instanceof UserError) throw error;
    throw networkError(error, requestConfig, key);
  } finally {
    guard.dispose();
    signal?.removeEventListener('abort', cancel);
  }
}

export async function runModel(config, key, messages, { signal, onDelta = () => {}, onUsage = () => {}, onProgress = () => {}, stream = config.stream } = {}) {
  const requestConfig = { ...config, stream };
  const guard = createIdleGuard(config.timeout * 1000);
  const cancel = () => guard.abort('cancelled');
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) guard.abort('cancelled');
  let total = '';
  let thinkingReported = false;
  const add = text => {
    if (!text) return;
    total += text;
    if (total.length > 300_000) throw new UserError('生成内容超过本版单次 30 万字符限制，请分章编写。', 502);
    onDelta(text);
  };
  try {
    const response = await fetch(endpointFor(config), {
      method: 'POST', redirect: 'error', signal: guard.signal,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(makePayload(config, messages, stream))
    });
    if (!response.ok) await providerJson(response, requestConfig, key);
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const json = await providerJson(response, requestConfig, key);
      if (config.protocol === 'responses') {
        if (['failed', 'incomplete', 'cancelled'].includes(json.status)) throw new UserError(`响应未完成：${cleanMessage(json.error?.message || json.incomplete_details?.reason || json.status, key)}`, 502);
        add(json.output_text || (json.output || []).filter(item => item.type === 'message').map(item => textFrom(item.content)).join(''));
      } else {
        const choice = json.choices?.[0];
        add(textFrom(choice?.message?.content));
        if (choice?.finish_reason === 'length') throw new UserError('输出达到长度上限，内容尚未完成。请增加输出长度或缩小写作范围。', 502);
        if (choice?.finish_reason === 'content_filter') throw new UserError('内容被服务商过滤，生成未完成。', 502);
      }
      if (json.usage) onUsage(json.usage);
    } else {
      let completed = false;
      for await (const data of parseSSE(response.body)) {
        guard.touch();
        if (data === '[DONE]') { completed = true; continue; }
        let event;
        try { event = JSON.parse(data); } catch { throw new UserError('接口返回的流式数据不是合法 JSON。', 502); }
        if (event.error || event.type === 'error' || event.type === 'response.failed') throw new UserError(cleanMessage(event.error?.message || event.message || event.response?.error?.message, key), 502);
        if (config.protocol === 'responses') {
          if (event.type === 'response.output_text.delta') add(event.delta);
          if (event.type === 'response.completed') { completed = true; if (event.response?.usage) onUsage(event.response.usage); }
          if (event.type === 'response.incomplete') throw new UserError(`输出未完成：${event.response?.incomplete_details?.reason || '达到服务商限制'}。请增加输出长度或分章生成。`, 502);
        } else {
          const choice = event.choices?.[0];
          if (!thinkingReported && !total && choice?.delta?.reasoning_content) { thinkingReported = true; onProgress('thinking'); }
          add(textFrom(choice?.delta?.content));
          if (choice?.finish_reason === 'length') throw new UserError('输出达到长度上限，内容尚未完成。请增加输出长度或分章生成。', 502);
          if (choice?.finish_reason === 'content_filter') throw new UserError('内容被服务商过滤，生成未完成。', 502);
          if (choice?.finish_reason === 'stop') completed = true;
          if (event.usage) onUsage(event.usage);
        }
      }
      if (!completed) throw new UserError('连接提前结束，未收到完成标记。已接收的文字仅作为未完成草稿。', 502);
    }
    if (!total.trim()) throw new UserError('接口没有返回可用正文。请检查模型、协议和输出长度设置。', 502);
    return total;
  } catch (error) {
    const why = guard.reason();
    if (why === 'idle' || why === 'total') throw diagnosticError(requestConfig, timeoutMessage(config, why), { category: 'timeout', idleSeconds: why === 'idle' ? config.timeout : undefined }, 504);
    if (why === 'cancelled') throw new UserError('任务已取消。', 499);
    if (error instanceof UserError) { error.diagnostic ||= connectionDiagnostic(requestConfig, { category: 'response' }); throw error; }
    throw networkError(error, requestConfig, key);
  } finally {
    guard.dispose();
    signal?.removeEventListener('abort', cancel);
  }
}
