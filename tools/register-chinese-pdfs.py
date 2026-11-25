"""Bundle reviewed PDF renders and pin them in the Chinese catalogue."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'resources/templates'
catalog = json.loads((DEST / 'catalog.zh-CN.json').read_text(encoding='utf-8'))
for item in catalog:
    if item['id'] not in ('zh-notice', 'zh-work-plan'):
        continue
    filename = item['id'] + '-print.pdf'
    data = (ROOT / 'test-results/chinese-templates' / (item['id'] + '-final') / (item['id'] + '-document.pdf')).read_bytes()
    assert data.startswith(b'%PDF-')
    (DEST / filename).write_bytes(data)
    item['assets'] = [a for a in item['assets'] if a['id'] != 'print']
    item['assets'].append({'id': 'print', 'label': '中文 PDF 打印参考版', 'format': 'PDF', 'file': filename, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'derivedFrom': next(a['sha256'] for a in item['assets'] if a['id'] == 'document')})
(DEST / 'catalog.zh-CN.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('Registered 2 reviewed Chinese PDFs')
