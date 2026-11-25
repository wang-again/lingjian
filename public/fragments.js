import { t } from './i18n.js';
import { sanitizeHtml, editorMarkdown, markdownToHtml } from './editor.js';

export function captureFragment(editor, selection, documentId) {
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0).cloneRange();
  if (range.collapsed || !editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
  // Promote intersected tables and image paragraphs to complete blocks.
  // This keeps table rows/cells valid and makes the replacement boundary explicit.
  const rich = [...editor.querySelectorAll('table,img')].filter(node => range.intersectsNode(node));
  const block = node => { while (node.parentNode && node.parentNode !== editor) node = node.parentNode; return node; };
  for (const node of rich) {
    const bounds = document.createRange(); bounds.selectNode(block(node));
    if (range.compareBoundaryPoints(Range.START_TO_START, bounds) > 0) range.setStart(bounds.startContainer, bounds.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, bounds) < 0) range.setEnd(bounds.endContainer, bounds.endOffset);
  }
  if (rich.length) {
    if (range.startContainer !== editor) range.setStartBefore(block(range.startContainer));
    if (range.endContainer !== editor) range.setEndAfter(block(range.endContainer));
  }
  const holder = document.createElement('div'); holder.append(range.cloneContents());
  const selectedHtml = sanitizeHtml(holder.innerHTML);
  holder.innerHTML = selectedHtml;
  const images = [...holder.querySelectorAll('img')].map((img, i) => ({ id: String(i + 1), src: img.getAttribute('src'), alt: img.alt }));
  holder.querySelectorAll('img').forEach((img, i) => img.replaceWith(document.createTextNode(`![${img.alt || t('图片')}](fragment-image:${i + 1})`)));
  const text = editorMarkdown(holder) || range.toString();
  if (!text.trim() && !images.length) return null;
  return { range, text, selectedHtml, images, tables: holder.querySelectorAll('table').length, html: editor.innerHTML, documentId, rich: rich.length > 0 };
}

export function fragmentIsCurrent(editor, fragment, documentId) {
  if (!fragment || fragment.documentId !== documentId || fragment.html !== editor.innerHTML || !editor.contains(fragment.range.commonAncestorContainer)) return false;
  const holder = document.createElement('div'); holder.append(fragment.range.cloneContents());
  return sanitizeHtml(holder.innerHTML) === fragment.selectedHtml;
}

export function fragmentResultHtml(text, fragment) {
  const holder = document.createElement('div'); holder.innerHTML = markdownToHtml(text);
  const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const pattern = /!\[([^\]\n]*)\]\(fragment-image:(\d+)(?:\s+"(\d+)")?\)/g;
    let match, offset = 0; const output = document.createDocumentFragment();
    while ((match = pattern.exec(node.textContent))) {
      const original = fragment.images.find(img => img.id === match[2]);
      if (!original) throw new Error(t('模型引用了片段中不存在的图片，请重新生成。'));
      output.append(document.createTextNode(node.textContent.slice(offset, match.index)));
      const img = document.createElement('img'); img.src = original.src; img.alt = match[1];
      if (match[3]) img.width = Math.max(32, Math.min(1600, Number(match[3])));
      output.append(img); offset = pattern.lastIndex;
    }
    if (offset) { output.append(document.createTextNode(node.textContent.slice(offset))); node.replaceWith(output); }
  }
  return sanitizeHtml(holder.innerHTML);
}

export function replaceFragment(editor, fragment, text, documentId) {
  if (!fragmentIsCurrent(editor, fragment, documentId)) throw new Error(t('片段或正文已经变化，请重新框选后生成。'));
  const range = fragment.range.cloneRange();
  if (fragment.rich) {
    const holder = document.createElement('template'); holder.innerHTML = fragmentResultHtml(text, fragment);
    range.deleteContents(); range.insertNode(holder.content);
  } else if (range.startContainer === editor && range.endContainer === editor) {
    const output = document.createDocumentFragment();
    for (const line of text.split('\n')) { const paragraph = document.createElement('p'); paragraph.textContent = line; output.append(paragraph); }
    range.deleteContents(); range.insertNode(output);
  } else {
    // Inline replacements preserve the surrounding paragraph and formatting.
    range.deleteContents(); const output = document.createDocumentFragment();
    text.split('\n').forEach((line, i) => { if (i) output.append(document.createElement('br')); output.append(document.createTextNode(line)); });
    range.insertNode(output);
  }
}
