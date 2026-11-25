"""Create editable Word variants from pinned Chinese Markdown; no remote execution."""
import hashlib
import json
import re
from pathlib import Path
from docx import Document
from docx.shared import Cm, Pt, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'resources/templates'
IDS = {'zh-notice', 'zh-request', 'zh-report', 'zh-work-plan'}


def font(style, size, bold=False):
    style.font.name = 'Microsoft YaHei'
    style.font.size = Pt(size)
    style.font.bold = bold
    style.font.color.rgb = RGBColor(0, 0, 0)
    style.element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), 'Microsoft YaHei')


def main():
    catalog = json.loads((DEST / 'catalog.zh-CN.json').read_text(encoding='utf-8'))
    for item in catalog:
        if item['id'] not in IDS:
            continue
        source = item['assets'][0]
        text = (DEST / source['file']).read_text(encoding='utf-8').split('\n\n<!--\nSource:')[0]
        doc = Document()
        doc.core_properties.author = '灵笺'
        doc.core_properties.title = item['title']
        section = doc.sections[0]
        section.page_width, section.page_height = Cm(21), Cm(29.7)
        section.top_margin = section.bottom_margin = Cm(1.8)
        section.left_margin = section.right_margin = Cm(2.3)
        for name, size, bold in [('Normal', 10.5, False), ('Title', 20, True), ('Heading 1', 12, True), ('Heading 2', 11, True)]:
            font(doc.styles[name], size, bold)
            doc.styles[name].paragraph_format.space_after = Pt(5)
        for style in doc.styles:
            for border in list(style.element.iter(qn('w:pBdr'))):
                border.getparent().remove(border)
        doc.styles['Normal'].paragraph_format.space_before = Pt(0)
        doc.styles['Normal'].paragraph_format.space_after = Pt(4)
        doc.styles['Normal'].paragraph_format.line_spacing = 1.15
        doc.styles['Title'].paragraph_format.space_before = Pt(0)
        doc.styles['Heading 1'].paragraph_format.space_before = Pt(8)
        doc.styles['Heading 2'].paragraph_format.space_before = Pt(6)
        doc.add_paragraph(item['title'], 'Title')
        doc.add_paragraph('请根据实际事项替换方括号内容，删除不适用的附注和附件。本文件用于初稿整理，单位另有格式时按单位模板调整。')
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith('# '):
                continue
            if line.startswith('## '):
                heading = re.sub(r'[、（）：()：]', ' ', line[3:]).strip()
                doc.add_paragraph(heading, 'Heading 1')
            else:
                doc.add_paragraph(line)
        doc.add_page_break()
        doc.add_paragraph('来源与许可', 'Heading 1')
        doc.add_paragraph('由灵笺将开源中文 Markdown 模板排版为 Word，保留原作者署名及 MIT 许可。无第三方字体文件随附。')
        paragraph = doc.add_paragraph(item['source']['url'])
        for run in paragraph.runs:
            run.font.size = Pt(8)
        license_text = (DEST / item['source']['licenseFile']).read_text(encoding='utf-8')
        for line in license_text.splitlines():
            p = doc.add_paragraph(line)
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.line_spacing = 1.0
            for run in p.runs:
                run.font.name = 'Calibri'
                run.font.size = Pt(9)
        footer = section.footer.paragraphs[0]
        footer.add_run('灵笺  ·  中文模板  |  ')
        field = OxmlElement('w:fldSimple')
        field.set(qn('w:instr'), 'PAGE')
        footer._p.append(field)
        filename = item['id'] + '-document.docx'
        path = DEST / filename
        doc.save(path)
        data = path.read_bytes()
        item['assets'] = [a for a in item['assets'] if a['id'] not in ('document', 'print')]
        item['assets'].append({'id': 'document', 'label': '中文 Word 可编辑版', 'format': 'DOCX', 'file': filename, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'derivedFrom': source['sha256']})
        print(filename)
    (DEST / 'catalog.zh-CN.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
