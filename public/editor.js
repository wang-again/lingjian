export const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export const safeImageSource = src => typeof src === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/]+=*$/.test(src) && src.length <= 800_000;
const allowed = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'BR', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR', 'IMG']);
export function sanitizeHtml(html) {
  const template = document.createElement('template'); template.innerHTML = html;
  function clean(parent) {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType === Node.COMMENT_NODE) { node.remove(); continue; }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.tagName === 'IMG') {
        const src = node.getAttribute('src'), alt = node.getAttribute('alt') || '', width = Number(node.getAttribute('width'));
        if (!safeImageSource(src)) { node.remove(); continue; }
        for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
        node.setAttribute('src', src); node.setAttribute('alt', alt.slice(0, 500)); node.setAttribute('draggable', 'false');
        if (Number.isFinite(width) && width >= 32 && width <= 1600) node.setAttribute('width', String(Math.round(width)));
        continue;
      }
      if (['SCRIPT', 'STYLE', 'SVG', 'IFRAME', 'OBJECT', 'VIDEO', 'AUDIO', 'FORM', 'INPUT', 'BUTTON', 'LINK', 'META'].includes(node.tagName)) { node.remove(); continue; }
      clean(node);
      if (!allowed.has(node.tagName)) node.replaceWith(...node.childNodes);
      else for (const attribute of [...node.attributes]) {
        if (['TD', 'TH'].includes(node.tagName) && ['colspan', 'rowspan'].includes(attribute.name) && /^\d{1,2}$/.test(attribute.value) && Number(attribute.value) > 0) continue;
        node.removeAttribute(attribute.name);
      }
    }
  }
  clean(template.content);
  return template.innerHTML;
}
function inline(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(.+?)__/g, '<strong>$1</strong>').replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
}
export function markdownToHtml(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const output = []; let paragraph = [], list = null, code = null;
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
function inlineRuns(element, inherited = {}, withImages = false) {
  if (element.nodeType === Node.TEXT_NODE) return [{ text: element.textContent, ...inherited }];
  if (element.nodeName === 'BR') return [{ text: '\n', ...inherited }];
  if (withImages && element.nodeName === 'IMG') {
    return [{
      image: { src: element.getAttribute('src'), alt: element.alt, width: Number(element.getAttribute('width')) }
    }];
  }
  const style = { ...inherited };
  if (['B', 'STRONG'].includes(element.nodeName)) style.bold = true;
  if (['I', 'EM'].includes(element.nodeName)) style.italic = true;
  if (element.nodeName === 'U') style.underline = true;
  return [...element.childNodes].flatMap(child => inlineRuns(child, style, withImages));
}
export function editorBlocks(element, { withImages = false } = {}) {
  const blocks = [];
  const runsFor = node => inlineRuns(node, {}, withImages);
  const tableCell = cell => {
    if (!withImages || !cell.querySelector('img')) return cell.textContent;
    return { runs: runsFor(cell) };
  };
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) { if (node.textContent.trim()) blocks.push({ type: 'paragraph', text: node.textContent }); return; }
    const name = node.nodeName;
    if (name === 'TABLE') { blocks.push({ type: 'table', rows: [...node.rows].map(row => [...row.cells].map(tableCell)) }); return; }
    if (name === 'UL' || name === 'OL') {
      for (const li of [...node.children]) {
        const copy = li.cloneNode(true); copy.querySelectorAll('ul,ol').forEach(child => child.remove());
        blocks.push({ type: 'list', ordered: name === 'OL', runs: runsFor(copy) });
        [...li.children].filter(child => ['UL', 'OL'].includes(child.nodeName)).forEach(walk);
      }
      return;
    }
    if (/^H[1-4]$/.test(name)) { blocks.push({ type: 'heading', level: Number(name[1]) - (name === 'H1' ? 0 : 1), runs: runsFor(node) }); return; }
    if (name === 'BLOCKQUOTE') { blocks.push({ type: 'quote', runs: runsFor(node) }); return; }
    if (name === 'DIV' && [...node.children].some(child => ['DIV', 'P', 'H2', 'H3', 'UL', 'OL', 'TABLE'].includes(child.nodeName))) { [...node.childNodes].forEach(walk); return; }
    blocks.push({ type: 'paragraph', runs: runsFor(node) });
  }
  [...element.childNodes].forEach(walk);
  return blocks;
}

export async function docxContent(element) {
  const blocks = editorBlocks(element, { withImages: true });
  const imageIds = new Map();
  const images = [];
  const collect = async runs => {
    for (const run of runs || []) {
      if (!run.image) continue;
      const { src, width, alt } = run.image;
      if (!imageIds.has(src)) {
        if (!safeImageSource(src)) throw new Error('正文含无法导出的图片。');
        const picture = new Image();
        picture.src = src;
        try { await picture.decode(); }
        catch { throw new Error('正文含无法读取的图片。'); }
        const scale = Math.min(1, 1200 / Math.max(picture.naturalWidth, picture.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(picture.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(picture.naturalHeight * scale));
        canvas.getContext('2d').drawImage(picture, 0, 0, canvas.width, canvas.height);
        imageIds.set(src, { index: images.length, naturalWidth: picture.naturalWidth });
        images.push(canvas.toDataURL('image/png'));
      }
      const { index, naturalWidth } = imageIds.get(src);
      run.image = { index, width: width || naturalWidth, alt };
    }
  };
  for (const block of blocks) {
    if (block.type === 'table') {
      for (const row of block.rows) for (const cell of row) await collect(cell?.runs);
    } else {
      await collect(block.runs);
    }
  }
  return { blocks, images };
}
export function editorMarkdown(element) {
  const text = runs => (runs || []).map(run => run.bold ? `**${run.text}**` : run.italic ? `*${run.text}*` : run.text).join('');
  const cell = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  return editorBlocks(element).map(block => {
    const value = block.text ?? text(block.runs);
    if (block.type === 'heading') return `${'#'.repeat(block.level + 1)} ${value}`;
    if (block.type === 'list') return `${block.ordered ? '1.' : '-'} ${value}`;
    if (block.type === 'quote') return `> ${value}`;
    if (block.type === 'table') return block.rows.map((row, i) => `| ${row.map(cell).join(' | ')} |${i === 0 ? '\n| ' + row.map(() => '---').join(' | ') + ' |' : ''}`).join('\n');
    return value;
  }).join('\n\n');
}
