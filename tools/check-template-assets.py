"""Read-only content checks for the bundled, unmodified Office/PDF originals."""
import json
import sys
from pathlib import Path
from zipfile import ZipFile
from docx import Document
from openpyxl import load_workbook
from pypdf import PdfReader

sys.stdout.reconfigure(encoding='utf-8')

ROOT = Path(__file__).resolve().parents[1] / 'resources' / 'templates'
catalog = [item for filename in ('catalog.json', 'catalog.zh-CN.json') for item in json.loads((ROOT / filename).read_text(encoding='utf-8'))]
errors = []
for template in catalog:
    for asset in template['assets']:
        path = ROOT / asset['file']
        result = {'file': asset['file'], 'format': asset['format']}
        if asset['format'] == 'DOCX':
            doc = Document(path)
            text = '\n'.join(p.text for p in doc.paragraphs) + '\n'.join(c.text for t in doc.tables for r in t.rows for c in r.cells)
            assert len(text) > 100
            result.update(paragraphs=len(doc.paragraphs), tables=len(doc.tables), textSample=text[:160])
        elif asset['format'] == 'XLSX':
            formulas = load_workbook(path, data_only=False)
            cached = load_workbook(path, data_only=True)
            result['sheets'] = []
            for sheet in formulas:
                cells = [c for row in sheet for c in row if c.value is not None]
                bad = [(c.coordinate, c.value) for row in cached[sheet.title] for c in row if c.data_type == 'e']
                result['sheets'].append({'name': sheet.title, 'rows': sheet.max_row, 'columns': sheet.max_column, 'formulas': sum(c.data_type == 'f' for c in cells), 'cachedErrors': bad})
                errors.extend((path.name, sheet.title, item) for item in bad)
            with ZipFile(path) as archive:
                assert not any('vbaProject' in name or name.startswith('xl/externalLinks/') for name in archive.namelist())
            formulas.close(); cached.close()
        elif asset['format'] == 'PDF':
            pdf = PdfReader(path)
            result.update(pages=len(pdf.pages), textSample=pdf.pages[0].extract_text()[:160], interactive=bool(pdf.get_fields()))
            assert not pdf.is_encrypted
        elif asset['format'] in ('DOC', 'XLS'):
            data = path.read_bytes()
            stream = 'WordDocument' if asset['format'] == 'DOC' else 'Workbook'
            assert data.startswith(bytes.fromhex('d0cf11e0a1b11ae1'))
            assert stream.encode('utf-16-le') in data
            result['stream'] = stream
        elif asset['format'] == 'MD':
            text = path.read_text(encoding='utf-8')
            result['headings'] = sum(line.startswith('#') for line in text.splitlines())
            assert 'MIT License' in text
        print(json.dumps(result, ensure_ascii=False))
if errors:
    raise SystemExit(f'Cached spreadsheet errors: {errors}')
