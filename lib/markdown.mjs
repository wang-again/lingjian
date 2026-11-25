// 服务端 Markdown → 编辑器 HTML。
// 章节任务在服务端执行，需要把模型返回的 Markdown 落成与前端编辑器一致的块级结构：
// 只产出 h2–h4、p、ul/ol、li、blockquote、pre、table、hr、strong/em/code，
// 与 public/editor.js 的 markdownToHtml 保持同一套输出形状，便于前端直接渲染。

export function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
}

export function markdownToHtml(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let paragraph = [], list = null, code = null;
  const flush = () => { if (paragraph.length) { output.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph = []; } };
  const closeList = () => { if (list) { output.push(`</${list}>`); list = null; } };
  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush(); closeList();
      if (code !== null) { output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; } else code = [];
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      flush(); closeList(); const head = cells(line); i++;
      const rows = [];
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) rows.push(cells(lines[++i]));
      output.push(`<table><thead><tr>${head.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${head.map((_, j) => `<td>${inline(row[j] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (!line.trim()) { flush(); closeList(); continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) { flush(); closeList(); const level = Math.max(2, Math.min(4, heading[1].length)); output.push(`<h${level}>${inline(heading[2])}</h${level}>`); continue; }
    const item = /^\s*(?:([-*+])|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      flush(); const kind = item[1] ? 'ul' : 'ol';
      if (list !== kind) { closeList(); list = kind; output.push(`<${kind}>`); }
      output.push(`<li>${inline(item[2])}</li>`); continue;
    }
    closeList();
    if (/^>\s?/.test(line)) { flush(); output.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { flush(); output.push('<hr>'); continue; }
    paragraph.push(line);
  }
  flush(); closeList(); if (code !== null) output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  return output.join('');
}

// 章节任务只写正文：模型偶尔仍会回写章节标题，落库前剥掉，避免同一标题出现两次。
export function stripLeadingHeading(markdown, title = '') {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start++;
  const heading = /^(#{1,6})\s+(.+)$/.exec(lines[start] || '');
  if (!heading) return String(markdown || '');
  const headingText = heading[2].trim();
  if (!title || !headingText || headingText.includes(title) || title.includes(headingText)) {
    return lines.slice(start + 1).join('\n');
  }
  return String(markdown || '');
}
