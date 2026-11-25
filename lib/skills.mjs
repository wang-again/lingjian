import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { officeToolDirectory } from './runtime.mjs';
import { UserError } from './providers.mjs';

const readers = ['ocr_document', 'search_sources', 'read_docx', 'read_xlsx', 'read_pptx', 'read_file', 'pdf_info', 'pdf_extract_text', 'file_info', 'read_image'];
const definitions = [
  { id: 'document-editing', title: '现有文件精确修改', surfaces: ['office'], tools: [...readers, 'inspect_document', 'preview_document_edits', 'edit_document', 'check_docx', 'pdf_render_pages'], guides: [] },
  { id: 'source-synthesis', title: '资料归纳', surfaces: ['writing', 'office'], tools: [...readers, 'write_docx', 'check_docx'], guides: ['read_docx', 'read_xlsx', 'write_docx'] },
  { id: 'report-writing', title: '报告撰写', surfaces: ['writing', 'office'], tools: [...readers, 'write_docx', 'edit_docx', 'check_docx'], guides: ['write_docx', 'edit_docx'] },
  { id: 'docx-delivery', title: 'DOCX 交付检查', surfaces: ['office'], tools: ['check_docx', 'read_docx', 'file_info'], guides: [] }
];

// Only maintained project skills are loaded. Requests cannot supply file paths.
const skills = await Promise.all(definitions.map(async definition => {
  const source = await readFile(new URL(`../skills/${definition.id}/SKILL.md`, import.meta.url), 'utf8');
  const header = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
  const name = /^name: (.+)$/m.exec(header?.[1] || '')?.[1].trim();
  const description = /^description: (.+)$/m.exec(header?.[1] || '')?.[1].trim();
  if (name !== definition.id || !description) throw new Error(`技能定义不正确：${definition.id}`);
  return { ...definition, description, instructions: source.slice(header[0].length).trim() };
}));

export const skillCatalog = skills.map(({ id, title, description, surfaces }) => ({ id, title, description, surfaces }));

export function selectSkill(selection = 'auto', { surface, prompt = '', mode = '', title = '', files = [] } = {}) {
  if (selection === 'none') return null;
  if (selection === 'auto') {
    if (surface === 'writing' && ['rewrite', 'review'].includes(mode)) return null;
    if (surface === 'office' && files.some(file => /\.docx$/i.test(file.id)) && /检查|验收|校验|check|inspect/i.test(prompt) && !/生成|创建|撰写|另存|修改|润色|generate|create|write/i.test(prompt)) selection = 'docx-delivery';
    else if (/归纳|摘要|汇总|提炼|总结资料|整理资料|summari[sz]e|synthesis/i.test(prompt)) selection = 'source-synthesis';
    else if (/报告|方案|策划|计划书|report|proposal/i.test(prompt + ' ' + title) || (surface === 'office' && /(?:生成|创建|撰写|写一|generate|create|write).*(?:Word|DOCX)/i.test(prompt))) selection = 'report-writing';
    else return null;
  }
  const skill = skills.find(item => item.id === selection && item.surfaces.includes(surface));
  if (!skill) throw new UserError('该技能不可用于当前任务，请重新选择。');
  return skill;
}

export async function skillInstructions(skill, { office = false } = {}) {
  if (!skill) return '';
  let content = `任务技能：${skill.title}\n${skill.instructions}`;
  if (office) {
    for (const name of skill.guides) {
      try {
        const guide = await readFile(join(officeToolDirectory(), 'prompts', `${name}.md`), 'utf8');
        content += `\n\n工具使用指南（本项目路径统一用文件库相对 ID）：\n${guide}`;
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    }
  }
  return content;
}
