"""Inspect a DOCX package without executing Office or changing the source file."""
import json
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def inspect(path, required_sections):
    findings = []
    stats = {'paragraphs': 0, 'headings': 0, 'tables': 0, 'images': 0, 'characters': 0}
    headings = []

    def issue(code, location, message, severity='warning'):
        findings.append({'code': code, 'location': location, 'message': message, 'severity': severity})

    def xml(archive, name):
        data = archive.read(name)
        if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
            raise ValueError('XML declarations are not supported')
        return ET.fromstring(data)

    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) > 3000 or sum(item.file_size for item in entries) > 40_000_000:
                raise ValueError('DOCX package is too large')
            for name in ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']:
                xml(archive, name)
            document = xml(archive, 'word/document.xml')
            body = document.find(W + 'body')
            if body is None:
                raise ValueError('Missing document body')
            style_names = {}
            if 'word/styles.xml' in archive.namelist():
                for style in xml(archive, 'word/styles.xml').findall(W + 'style'):
                    name = style.find(W + 'name')
                    style_names[style.get(W + 'styleId', '')] = name.get(W + 'val', '') if name is not None else ''
            paragraphs = list(body.iter(W + 'p'))
            texts = [''.join(node.text or '' for node in p.iter(W + 't')) for p in paragraphs]
            stats.update(paragraphs=len(paragraphs), tables=len(list(body.iter(W + 'tbl'))),
                         images=sum(1 for name in archive.namelist() if name.startswith('word/media/')),
                         characters=sum(len(text) for text in texts))
            content_paragraphs = 0
            for index, (paragraph, text) in enumerate(zip(paragraphs, texts), 1):
                style = paragraph.find('./' + W + 'pPr/' + W + 'pStyle')
                style_id = style.get(W + 'val', '') if style is not None else ''
                label = style_names.get(style_id, style_id)
                numbered = re.match(r'^(?:[一二三四五六七八九十百]+[、．.]|第.{1,8}[章节]|\d+(?:\.\d+)*[、.\s])', text)
                runs = [run for run in paragraph.findall(W + 'r') if run.find(W + 't') is not None]
                def bold_heading_run(run):
                    bold = run.find('./' + W + 'rPr/' + W + 'b')
                    size = run.find('./' + W + 'rPr/' + W + 'sz')
                    return bold is not None and bold.get(W + 'val', '1').lower() not in ('0', 'false', 'off') and size is not None and int(size.get(W + 'val', '0')) >= 28
                all_bold = bool(runs) and all(bold_heading_run(run) for run in runs)
                is_heading = bool(re.search(r'heading|标题', label, re.I) or ((numbered or all_bold) and len(text) < 160))
                if is_heading and text.strip():
                    headings.append(text.strip())
                elif text.strip() and label.lower() != 'title':
                    content_paragraphs += 1
                for match in re.finditer(r'待补充|待确认|待核实|\bTODO\b|\bTBD\b|_{3,}', text, re.I):
                    if len(findings) < 200:
                        issue('placeholder', f'段落 {index}', f'存在待完善标记「{match.group()}」：{text[max(0, match.start()-15):match.end()+25]}')
            stats['headings'] = len(headings)
            if not stats['characters']:
                issue('empty_document', '正文', '文档中没有可检查的文字正文。', 'warning' if stats['images'] else 'error')
            elif not content_paragraphs and not stats['tables']:
                issue('no_body_content', '正文', '只发现标题或章节名，未发现实际正文。', 'error')
            if required_sections:
                def normalize(value):
                    value = re.sub(r'^(?:第.{1,8}[章节]|[一二三四五六七八九十百]+[、．.]|\d+(?:\.\d+)*[、.\s])', '', value.strip())
                    return re.sub(r'[\s、，。:：.．]', '', value).lower()
                for section in required_sections:
                    target = normalize(section)
                    if not any(target in normalize(heading) for heading in headings):
                        issue('missing_section', '章节', f'未找到要求的章节「{section}」。')
            section = body.find(W + 'sectPr')
            page_width = 0
            if section is not None:
                size, margin = section.find(W + 'pgSz'), section.find(W + 'pgMar')
                if size is not None and margin is not None:
                    page_width = int(size.get(W + 'w', '0')) - int(margin.get(W + 'left', '0')) - int(margin.get(W + 'right', '0'))
            for index, table in enumerate(body.iter(W + 'tbl'), 1):
                if not table.findall(W + 'tr'):
                    issue('empty_table', f'表格 {index}', '表格没有数据行。')
                width = sum(int(column.get(W + 'w', '0')) for column in table.findall('./' + W + 'tblGrid/' + W + 'gridCol'))
                if page_width > 0 and width > page_width + 120:
                    issue('table_width', f'表格 {index}', '表格声明宽度超过当前页可用宽度，需要在 Word 中检查版式。')
    except (OSError, zipfile.BadZipFile, KeyError, ET.ParseError, ValueError, RuntimeError) as error:
        issue('invalid_package', '文件结构', f'无法作为完整 DOCX 检查（{type(error).__name__}）。', 'error')
    status = 'failed' if any(item['severity'] == 'error' for item in findings) else 'needs_review' if findings else 'passed'
    return {
        'version': 1, 'status': status,
        'summary': {'passed': '结构检查通过', 'needs_review': '检查完成，有待确认项', 'failed': '交付检查未通过'}[status],
        'stats': stats, 'headings': headings[:100], 'findings': findings,
        'required_sections': required_sections, 'visual_review': False,
        'limitations': ['未执行 Word 页面渲染与版式目检。', '未独立核实事实、引用真实性或数值计算。'],
        'checked_at': datetime.now(timezone.utc).isoformat()
    }


if __name__ == '__main__':
    print(json.dumps(inspect(Path(sys.argv[1]), json.loads(sys.argv[2])), ensure_ascii=False))
