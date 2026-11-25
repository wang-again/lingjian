// Unauthenticated network checks only. No keys are read or sent. A 401/403
// confirms access to the authentication layer, not account/model availability.
import { mkdir, writeFile } from 'node:fs/promises';
import { providerPresets } from '../lib/provider-presets.mjs';
import { validateProvider, endpointFor, modelsEndpointFor, makePayload } from '../lib/providers.mjs';

async function probe(url, options) {
  const started = Date.now();
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
    await response.body?.cancel();
    return { endpoint: String(url), method: options.method, reachable: true, httpStatus: response.status, authenticationReached: [401, 403].includes(response.status), elapsed: Date.now() - started };
  } catch (error) {
    const cause = error.cause;
    const codes = [error.code, cause?.code, ...(cause?.errors || []).map(item => item.code)].filter(Boolean);
    return { endpoint: String(url), method: options.method, reachable: false, error: error.name, codes: [...new Set(codes)], elapsed: Date.now() - started };
  }
}

const providers = await Promise.all(providerPresets.map(async preset => {
  const config = validateProvider({ ...preset, vendor: preset.id, model: preset.models[0] });
  const [models, chat] = await Promise.all([
    probe(modelsEndpointFor(config), { method: 'GET' }),
    probe(endpointFor(config), { method: 'POST', body: JSON.stringify(makePayload(config, [{ role: 'user', content: '请只回复：连接成功' }])) })
  ]);
  const result = { vendor: preset.id, name: preset.name, model: config.model, models, chat, accountVerified: false };
  console.log(JSON.stringify(result)); return result;
}));
const report = { checkedAt: new Date().toISOString(), node: process.version, keyUsed: false, note: 'Uncredentialed checks only. HTTP 401/403 is not successful account authentication.', providers };
await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
await writeFile(new URL('../test-results/provider-network-audit.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
if (providers.some(item => !item.chat.reachable || !item.models.reachable)) process.exitCode = 1;
