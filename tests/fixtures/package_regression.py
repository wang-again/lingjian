"""Proof on real Excel/PowerPoint files, preserving untouched ZIP parts."""
import sys,json,io
import os
from copy import copy
from pathlib import Path
from zipfile import ZipFile
from openpyxl import Workbook,load_workbook
from openpyxl.styles import Font,PatternFill
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.chart import BarChart,Reference
from pptx import Presentation
from pptx.util import Inches
from pptx.oxml.xmlchemy import OxmlElement
from PIL import Image
from lxml import etree
project = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(project / (os.environ.get('OFFICE_TOOL_DIR') or '.vendor/office-tool')))
from tools.document_editing import inspect_document,edit_document,preview_document_edits

root=Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
wb=Workbook();ws=wb.active;ws.title='预算表';ws.append(['项目','预算','状态']);ws.append(['甲',100,None]);ws.append(['乙',200,True]);ws['B4']='=SUM(B2:B3)'
ws['B2'].font=Font(name='Arial',bold=True,color='FF0000');ws['B2'].fill=PatternFill('solid',fgColor='FFFF00');ws['B2'].number_format='#,##0.00';ws.column_dimensions['B'].width=25;ws.freeze_panes='A2'
ws.merge_cells('E1:F1');ws['E1']='合并内容'
dv=DataValidation(type='list',formula1='"是,否"');ws.add_data_validation(dv);dv.add('D2')
ws['D3']='链接';ws['D3'].hyperlink='https://example.com'
hidden=wb.create_sheet('隐藏表');hidden['A1']='保密';hidden.sheet_state='hidden'
locked=wb.create_sheet('保护表');locked['A1']='锁定';locked.protection.sheet=True
chart=BarChart();chart.add_data(Reference(ws,min_col=2,min_row=1,max_row=3),titles_from_data=True);ws.add_chart(chart,'H2')
source=root/'precise.xlsx';wb.save(source);original=source.read_bytes()
snap=inspect_document(str(source),limit=100,sheet_name='预算表',cell_range='A1:J6');cells={n['cell']:n for n in snap['locations']}
def op(entry,replace,kind='string'):
 return {'type':'set_spreadsheet_cell','location':entry['location'],'find':entry['text'],'replace':replace,'value_type':kind}
ops=[op(cells['B2'],'500','number'),op(cells['C2'],'完成'),op(cells['C3'],'false','boolean'),op(cells['J6'],'=SUM(A1:A2)')]
spec={'source_sha256':snap['source_sha256'],'output':str(root/'precise-edited.xlsx'),'operations':ops}
assert preview_document_edits(str(source),json.dumps(spec))['verified'] and not (root/'precise-edited.xlsx').exists()
result=edit_document(str(source),json.dumps(spec));assert result['changed_count']==4 and source.read_bytes()==original
updated=load_workbook(result['output'],data_only=False);sheet=updated['预算表']
assert sheet['B2'].value==500 and sheet['B2'].data_type=='n';assert sheet['C2'].value=='完成';assert sheet['C3'].value is False
assert sheet['J6'].value=='=SUM(A1:A2)' and sheet['J6'].data_type=='s'
assert sheet['B4'].value=='=SUM(B2:B3)';assert copy(sheet['B2'].font)==copy(ws['B2'].font) and copy(sheet['B2'].fill)==copy(ws['B2'].fill)
assert sheet['B2'].number_format==ws['B2'].number_format and sheet.column_dimensions['B'].width==25 and sheet.freeze_panes=='A2'
assert updated.sheetnames==wb.sheetnames and updated['隐藏表'].sheet_state=='hidden'
readonly=load_workbook(result['output'],read_only=True);assert readonly['预算表']['J6'].value=='=SUM(A1:A2)';readonly.close();updated.close()
with ZipFile(source) as a,ZipFile(result['output']) as b:
 for name in a.namelist():
  if name not in {'xl/workbook.xml','xl/worksheets/sheet1.xml'}:assert a.read(name)==b.read(name),name
 tree=etree.fromstring(b.read('xl/worksheets/sheet1.xml'));ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
 assert not tree.xpath('//s:c[@r="B4"]/s:v',namespaces=ns)

