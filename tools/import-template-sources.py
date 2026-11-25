"""Fetch the reviewed template allowlist, validate formats, and pin local hashes.

Run explicitly when refreshing the bundled library; the application never fetches
remote templates at startup. Record upstream hashes before local cleanup and retain licence notices.
"""
import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import urllib.request
from xml.dom import minidom
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'resources' / 'templates'
SOURCES = json.loads((ROOT / 'tools' / 'template-sources.json').read_text(encoding='utf-8'))
WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Lingjian-Template-Library/1.0'})
    with urllib.request.urlopen(request, timeout=45) as response:
        data = response.read(5_000_001)
    if not data or len(data) > 5_000_000:
        raise ValueError('Empty or oversized template')
    return data


def validate(data, extension):
    if extension in ('doc', 'xls'):
        if not data.startswith(bytes.fromhex('d0cf11e0a1b11ae1')):
            raise ValueError('Expected a genuine OLE Office binary')
    elif extension in ('docx', 'xlsx'):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if archive.testzip():
                raise ValueError('Damaged ZIP member')
            names = archive.namelist()
            expected = 'word/document.xml' if extension == 'docx' else 'xl/workbook.xml'
            if expected not in names or any('vbaProject' in name for name in names):
                raise ValueError('Unexpected Office format or VBA project')
    elif extension == 'pdf':
        if not data.startswith(b'%PDF-'):
            raise ValueError('Expected a PDF file')
    elif extension == 'md':
        if not data.decode('utf-8').lstrip().startswith('#'):
            raise ValueError('Expected a Markdown document')
    else:
        raise ValueError('Unsupported extension')


def strip_local_word_template(data):
    """Remove the original editor's local attachment without changing document content."""
    settings_name = 'word/settings.xml'
    rels_name = 'word/_rels/settings.xml.rels'
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if rels_name not in archive.namelist():
            return data
        rels = minidom.parseString(archive.read(rels_name))
        removed = set()
        for node in rels.getElementsByTagNameNS(PACKAGE_REL_NS, 'Relationship'):
            if (node.getAttribute('Type') == REL_NS + '/attachedTemplate'
                    and node.getAttribute('TargetMode') == 'External'
                    and node.getAttribute('Target').lower().startswith('file:')):
                removed.add(node.getAttribute('Id'))
                node.parentNode.removeChild(node)
        if not removed:
            return data
        settings = minidom.parseString(archive.read(settings_name))
        for node in settings.getElementsByTagNameNS(WORD_NS, 'attachedTemplate'):
            if node.getAttributeNS(REL_NS, 'id') in removed:
                node.parentNode.removeChild(node)
        replacements = {
            settings_name: settings.toxml(encoding='utf-8', standalone=settings.standalone),
            rels_name: rels.toxml(encoding='utf-8', standalone=rels.standalone),
        }
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as cleaned:
            for member in archive.infolist():
                content = replacements[member.filename] if member.filename in replacements else archive.read(member)
                cleaned.writestr(member, content)
        return output.getvalue()


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    licence = fetch('https://raw.githubusercontent.com/Fokuus/markdown-templates/main/LICENSE').decode('utf-8')
    (DEST / 'Fokuus-LICENSE.txt').write_text(licence, encoding='utf-8')
    tasks = [(template, asset) for template in SOURCES for asset in template['assets']]

    def download(task):
        template, asset = task
        data = fetch(asset['sourceUrl'])
        validate(data, asset['format'].lower())
        asset['upstreamSha256'] = hashlib.sha256(data).hexdigest()
        if asset['format'] == 'MD':
            data += ('\n\n<!--\nSource: ' + template['source']['url'] + '\n' + licence + '\n-->\n').encode('utf-8')
        elif asset['format'] == 'DOCX':
            data = strip_local_word_template(data)
        asset['file'] = template['id'] + '-' + asset['id'] + '.' + asset['format'].lower()
        (DEST / asset['file']).write_bytes(data)
        asset['size'] = len(data)
        asset['sha256'] = hashlib.sha256(data).hexdigest()
        print(asset['file'], len(data), flush=True)

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(download, tasks))
    (DEST / 'catalog.json').write_text(json.dumps(SOURCES, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Imported {len(tasks)} assets in {len(SOURCES)} templates.')


if __name__ == '__main__':
    main()
