"""Real OOXML proof for reviewed paragraph edits and protected content."""
import json
import os
import sys
from pathlib import Path
from zipfile import ZipFile
from lxml import etree
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt
from PIL import Image
import fitz

project = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(project / (os.environ.get('OFFICE_TOOL_DIR') or '.vendor/office-tool')))
from tools.document_editing import inspect_document, edit_document, preview_document_edits

root = Path(sys.argv[1]); root.mkdir(parents=True, exist_ok=True)
doc = Document()
before = doc.add_paragraph('段前参考。'); before.alignment = WD_ALIGN_PARAGRAPH.CENTER
before.paragraph_format.space_after = Pt(10); before.runs[0].bold = True
before._p.set('{http://schemas.microsoft.com/office/word/2010/wordml}paraId', '00000001')
doc.add_paragraph('段后参考。')
doc.add_paragraph('需要删除的段落。')
split = doc.add_paragraph(); split.add_run('第一句。').bold = True; split.add_run('第二句。').italic = True
split._p.set('{http://schemas.microsoft.com/office/word/2010/wordml}paraId', '00000002')
doc.add_paragraph('金额100元。')
doc.add_table(rows=1, cols=1).cell(0,0).text = '表格受保护。'
doc.sections[0].header.paragraphs[0].text = '页眉受保护。'
Image.new('RGB', (20,20), 'blue').save(root/'paragraph_logo.png')
pic = doc.add_paragraph('图片段落。'); pic.add_run().add_picture(str(root/'paragraph_logo.png'))
num = doc.add_paragraph('编号段落。', style='List Number')
custom = doc.styles.add_style('InheritedNumber', WD_STYLE_TYPE.PARAGRAPH); custom.base_style = doc.styles['List Number']
doc.add_paragraph('继承编号。', style=custom)
section = doc.add_paragraph('分节段落。'); section._p.get_or_add_pPr().append(OxmlElement('w:sectPr'))
tracked = doc.add_paragraph(); revision = OxmlElement('w:ins'); revision.set(qn('w:id'),'3')
run = OxmlElement('w:r'); text = OxmlElement('w:t'); text.text='已有修订。'; run.append(text); revision.append(run); tracked._p.append(revision)
start = doc.add_paragraph('书签开头。'); marker = OxmlElement('w:bookmarkStart'); marker.set(qn('w:id'),'7'); marker.set(qn('w:name'),'range'); start._p.append(marker)
doc.add_paragraph('书签覆盖的中间段。')
end = doc.add_paragraph('书签结尾。'); marker = OxmlElement('w:bookmarkEnd'); marker.set(qn('w:id'),'7'); end._p.append(marker)
start = doc.add_paragraph(); node = OxmlElement('w:fldChar'); node.set(qn('w:fldCharType'),'begin'); start.add_run()._r.append(node)
doc.add_paragraph('跨段落域结果。')
end = doc.add_paragraph(); node = OxmlElement('w:fldChar'); node.set(qn('w:fldCharType'),'end'); end.add_run()._r.append(node)
mixed = doc.add_paragraph(); mixed.add_run('首片段普通。'); mixed.add_run('后片段加粗。').bold = True
source = root/'paragraphs.docx'; doc.save(source)
original = source.read_bytes(); snapshot = inspect_document(str(source), limit=100)
by_text = {item['text']:item for item in snapshot['locations']}

def op(text, kind, replacement):
    return {'type':kind,'location':by_text[text]['location'],'find':text,'replace':replacement}

ops = [op('段前参考。','insert_before','新插入的段前内容。'), op('段后参考。','insert_after','新插入的段后内容。'),
       op('需要删除的段落。','delete_paragraph',''), op('第一句。第二句。','split_paragraph','第一\n句。第二句。'),
       op('金额100元。','replace_text','金额200元。')]
spec = {'source_sha256':snapshot['source_sha256'],'output':str(root/'paragraphs-edited.docx'),'operations':ops}
assert preview_document_edits(str(source),json.dumps(spec))['verified']
assert not (root/'paragraphs-edited.docx').exists()
result = edit_document(str(source),json.dumps(spec))
assert result['changed_count']==5 and source.read_bytes()==original
updated = Document(result['output'])
assert [p.text for p in updated.paragraphs[:7]] == ['新插入的段前内容。','段前参考。','段后参考。','新插入的段后内容。','第一','句。第二句。','金额200元。']
assert updated.paragraphs[0].alignment == before.alignment
assert updated.paragraphs[0].paragraph_format.space_after == Pt(10)
assert updated.paragraphs[0].runs[0].bold
assert [(r.text,r.bold,r.italic) for r in updated.paragraphs[4].runs] == [('第一',True,None)]
assert [(r.text,r.bold,r.italic) for r in updated.paragraphs[5].runs] == [('句。',True,None),('第二句。',None,True)]
assert updated.paragraphs[4]._p.get('{http://schemas.microsoft.com/office/word/2010/wordml}paraId')=='00000002'
assert updated.paragraphs[5]._p.get('{http://schemas.microsoft.com/office/word/2010/wordml}paraId') is None
assert updated.paragraphs[0]._p.get('{http://schemas.microsoft.com/office/word/2010/wordml}paraId') is None
with ZipFile(source) as a, ZipFile(result['output']) as b:
    for name in a.namelist():
        if name != 'word/document.xml':
            assert a.read(name)==b.read(name), name
    old=etree.fromstring(a.read('word/document.xml')); new=etree.fromstring(b.read('word/document.xml'))
    for tag in ['tbl','drawing','sectPr','bookmarkStart','bookmarkEnd','fldChar','ins']:
        assert [etree.tostring(n) for n in old.iter(qn('w:'+tag))]==[etree.tostring(n) for n in new.iter(qn('w:'+tag))], tag

