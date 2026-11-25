"""Search bounded local documents and return verifiable source locations."""
import csv
import io
import json
import re
import sys
import zipfile
from pathlib import Path

MAX_SEGMENTS = 10000


def segments(path):
    suffix = path.suffix.lower()
    if suffix in ('.docx', '.xlsx', '.xlsm', '.pptx'):
        with zipfile.ZipFile(path) as archive:
            if len(archive.infolist()) > 5000 or sum(item.file_size for item in archive.infolist()) > 60_000_000:
                raise ValueError('压缩包展开后过大，未检索')
    if suffix == '.docx':
        from docx import Document
        from docx.table import Table
        from docx.text.paragraph import Paragraph
        doc = Document(path)
        paragraph = table = 0
        for item in doc.element.body:
            if item.tag.endswith('}p'):
                paragraph += 1
                yield f'段落 {paragraph}', Paragraph(item, doc).text
            elif item.tag.endswith('}tbl'):
                table += 1
                for row, cells in enumerate(Table(item, doc).rows, 1):
                    yield f'表格 {table}，行 {row}', ' | '.join(cell.text for cell in cells.cells)
    elif suffix in ('.xlsx', '.xlsm'):
        from openpyxl import load_workbook
        book = load_workbook(path, read_only=True, data_only=False, keep_links=False)
        scanned = 0
        try:
            for sheet in book:
                for row in sheet.iter_rows():
                    scanned += len(row)
                    if scanned > 250_000:
                        raise ValueError('工作表范围过大，请拆分后检索')
                    for cell in row:
                        if cell.value is not None:
                            yield f'工作表「{sheet.title}」，单元格 {cell.coordinate}', str(cell.value)
        finally:
            book.close()
    elif suffix == '.pptx':
        from pptx import Presentation
        for number, slide in enumerate(Presentation(path).slides, 1):
            for index, shape in enumerate(slide.shapes, 1):
                if shape.has_text_frame:
                    yield f'幻灯片 {number}，文本框 {index}', shape.text
                if shape.has_table:
                    for row, cells in enumerate(shape.table.rows, 1):
                        yield f'幻灯片 {number}，表格行 {row}', ' | '.join(cell.text for cell in cells.cells)
    elif suffix == '.pdf':
        import fitz
        with fitz.open(path) as doc:
            if doc.needs_pass:
                raise ValueError('加密 PDF 需要先解密')
            for number, page in enumerate(doc, 1):
                yield f'页 {number}', page.get_text()
    else:
        raw = path.read_bytes()
        if raw.startswith((b'\xff\xfe', b'\xfe\xff')):
            text = raw.decode('utf-16')
        else:
            try:
                text = raw.decode('utf-8-sig')
            except UnicodeDecodeError:
                text = raw.decode('gb18030')
        if suffix == '.csv':
            csv.field_size_limit(1_000_000)
            for number, row in enumerate(csv.reader(io.StringIO(text)), 1):
                yield f'CSV 记录 {number}', ' | '.join(row)
        else:
            for number, line in enumerate(text.splitlines(), 1):
                yield f'行 {number}', line


def search(request):
    terms = list(dict.fromkeys(re.findall(r'\S+', request['query'])))
    hits, examined, warnings = [], [], []
    matched = 0
    for file in request['files']:
        count, characters, nonempty, limited = 0, 0, False, False
        try:
            for location, text in segments(Path(file['path'])):
                count += 1
                if count > MAX_SEGMENTS or characters > 2_000_000:
                    limited = True
                    break
                characters += len(text)
                nonempty = nonempty or bool(text.strip())
                if len(text) > 100000:
                    limited = True
                    text = text[:100000]
                matches = [match for term in terms if (match := re.search(re.escape(term), text, re.I))]
                positions = [match.start() for match in matches]
                if not positions:
                    continue
                matched += 1
                start = max(0, min(positions) - 70)
                excerpt = text[start:start+360]
                hits.append({'file': file['id'], 'name': file['name'], 'location': location,
                             'excerpt': excerpt, 'citation': f"[资料：{file['name']}；{location}]",
                             'score': len(positions)})
                if len(hits) > 2 * request['limit']:
                    hits.sort(key=lambda item: -item['score'])
                    del hits[request['limit']:]
            examined.append({'file': file['id'], 'segments': min(count, MAX_SEGMENTS), 'limited': limited})
            if limited:
                warnings.append({'file': file['id'], 'message': '超过单份 10000 个片段、200 万字符或单片段 10 万字符的检索范围，仅覆盖部分内容。'})
            if not nonempty:
                warnings.append({'file': file['id'], 'message': '未提取到可检索文字；扫描件或图片内容需要 OCR。'})
            if Path(file['path']).suffix.lower() in ('.xlsx', '.xlsm'):
                warnings.append({'file': file['id'], 'message': '公式按表达式检索，未重算公式或核实数值。'})
        except Exception as error:
            # File contents and host paths are never used as executable instructions.
            warnings.append({'file': file['id'], 'message': f'文件未完成检索（{type(error).__name__}），请检查格式、密码或读取依赖。'})
    hits.sort(key=lambda item: -item['score'])
    more = matched > request['limit']
    for hit in hits:
        hit.pop('score', None)
    return {'query': request['query'], 'results': hits[:request['limit']], 'files_examined': examined,
            'warnings': warnings, 'more_matches': more, 'coverage': 'matched_passages',
            'note': '结果为关键词匹配片段，未命中不代表资料不存在相关事实；引用位置来自实际解析。'}


if __name__ == '__main__':
    print(json.dumps(search(json.load(sys.stdin)), ensure_ascii=False))