def rejected(path,snapshot,operations,message):
 output=root/('invalid'+path.suffix)
 try:
  edit_document(str(path),json.dumps({'source_sha256':snapshot['source_sha256'],'output':str(output),'operations':operations}))
  raise AssertionError('invalid edit accepted')
 except ValueError as error:assert message in str(error),str(error)
 assert not output.exists()

for cell in ['B4','E1','F1','D2','D3']:rejected(source,snap,[op(cells[cell],'不能改')],'受保护')
for title in ['隐藏表','保护表']:
 found=inspect_document(str(source),sheet_name=title)['locations'][0];rejected(source,snap,[op(found,'不可修改')],'受保护')
rejected(source,snap,[ops[0],ops[0]],'不重复')
rejected(source,snap,[op(cells['B2'],'NaN','number')],'有限数字')
rejected(source,snap,[op(cells['B2'],'1e999','number')],'有限数字')
rejected(source,snap,[op(cells['B2'],'1e2','number')],'没有实际修改')
rejected(source,snap,[{**ops[0],'find':'101'}],'原文不匹配')
assert source.read_bytes()==original

prs=Presentation();s1=prs.slides.add_slide(prs.slide_layouts[6]);box=s1.shapes.add_textbox(Inches(1),Inches(1),Inches(5),Inches(1));box.name='费用说明'
p=box.text_frame.paragraphs[0];p.add_run().text='预算';p.runs[0].font.bold=True;p.add_run().text='100';p.runs[1].font.italic=True;p.add_run().text='元'
link=s1.shapes.add_textbox(Inches(1),Inches(2),Inches(5),Inches(1));r=link.text_frame.paragraphs[0].add_run();r.text='受保护链接';r.hyperlink.address='https://example.com'
Image.new('RGB',(20,20),'red').save(root/'slide-logo.png');s1.shapes.add_picture(str(root/'slide-logo.png'),Inches(6),Inches(1))
prs.slides.add_slide(prs.slide_layouts[6]).shapes.add_textbox(Inches(1),Inches(1),Inches(3),Inches(1)).text='预算100元'
timing=OxmlElement('p:timing');s1._element.append(timing)
source=root/'precise.pptx';prs.save(source);original=source.read_bytes();snap=inspect_document(str(source),query='预算',limit=100)
assert [n['slide'] for n in snap['locations']]==[1,2]
operation={'type':'replace_slide_text','location':snap['locations'][0]['location'],'find':'100','replace':'200'}
spec={'source_sha256':snap['source_sha256'],'output':str(root/'precise-edited.pptx'),'operations':[operation]}
assert preview_document_edits(str(source),json.dumps(spec))['verified'] and not (root/'precise-edited.pptx').exists()
result=edit_document(str(source),json.dumps(spec));assert source.read_bytes()==original
updated=Presentation(result['output']);p=updated.slides[0].shapes[0].text_frame.paragraphs[0]
assert p.text=='预算200元' and p.runs[0].font.bold and p.runs[1].font.italic
assert updated.slides[1].shapes[0].text=='预算100元'
with ZipFile(source) as a,ZipFile(result['output']) as b:
 for name in a.namelist():
  if name!='ppt/slides/slide1.xml':assert a.read(name)==b.read(name),name
 assert b'<p:timing' in b.read('ppt/slides/slide1.xml')
rejected(source,snap,[operation,operation],'重叠')
rejected(source,snap,[{**operation,'find':'不存在'}],'唯一匹配')
rejected(source,snap,[{**operation,'replace':'100'}],'不能与原文相同')
rejected(source,snap,[{**operation,'replace':'新文\n换行'}],'换行')
link_entry=inspect_document(str(source),query='链接')['locations'][0];assert not link_entry['slide_operations']
rejected(source,snap,[{'type':'replace_slide_text','location':link_entry['location'],'find':'链接','replace':'新文'}],'受保护')
print('XLSX/PPTX styles, typed cells, formula protection, ZIP integrity and atomic rejection passed')
