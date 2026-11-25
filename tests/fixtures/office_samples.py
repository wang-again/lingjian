"""Generate tiny, real-format fixtures for local integration tests."""
import sys
from pathlib import Path
from docx import Document
from openpyxl import Workbook
from pptx import Presentation
from PIL import Image
import fitz

root = Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
doc = Document()
doc.add_heading('Office 集成验证', 0)
doc.add_heading('一、背景', 1)
doc.add_paragraph('原始内容待补充')
table = doc.add_table(rows=2, cols=2)
table.cell(0, 0).text = '指标'
table.cell(0, 1).text = '数值'
table.cell(1, 0).text = '样本数'
table.cell(1, 1).text = '12'
doc.save(root / 'sample.docx')
book = Workbook()
sheet = book.active
sheet.title = '数据'
sheet.append(['项目', '金额'])
sheet.append(['第一阶段', 120])
book.save(root / 'sample.xlsx')
presentation = Presentation()
slide = presentation.slides.add_slide(presentation.slide_layouts[0])
slide.shapes.title.text = 'Office 集成验证'
slide.placeholders[1].text = '真实 PPTX 读取验收'
presentation.save(root / 'sample.pptx')
pdf = fitz.open()
page = pdf.new_page()
page.insert_text((50, 60), 'Office integration PDF sample')
pdf.save(root / 'sample.pdf')
pdf.close()
Image.new('RGB', (120, 80), '#56795b').save(root / 'sample.png')
(root / 'sample.txt').write_text('参考材料：项目计划先接入文档读取，再验证编辑与导出。', encoding='utf-8')
print('Office fixtures generated')
