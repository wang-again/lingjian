"""Refresh the reviewed Chinese Markdown originals and pin their MIT provenance.

Downloads data only; no code from the source repository is installed or executed.
The separate catalogue is preserved when the English source importer is run.
"""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'resources' / 'templates'
REPO = 'zhaohui-yang/official-document-drafting'


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Lingjian-Template-Library/1.0'})
    with urllib.request.urlopen(request, timeout=45) as response:
        data = response.read(1_000_001)
    if not data or len(data) > 1_000_000:
        raise ValueError('Empty or oversized template')
    return data


def main():
    sources = json.loads((ROOT / 'tools/chinese-template-sources.json').read_text(encoding='utf-8'))
    commit = json.loads(fetch(f'https://api.github.com/repos/{REPO}/commits/main'))['sha']
    raw = f'https://raw.githubusercontent.com/{REPO}/{commit}'
    license_text = fetch(f'{raw}/LICENSE').decode('utf-8')
    assert 'MIT License' in license_text and 'Permission is hereby granted' in license_text
    DEST.mkdir(parents=True, exist_ok=True)
    (DEST / 'Chinese-Official-LICENSE.txt').write_text(license_text, encoding='utf-8')

    def download(item):
        slug = item.pop('upstream')
        path = f'assets/templates/{slug}.md'
        upstream = fetch(f'{raw}/{path}')
        text = upstream.decode('utf-8')
        assert text.lstrip().startswith('#') and len(text) > 100
        url = f'https://github.com/{REPO}/blob/{commit}/{path}'
        data = (text.rstrip() + f'\n\n<!--\nSource: {url}\n{license_text}\n-->\n').encode('utf-8')
        filename = item['id'] + '-markdown.md'
        (DEST / filename).write_bytes(data)
        item.update(language='中文', description=f'中文开源文书模板，包含可替换字段与正文结构，适合{item["title"]}的初稿整理。使用前按本单位要求核定格式与占位内容。',
            usage=['先替换方括号内的单位、日期、人员与事项等占位内容。', '补充实际资料后，可在编辑器起草或加入文件库让 AI 另存填写。', '确认事实、数字和办理要求，删除不适用的字段；保留来源许可。'],
            source={'name': 'official-document-drafting 中文文书模板', 'url': url, 'license': 'MIT', 'licenseUrl': f'https://github.com/{REPO}/blob/{commit}/LICENSE', 'licenseFile': 'Chinese-Official-LICENSE.txt', 'attribution': 'Copyright (c) 2026 official-document-drafting contributors', 'checkedAt': '2026-11-11', 'upstreamCommit': commit},
            assets=[{'id': 'markdown', 'label': '中文 Markdown 原版', 'format': 'MD', 'file': filename, 'sourceUrl': f'{raw}/{path}', 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'upstreamSha256': hashlib.sha256(upstream).hexdigest()}])
        return item

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        catalog = list(pool.map(download, sources))
    (DEST / 'catalog.zh-CN.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Imported {len(catalog)} Chinese templates at {commit}')


if __name__ == '__main__':
    main()
