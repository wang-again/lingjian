import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { templateResource, customTemplateResource } from './templates.mjs';
import { UserError } from './providers.mjs';

const mime = { MD: 'text/markdown; charset=utf-8', PDF: 'application/pdf', DOC: 'application/msword', DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', XLS: 'application/vnd.ms-excel', XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const importable = new Set(['DOCX', 'XLSX', 'PDF', 'MD']);

export async function handleTemplates({ req, res, url, send, readJson, office, customTemplates = [] }) {
  if (!url.pathname.startsWith('/api/templates/')) return false;
  const match = /^\/api\/templates\/([a-z0-9-]+)\/(assets\/([a-z0-9-]+)|use)$/.exec(url.pathname);
  // 集合级接口（如 /api/templates/distill）由主服务处理，这里只接管单份模板的资源与使用。
  if (!match) return false;
  const [, id, action, downloadId] = match;
  if ((action === 'use' && req.method !== 'POST') || (action !== 'use' && req.method !== 'GET')) throw new UserError('此模板操作不支持该请求方式。', 405);
  const assetId = downloadId || (await readJson(req))?.assetId;
  const custom = customTemplates.find(item => item.id === id);
  const resource = custom ? customTemplateResource(custom, assetId) : templateResource(id, assetId);
  if (!resource) throw new UserError('没有找到这个模板文件。', 404);
  const { template, asset, name } = resource;
  if (action === 'use' && !importable.has(asset.format)) throw new UserError(`旧版 ${asset.format} 请先下载，在 Word/WPS/Excel 中另存为 ${asset.format === 'DOC' ? 'DOCX' : 'XLSX'} 后上传。`);
  const bytes = resource.bytes || await readFile(resource.path);
  if (asset.sha256 && createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new UserError('模板文件校验失败，请恢复模板原件后重试。', 409);
  if (action === 'use') {
    const file = await office.upload(name, bytes.toString('base64'));
    const prompt = `请使用所选的「${template.title}」${asset.role === 'example' ? '填写示例作为参考' : '模板'}，按现有结构处理我的需求，并另存为新文件。\n\n我的需求和实际数据：\n（请在这里填写）\n\n填写要求：${template.rules}\n${template.source ? `来源：${template.source.name}；${template.source.attribution}\n${template.source.licenseUrl}` : ''}`;
    send(201, { file, files: await office.listFiles(), prompt });
  } else {
    res.writeHead(200, { 'Content-Type': mime[asset.format], 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Length': bytes.length });
    res.end(bytes);
  }
  return true;
}
