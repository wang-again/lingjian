"""Real table edits: locations, blank cells, row formatting and atomic protection."""
import json
import os
import sys
from pathlib import Path
from zipfile import ZipFile
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from PIL import Image

project = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(project / (os.environ.get('OFFICE_TOOL_DIR') or '.vendor/office-tool')))
from tools.document_editing import inspect_document,edit_document,preview_document_edits
root=Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
doc=Document();doc.add_paragraph('表格前正文。');doc.sections[0].header.paragraphs[0].text='保留页眉。'
table=doc.add_table(rows=5,cols=3);table.style='Table Grid'
values=[['项目','金额','状态'],['参考','100','待定'],['填写','200',''],['删除','400','过期'],['末行','500','保留']]
for row,texts in zip(table.rows,values):
    for cell,text in zip(row.cells,texts):cell.text=text
table.rows[0]._tr.get_or_add_trPr().append(OxmlElement('w:tblHeader'))
table.rows[1].cells[0].paragraphs[0].runs[0].bold=True
shading=OxmlElement('w:shd');shading.set(qn('w:fill'),'CCDDEE');table.rows[1].cells[0]._tc.get_or_add_tcPr().append(shading)
merged=doc.add_table(rows=1,cols=2);merged.cell(0,0).merge(merged.cell(0,1)).text='合并格'
vertical=doc.add_table(rows=2,cols=1);vertical.cell(0,0).merge(vertical.cell(1,0)).text='跨行合并'
nested=doc.add_table(rows=1,cols=1);nested.cell(0,0).add_table(rows=1,cols=1).cell(0,0).text='嵌套表格'
fieldtable=doc.add_table(rows=1,cols=1);field=OxmlElement('w:fldSimple');field.set(qn('w:instr'),'SUM(ABOVE)')
run=OxmlElement('w:r');text=OxmlElement('w:t');text.text='100';run.append(text);field.append(run);fieldtable.cell(0,0).paragraphs[0]._p.append(field)
pic=doc.add_table(rows=1,cols=1);Image.new('RGB',(16,16),'blue').save(root/'table-logo.png');pic.cell(0,0).paragraphs[0].add_run().add_picture(str(root/'table-logo.png'))
tracked=doc.add_table(rows=1,cols=1);tracked.cell(0,0).text='修订行';ins=OxmlElement('w:ins');ins.set(qn('w:id'),'1');tracked.rows[0]._tr.get_or_add_trPr().append(ins)
source=root/'tables.docx';doc.save(source);original=source.read_bytes()
snapshot=inspect_document(str(source),limit=100,include_tables=True)
rows=[n for n in snapshot['locations'] if n['section']=='表格行' and n['table']==1]
cells=[n for n in snapshot['locations'] if n['section']=='表格单元格' and n['table']==1]
assert len(rows)==5 and not rows[0]['table_operations']
blank=next(n for n in cells if n['row']==3 and n['column']==3);assert blank['text']=='' and blank['table_operations']==['set_cell_text']
paragraph=next(n for n in snapshot['locations'] if n['location'].startswith('word/document.xml#p') and n['text']=='200')
assert paragraph['row']==3 and paragraph['column']==2 and paragraph['table']==1
def op(entry,kind,replace):return {'location':entry['location'],'type':kind,'find':entry['text'],'replace':replace}
ops=[op(blank,'set_cell_text','完成'),op(rows[1],'insert_row_after',json.dumps(['新增','300','进行中'],ensure_ascii=False)),op(rows[3],'delete_row',''),op(rows[4],'insert_row_before',json.dumps(['前插','450','已核对'],ensure_ascii=False))]
spec={'source_sha256':snapshot['source_sha256'],'output':str(root/'tables-edited.docx'),'operations':ops}
assert preview_document_edits(str(source),json.dumps(spec))['verified'] and not (root/'tables-edited.docx').exists()
result=edit_document(str(source),json.dumps(spec));assert result['changed_count']==4 and source.read_bytes()==original
updated=Document(result['output']);actual=[[c.text for c in row.cells] for row in updated.tables[0].rows]
assert actual==[values[0],values[1],['新增','300','进行中'],['填写','200','完成'],['前插','450','已核对'],values[4]],actual
assert updated.tables[0].rows[2].cells[0].paragraphs[0].runs[0].bold
assert updated.tables[0].rows[2].cells[0]._tc.tcPr.xml==table.rows[1].cells[0]._tc.tcPr.xml
assert updated.tables[0]._tbl.tblGrid.xml==table._tbl.tblGrid.xml
for before,after in zip(doc.tables[1:],updated.tables[1:]):assert before._tbl.xml==after._tbl.xml
with ZipFile(source) as a,ZipFile(result['output']) as b:
    for name in a.namelist():
        if name!='word/document.xml':assert a.read(name)==b.read(name),name

def rejected(operations,message):
    invalid=root/'table-invalid.docx'
    try:
        edit_document(str(source),json.dumps({'source_sha256':snapshot['source_sha256'],'output':str(invalid),'operations':operations}))
        raise AssertionError('invalid batch accepted')
    except ValueError as error:assert message in str(error),str(error)
    assert not invalid.exists() and source.read_bytes()==original
for row in [n for n in snapshot['locations'] if n['section']=='表格行' and n['table']>1]:
    assert not row['table_operations'],row
    rejected([op(row,'delete_row','')],'受保护')
rejected([op(rows[0],'insert_row_after','["a","b","c"]')],'受保护')
rejected([ops[1],ops[1]],'重叠')
rejected([ops[2],op(next(n for n in cells if n['row']==4),'set_cell_text','不该写入')],'重叠')
rejected([op(paragraph,'replace_text','201'),op(rows[2],'delete_row','')],'重叠')
rejected([ops[0],op(paragraph,'replace_text','201'),op(rows[2],'insert_row_after','["a","b","c"]')],'重叠')
rejected([ops[0],op(rows[1],'insert_row_after','["列数不对"]')],'列数相同')
rejected([{**ops[0],'find':'不是原文'}],'完整原文')
rejected([op(blank,'set_cell_text','多行\n内容')],'单段')
rejected([op(rows[3],'delete_row','不能非空')],'必须为空')
single=Document();single.add_paragraph('正文');single.add_table(rows=1,cols=1).cell(0,0).text='唯一行';single.save(root/'single-table.docx')
one=inspect_document(str(root/'single-table.docx'),include_tables=True);row=next(n for n in one['locations'] if n['section']=='表格行')
try:
    edit_document(str(root/'single-table.docx'),json.dumps({'source_sha256':one['source_sha256'],'output':str(root/'no-rows.docx'),'operations':[op(row,'delete_row','')]}))
    raise AssertionError('last row removed')
except ValueError as error:assert '保留一行' in str(error)
assert not (root/'no-rows.docx').exists()
print('Table cell/row edits, styles, locations, protected tables and atomic rejection passed')