def rejected(operations, message):
    invalid=root/'paragraphs-invalid.docx'
    try:
        edit_document(str(source),json.dumps({'source_sha256':snapshot['source_sha256'],'output':str(invalid),'operations':operations}))
        raise AssertionError('invalid edit accepted')
    except ValueError as error:
        assert message in str(error), str(error)
    assert not invalid.exists() and source.read_bytes()==original

for text in ['表格受保护。','页眉受保护。','图片段落。\ufffc','编号段落。','继承编号。','分节段落。','已有修订。','书签覆盖的中间段。','跨段落域结果。']:
    assert not by_text[text]['paragraph_operations'], text
    rejected([op(text,'delete_paragraph','')], '受保护')
for operations, message in [
    ([ops[0], ops[0]],'重叠'),
    ([ops[0],op('段前参考。','replace_text','替换文字。')],'重叠'),
    ([op('段前参考。','replace_text','替换文字。'),ops[0]],'重叠'),
    ([{**ops[2],'find':'需要删除'}],'完整原文'),
    ([{**ops[2],'replace':'不可非空'}],'必须为空'),
    ([{**ops[3],'replace':'第一句。\n改了字'}],'文字保持一致'),
    ([{**ops[3],'replace':'\n第一句。第二句。'}],'均须非空'),
    ([{**ops[0],'replace':'第一行\n第二行'}],'一个非空普通段落'),
    ([{**ops[0],'type':'unknown'}],'不支持'),
]: rejected(operations,message)

# Deleting the last body paragraph must not leave a structurally empty document.
single=Document(); single.add_paragraph('唯一正文。'); single.save(root/'single.docx')
single_snapshot=inspect_document(str(root/'single.docx'))
try:
    edit_document(str(root/'single.docx'),json.dumps({'source_sha256':single_snapshot['source_sha256'],'output':str(root/'empty.docx'),'operations':[{'type':'delete_paragraph','location':single_snapshot['locations'][0]['location'],'find':'唯一正文。','replace':''}]}))
    raise AssertionError('empty body accepted')
except ValueError as error: assert '至少' in str(error)
assert not (root/'empty.docx').exists()

# Insertion inherits the FIRST text run, even when a later run has direct formatting.
style_result=edit_document(str(source),json.dumps({'source_sha256':snapshot['source_sha256'],'output':str(root/'first-style.docx'),'operations':[op('首片段普通。后片段加粗。','insert_after','新增普通文字。')]}))
assert next(p for p in Document(style_result['output']).paragraphs if p.text=='新增普通文字。').runs[0].bold is None

# A numbering definition inherited through the default paragraph style is protected too.
default_doc=Document(); default_doc.add_paragraph('默认编号正文。')
num_pr=OxmlElement('w:numPr'); num_id=OxmlElement('w:numId'); num_id.set(qn('w:val'),'1'); num_pr.append(num_id)
default_doc.styles['Normal'].element.get_or_add_pPr().append(num_pr); default_doc.save(root/'default-number.docx')
assert not inspect_document(str(root/'default-number.docx'))['locations'][0]['paragraph_operations']

pdf=fitz.open(); pdf.new_page().insert_text((50,50),'Budget 100'); pdf.save(root/'paragraph.pdf'); pdf.close()
pdf_snapshot=inspect_document(str(root/'paragraph.pdf'))
try:
    edit_document(str(root/'paragraph.pdf'),json.dumps({'source_sha256':pdf_snapshot['source_sha256'],'output':str(root/'paragraph-invalid.pdf'),'operations':[{'type':'insert_after','location':pdf_snapshot['locations'][0]['location'],'find':'Budget 100','replace':'New paragraph'}]}))
    raise AssertionError('PDF paragraph edit accepted')
except ValueError as error: assert 'PDF 仅支持' in str(error)
assert not (root/'paragraph-invalid.pdf').exists()
print('Paragraph insert/delete/split, run styles, protected objects and atomic rejection passed')
