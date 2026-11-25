"""Real DOCX/PDF regression proof, invoked by Node's integration test."""
import json
import os
import sys
from pathlib import Path
from zipfile import ZipFile
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from PIL import Image
import fitz

project = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(project / (os.environ.get('OFFICE_TOOL_DIR') or '.vendor/office-tool')))
from tools.document_editing import inspect_document, edit_document
from tools.word_tools import _replace_in_paragraph

root = Path(sys.argv[1]); root.mkdir(parents=True, exist_ok=True)
doc = Document()
p = doc.add_paragraph()
p.add_run('费用：').bold = True
p.add_run('100')
p.add_run('元').italic = True
p.add_run('（含税）').underline = True
doc.add_table(rows=1, cols=1).cell(0,0).text = '费用100元'
doc.sections[0].header.paragraphs[0].text = '页眉100元'
footer = doc.sections[0].footer.paragraphs[0]
footer.add_run('公司100元 ')
field = OxmlElement('w:fldSimple'); field.set(qn('w:instr'), 'PAGE')
run = OxmlElement('w:r'); text = OxmlElement('w:t'); text.text='1'; run.append(text); field.append(run); footer._p.append(field)
Image.new('RGB',(32,32),'blue').save(root/'logo.png')
doc.add_picture(str(root/'logo.png'))
source = root/'source.docx'; doc.save(source)
original = source.read_bytes()
snapshot = inspect_document(str(source))
ops = [{'location':item['location'],'find':'100','replace':'200'} for item in snapshot['locations'] if '100' in item['text']]
edited = root/'edited.docx'
result = edit_document(str(source),json.dumps({'source_sha256':snapshot['source_sha256'],'output':str(edited),'operations':ops}))
assert result['changed_count']==4 and result['verified']
assert source.read_bytes()==original
with ZipFile(source) as a, ZipFile(edited) as b:
    assert a.namelist()==b.namelist()
    for name in a.namelist():
        if name not in ('word/document.xml','word/header1.xml','word/footer1.xml'):
            assert a.read(name)==b.read(name), name
updated = Document(edited)
assert [(r.text,r.bold,r.italic,r.underline) for r in updated.paragraphs[0].runs] == [('费用：',True,None,None),('200',None,None,None),('元',None,True,None),('（含税）',None,None,True)]
assert 'PAGE' in updated.sections[0].footer._element.xml
# The legacy replacement path must preserve the same unaffected styles.
_replace_in_paragraph(p,'100元','300元')
assert p.runs[0].text=='费用：' and p.runs[-1].underline

def rejected(path, spec, message):
    try:
        edit_document(str(path),json.dumps(spec))
        raise AssertionError('Invalid edit was accepted')
    except ValueError as error:
        assert message in str(error), str(error)
    assert not (root/'invalid.docx').exists() and not (root/'invalid.pdf').exists()

base={'source_sha256':snapshot['source_sha256'],'output':str(root/'invalid.docx')}
rejected(source,{**base,'source_sha256':'stale','operations':ops},'快照')
rejected(source,{**base,'operations':[{**ops[0],'find':'不存在'}]},'找到 0')
rejected(source,{**base,'operations':[ops[0],ops[0]]},'重叠')

pdf=fitz.open(); page=pdf.new_page(width=600,height=400)
page.draw_rect((20,20,580,380),color=(0,0,1),fill=(0.95,0.95,0.95))
page.insert_image((400,50,450,100),filename=str(root/'logo.png'))
page.insert_text((50,100),'Budget 100 EUR',fontsize=12)
page.insert_text((50,140),'Budget 100 EUR',fontsize=12)
page.insert_text((50,180),'中文甲方',fontname='china-s',fontsize=12)
pdf.new_page().insert_text((50,50),'Unchanged page')
pdf.save(root/'source.pdf'); pdf.close()
source=root/'source.pdf'; original=source.read_bytes(); snapshot=inspect_document(str(source),'Budget')
assert snapshot['matched_locations']==2
base={'source_sha256':snapshot['source_sha256'],'output':str(root/'invalid.pdf')}
rejected(source,{**base,'operations':[{'find':'100','replace':'200'}]},'找到 2')
location=snapshot['locations'][0]['location']
rejected(source,{**base,'operations':[{'location':location,'find':'100','replace':'This cannot fit in the old area'}]},'新文字宽')
result=edit_document(str(source),json.dumps({**base,'output':str(root/'edited.pdf'),'operations':[{'location':location,'find':'100','replace':'200'}]}))
assert result['verified'] and source.read_bytes()==original
with fitz.open(source) as a, fitz.open(root/'edited.pdf') as b:
    assert len(a)==len(b)==2
    assert 'Budget 200 EUR' in b[0].get_text(sort=True)
    assert 'Budget 100 EUR' in b[0].get_text(sort=True)
    assert len(a[0].get_images())==len(b[0].get_images())==1
    assert fitz.Pixmap(a,a[0].get_images()[0][0]).samples==fitz.Pixmap(b,b[0].get_images()[0][0]).samples
    assert len(a[0].get_drawings())==len(b[0].get_drawings())
    assert a[1].get_pixmap().samples==b[1].get_pixmap().samples
chinese=inspect_document(str(source),'中文甲方')
edit_document(str(source),json.dumps({'source_sha256':chinese['source_sha256'],'output':str(root/'chinese.pdf'),'operations':[{'location':chinese['locations'][0]['location'],'find':'甲方','replace':'乙方'}]}))
print('Word formats, headers, tables, fields, images, PDF Chinese, duplicate targeting, overflow and unchanged pages passed')
