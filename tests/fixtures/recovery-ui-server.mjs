// Disposable, isolated UI fixture: no real account data or paid model requests.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server.mjs';
const directory = process.env.QA_DATA_DIR || await mkdtemp(join(tmpdir(), 'lingjian-recovery-ui-'));
const app = await createApp({ authMode: 'local', dataDir: directory, port: 3217 });
const doc = app.store.state.documents[0];
await writeFile(join(directory, 'sample-backup.json'), JSON.stringify({ product: 'lingjian', version: 1, documents: [{ ...doc, title: '备份导入验收', html: '<h2>恢复标题</h2><p>备份正文</p>', sources: [{ id: 'ref-one', name: '背景.txt', text: '验收资料', enabled: true }] }] }));
console.log(JSON.stringify({ url: app.url, backupFile: join(directory, 'sample-backup.json') }));
const close = () => app.close().then(() => process.exit(0));
process.once('SIGINT', close); process.once('SIGTERM', close);
