import { t } from './i18n.js';
import {sanitizeHtml, markdownToHtml} from './editor.js';
import {fragmentIsCurrent, fragmentResultHtml} from './fragments.js';

// Comment anchors survive incremental edits without relying on an invalidated selection.
export function createLiveEdit(editor, {mode, selection, documentId}) {
  const start = document.createComment('ai-start'), end = document.createComment('ai-end');
  const rootBlocks = mode === 'rewrite' && selection.range.startContainer === editor && selection.range.endContainer === editor;
  let mounted = false, highlighted = [];
  function unhighlight() { highlighted.forEach(node => node.removeAttribute('data-ai-writing')); highlighted = []; }
  function mount() {
    if (mode === 'rewrite') {
      if (!fragmentIsCurrent(editor, selection, documentId)) throw Error(t('原选区已变化，请重新框选。'));
      const tail = selection.range.cloneRange(); tail.collapse(false); tail.insertNode(end);
      const head = selection.range.cloneRange(); head.collapse(true); head.insertNode(start);
    } else if (mode === 'continue') editor.append(start, end);
    else editor.replaceChildren(start, end);
    mounted = true;
  }
  return {
    update(text, final = false) {
      if (!text.trim()) return false;
      const output = document.createElement('template');
      if (mode === 'rewrite' && !selection.rich) {
        text.split('\n').forEach((line, i) => {
          if (rootBlocks) { const p = document.createElement('p'); p.textContent = line; output.content.append(p); }
          else { if (i) output.content.append(document.createElement('br')); output.content.append(document.createTextNode(line)); }
        });
      } else {
        try {
          output.innerHTML = mode === 'rewrite' ? fragmentResultHtml(text, selection) : markdownToHtml(text);
          if (mode === 'rewrite') {
            const images = [...output.content.querySelectorAll('img')];
            if (selection.images.some(img => !images.some(node => node.getAttribute('src') === img.src)) || output.content.querySelectorAll('table').length < selection.tables) throw Error(t('模型未保留选区中的图片或完整表格，原内容已保留。'));
          }
        } catch (error) { if (final) throw error; return false; }
      }
      if (!mounted) mount();
      unhighlight();
      if (start.parentNode === end.parentNode) {
        // Keep completed paragraphs intact; replace only the changed tail.
        let old = start.nextSibling, fresh = output.content.firstChild;
        while (old !== end && fresh && old.isEqualNode(fresh)) { old = old.nextSibling; const next = fresh.nextSibling; fresh.remove(); fresh = next; }
        while (old !== end) { const next = old.nextSibling; old.remove(); old = next; }
        end.before(output.content);
      } else {
        const range = document.createRange(); range.setStartAfter(start); range.setEndBefore(end);
        range.deleteContents(); range.insertNode(output.content);
      }
      const range = document.createRange(); range.setStartAfter(start); range.setEndBefore(end);
      highlighted = [...editor.children].filter(node => range.intersectsNode(node));
      highlighted.forEach(node => node.setAttribute('data-ai-writing',''));
      return true;
    },
    html() { return sanitizeHtml(editor.innerHTML); },
    finish() { unhighlight(); start.remove(); end.remove(); }
  };
}
