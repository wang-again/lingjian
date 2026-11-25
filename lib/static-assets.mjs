import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

// 手写资源表每加一个页面就要改两处，而且容易漏。这里在启动时扫描 public/，
// 只暴露已知类型，路径只允许目录下的文件名（不含子目录），不引入目录穿越面。
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.txt': 'text/plain'
};
const TEXT = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest', '.txt']);

export function mimeType(name) {
  return MIME[extname(name).toLowerCase()] || 'application/octet-stream';
}

export async function createAssetIndex(directory) {
  const assets = new Map([['/', 'index.html']]);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    if (!MIME[extname(entry.name).toLowerCase()]) continue;
    assets.set(`/${entry.name}`, entry.name);
  }
  return assets;
}

// 静态资源按内容指纹协商缓存：改文件即换 ETag，未改动时浏览器拿 304，不重传整包。
export async function serveAsset(req, res, file, name) {
  const type = mimeType(name);
  const info = await stat(file);
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': TEXT.has(extname(name).toLowerCase()) ? `${type}; charset=utf-8` : type,
    'Cache-Control': 'no-cache', ETag: etag, 'Last-Modified': info.mtime.toUTCString()
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers);
  return res.end(await readFile(file));
}
