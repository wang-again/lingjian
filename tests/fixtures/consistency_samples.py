import sys
from pathlib import Path
from docx import Document
from openpyxl import Workbook
from pptx import Presentation
from pptx.util import Inches
import fitz
root=Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
lines=['口径说明：项目总预算以100万元为准。','项目计划在2026年12月31日验收。','承办单位为星海科技。','项目总预算为200万元。','项目计划在2027年1月31日验收。','承办单位为星河科技。']
doc=Document()
for line in lines[:3]:doc.add_paragraph(line)
for i in range(105):doc.add_paragraph(f'背景资料第{i+1}段：该段为正常说明。')
for line in lines[3:]:doc.add_paragraph(line)
doc.save(root/'consistency.docx')
wb=Workbook();ws=wb.active;ws.title='核对表'
for line in lines:ws.append([line])
wb.save(root/'consistency.xlsx')
prs=Presentation()
for line in lines:
 slide=prs.slides.add_slide(prs.slide_layouts[6]);slide.shapes.add_textbox(Inches(1),Inches(1),Inches(8),Inches(1)).text=line
prs.save(root/'consistency.pptx')
pdf=fitz.open();page=pdf.new_page()
for i,line in enumerate(lines):page.insert_text((40,50+i*30),line,fontname='china-s',fontsize=12)
pdf.new_page();pdf.save(root/'consistency.pdf');pdf.close()
empty=fitz.open();empty.new_page();empty.save(root/'scan.pdf');empty.close()
doc=Document();doc.add_paragraph('超长段落'+('普通说明。'*1200));doc.save(root/'truncated.docx')
