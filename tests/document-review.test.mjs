import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { integrationMissing } from './fixtures/office-runtime.mjs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { OfficeService } from '../lib/office.mjs';
import { applyDocumentReview } from '../lib/document-review.mjs';
import { validateProvider } from '../lib/providers.mjs';
import { createTestApp, listenHttp } from './fixtures/http.mjs';

const python = process.env.OFFICE_PYTHON || resolve('.venv-office', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
test('审阅修改 HTTP 闭环：两种协议、Word/PDF、选择应用、预检冲突、过期与账号边界', { skip: integrationMissing, timeout: 90000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lingjian-review-'));
  const app = await createTestApp({ dataDir: directory });
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('lingjian-review-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await promisify(execFile)(python, [resolve('tests/fixtures/editing_regression.py'), join(directory, 'fixtures')], { windowsHide: true });
  await promisify(execFile)(python, [resolve('tests/fixtures/paragraph_regression.py'), join(directory, 'fixtures')], { windowsHide: true });
  await promisify(execFile)(python, [resolve('tests/fixtures/table_regression.py'), join(directory, 'fixtures')], { windowsHide: true });
  await promisify(execFile)(python, [resolve('tests/fixtures/package_regression.py'), join(directory, 'fixtures')], { windowsHide: true });
  let scenario = 'normal';
  const mock = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body), responses = req.url.endsWith('/responses');
    const tools = input.tools.map(tool => tool.name || tool.function?.name);
    assert.deepEqual(tools, ['inspect_document', 'submit_document_review']);
    const history = responses ? input.input : input.messages;
    const outputs = history.filter(item => item.role === 'tool' || item.type === 'function_call_output');
    const context = JSON.parse(history.find(item => item.role === 'user').content);
    let call;
    if (!outputs.length) call = { name: 'inspect_document', args: { file_path: scenario === 'escape' ? 'unselected.docx' : context.selectedFiles[0].id, query: /^(paragraph|table|spreadsheet|slides)/.test(scenario) ? '' : '100', limit:100, include_tables:scenario.startsWith('table'), ...(scenario.startsWith('spreadsheet')?{sheet_name:'预算表',cell_range:'B2:C4'}:{}) } };
    else if (outputs.length === 1 && scenario !== 'escape') {
      const snapshot = JSON.parse(outputs[0].content || outputs[0].output);
      const ops = snapshot.locations.slice(0, 2).map(item => ({ location: item.location, find: '100', replace: '200', reason: '按用户要求调整金额' }));
      if (scenario === 'overlap') ops.push(ops[0]);
      if (scenario === 'unread') ops[0].location = 'word/document.xml#p999';
      if (scenario === 'overflow') ops[0].replace = 'This replacement is much too long for the original PDF area';
      if (scenario.startsWith('paragraph')) {
        const build = (text,type,replace) => ({type,location:snapshot.locations.find(item=>item.text===text).location,find:text,replace,reason:'按用户指定调整段落结构'});
        ops.splice(0,ops.length,
          build('段前参考。','insert_before','审阅新增段前。'),build('段后参考。','insert_after','审阅新增段后。'),
          build('需要删除的段落。','delete_paragraph',''),build('第一句。第二句。','split_paragraph','第一句。\n第二句。'));
        if(scenario==='paragraph_protected')ops.splice(0,ops.length,build('表格受保护。','delete_paragraph',''));
        if(scenario==='paragraph_partial')ops[0].find='段前参考';
        if(scenario==='paragraph_overlap')ops.push({...ops[0],type:'replace_text',replace:'文字替换'});
        if(scenario==='paragraph_splitbad')ops[3].replace='第一句。\n改写了原文';
      }
      if(scenario.startsWith('table')){
        const row=n=>snapshot.locations.find(item=>item.section==='表格行'&&item.table===1&&item.row===n);
        const cell=snapshot.locations.find(item=>item.section==='表格单元格'&&item.table===1&&item.row===3&&item.column===3);
        const build=(entry,type,replace)=>({location:entry.location,find:entry.text,type,replace,reason:'按要求调整表格'});
        ops.splice(0,ops.length,build(cell,'set_cell_text','完成'),build(row(2),'insert_row_after',JSON.stringify(['新增','300','进行中'])),build(row(4),'delete_row',''),build(row(5),'insert_row_before',JSON.stringify(['前插','450','已核对'])));
        if(scenario==='table_protected')ops.splice(0,ops.length,build(row(1),'delete_row',''));
        if(scenario==='table_partial')ops[2].find='删除';
        if(scenario==='table_overlap')ops.push(build(row(3),'delete_row',''));
        if(scenario==='table_columns')ops[1].replace='["只有一列"]';
      }
      if(scenario.startsWith('spreadsheet')){
        const cell=n=>snapshot.locations.find(item=>item.cell===n);
        const build=(entry,replace,value_type)=>({location:entry.location,find:entry.text,type:'set_spreadsheet_cell',replace,value_type,reason:'按要求更新预算与状态'});
        ops.splice(0,ops.length,build(cell('B2'),'500','number'),build(cell('C2'),'完成','string'));
        if(scenario==='spreadsheet_protected')ops.splice(0,ops.length,build(cell('B4'),'0','number'));
        if(scenario==='spreadsheet_number')ops[0].replace='不是数字';
      }
      if(scenario.startsWith('slides')){
        ops.splice(0,ops.length,...snapshot.locations.filter(item=>item.text==='预算100元').map((item,i)=>({location:item.location,find:'100',replace:String(200+i*100),type:'replace_slide_text',reason:'按要求更新幻灯片预算'})));
        if(scenario==='slides_protected'){const item=snapshot.locations.find(item=>item.text==='受保护链接');ops.splice(0,ops.length,{location:item.location,find:'链接',replace:'文字',type:'replace_slide_text',reason:'测试受保护文字'});}
        if(scenario==='slides_overlap')ops.push(ops[0]);
      }
      call = { name: 'submit_document_review', args: { source_sha256: snapshot.source_sha256, summary: '建议修改两处金额，尚未应用。', operations: ops } };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responses ? { status: 'completed', output: call ? [{ type: 'function_call', call_id: `c${outputs.length}`, name: call.name, arguments: JSON.stringify(call.args) }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '当前建议未通过核验，未执行修改。' }] }] } : { choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: call ? { role: 'assistant', tool_calls: [{ id: `c${outputs.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { role: 'assistant', content: '当前建议未通过核验，未执行修改。' } }] }));
  });
  await listenHttp(mock);
  t.after(() => new Promise(resolve => { mock.closeAllConnections(); mock.close(resolve); }));
  const token = (await (await fetch(`${app.url}/api/bootstrap`)).json()).token;
  const post = (path, body, authenticated = true) => fetch(`${app.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'X-Workspace-Token': token } : {}) }, body: JSON.stringify(body) });
  const files = {};
  for (const extension of ['docx', 'pdf']) files[extension] = await app.office.upload(`原件.${extension}`, (await readFile(join(directory, `fixtures/source.${extension}`))).toString('base64'));
  files.paragraphs = await app.office.upload('段落原件.docx',(await readFile(join(directory,'fixtures/paragraphs.docx'))).toString('base64'));
  files.tables = await app.office.upload('表格原件.docx',(await readFile(join(directory,'fixtures/tables.docx'))).toString('base64'));
  for(const ext of ['xlsx','pptx'])files[ext]=await app.office.upload(`原件.${ext}`,(await readFile(join(directory,`fixtures/precise.${ext}`))).toString('base64'));
  async function propose(file, protocol = 'chat') {
    const config = validateProvider({ id: 'review-provider', name: 'review', model: 'fixture', protocol, baseUrl: `http://127.0.0.1:${mock.address().port}/v1` });
    app.store.state.providers = [config];
    const response = await post('/api/office/agent', { providerId: config.id, prompt: '把两处100修改为200，先给我修改建议', files: [file.id], review: true });
    assert.equal(response.status, 200);
    const events = (await response.text()).split('\n\n').filter(block => block.startsWith('event:')).map(block => ({ kind: /^event: (.+)$/m.exec(block)[1], data: JSON.parse(/^data: (.+)$/m.exec(block)[1]) }));
    assert.ok(!events.some(event => event.kind === 'error'), JSON.stringify(events));
    return events.find(event => event.kind === 'review')?.data;
  }
  for (const protocol of ['chat', 'responses']) for (const extension of ['docx', 'pdf']) {
    await t.test(`${protocol} ${extension} 只接受第一项，不改原件`, async () => {
      const file = files[extension], original = await readFile(await app.office.safePath(file.id));
      const before = await app.office.listFiles();
      const sourceLocations = (await app.office.call('inspect_document', { file_path: file.id })).data.locations;
      const plan = await propose(file, protocol);
      assert.equal(plan.operations.length, 2);
      assert.deepEqual(await app.office.listFiles(), before, '生成建议不能保存修订文件');
      assert.equal((await post('/api/office/review/apply', { reviewId: plan.id, operationIds: [] })).status, 400);
      assert.equal((await post('/api/office/review/apply', { reviewId: plan.id, operationIds: ['1', '1'] })).status, 400);
      assert.equal((await post('/api/office/review/apply', { reviewId: plan.id, operationIds: ['999'] })).status, 400);
      assert.equal((await post('/api/office/review/apply', { reviewId: plan.id, operationIds: ['1'] }, false)).status, 403);
      const response = await post('/api/office/review/apply', { reviewId: plan.id, operationIds: ['1'], operations: [{ replace: 'evil' }] });
      assert.equal(response.status, 200, await response.clone().text());
      const applied = await response.json();
      assert.equal(applied.edit.changed_count, 1);
      assert.notEqual(applied.edit.output, file.id);
      const after = (await app.office.call('inspect_document', { file_path: applied.edit.output })).data;
      for (const [index, text] of ['200', '100'].entries()) {
        const source = sourceLocations.find(item => item.location === plan.operations[index].location);
        const targetText = extension === 'docx' ? after.locations.find(item => item.location === source.location).text : after.locations.filter(item => item.page === source.page && Math.abs(item.bbox[1] - source.bbox[1]) < 1).map(item => item.text).join('');
        assert.ok(targetText.includes(text), targetText);
      }
      assert.deepEqual(await readFile(await app.office.safePath(file.id)), original);
      const retry = await post('/api/office/review/apply', { reviewId: plan.id, operationIds: ['1'] });
      assert.equal(retry.status, 200);
      const receipt = await retry.json();
      assert.equal(receipt.edit.output, applied.edit.output);
      assert.equal(receipt.edit.sha256, applied.edit.sha256);
      if (extension === 'docx') assert.ok(applied.check);
    });
  }
  await t.test('重叠、未定位原文、PDF放不下、越界读取均不产生可应用建议', async () => {
    for (const mode of ['overlap', 'unread', 'overflow', 'escape']) {
      scenario = mode;
      const before = await app.office.listFiles();
      assert.equal(await propose(mode === 'overflow' ? files.pdf : files.docx), undefined);
      assert.deepEqual(await app.office.listFiles(), before);
    }
    scenario = 'normal';
  });
  await t.test('快照失效、其他账号及过期建议阻止应用', async () => {
    const plan = await propose(files.docx);
    const other = new OfficeService(join(directory, 'other'));
    await assert.rejects(applyDocumentReview(other, { reviewId: plan.id, operationIds: ['1'] }), /过期/);
    const path = await app.office.safePath(files.docx.id), original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from('\n')]));
    const before = await app.office.listFiles();
    const stale = await post('/api/office/review/apply', { reviewId: plan.id, operationIds: ['1'] });
    assert.equal(stale.status, 422); assert.match(await stale.text(), /快照/);
    assert.deepEqual(await app.office.listFiles(), before);
    await writeFile(path, original);
    const clock = Date.now;
    Date.now = () => clock() + 31 * 60_000;
    try { await assert.rejects(applyDocumentReview(app.office, { reviewId: plan.id, operationIds: ['1'] }), /过期/); }
    finally { Date.now = clock; }
  });
  await t.test('重复并发应用只生成一份副本', async () => {
    const plan = await propose(files.docx);
    const before = await app.office.listFiles();
    const results = await Promise.all([post('/api/office/review/apply', { reviewId: plan.id, operationIds: ['1'] }), post('/api/office/review/apply', { reviewId: plan.id, operationIds: ['2'] })]);
    assert.deepEqual(results.map(result=>result.status).sort(), [200,409]);
    const after = await app.office.listFiles();
    assert.equal(after.filter(file=>/\.docx$/i.test(file.id)).length, before.filter(file=>/\.docx$/i.test(file.id)).length+1);
  });
  for(const protocol of ['chat','responses']) await t.test(`${protocol} 段落建议可逐条选择，插入删除拆分均保留原件`,async()=>{
    scenario='paragraphs';
    const original=await readFile(await app.office.safePath(files.paragraphs.id)),before=await app.office.listFiles();
    const plan=await propose(files.paragraphs,protocol);
    assert.equal(plan.operations.length,4);
    assert.deepEqual(await app.office.listFiles(),before);
    const operationIds=protocol==='chat'?['1','2','3','4']:['1','3','4'];
    const response=await post('/api/office/review/apply',{reviewId:plan.id,operationIds});
    assert.equal(response.status,200,await response.clone().text());
    const applied=await response.json();assert.equal(applied.edit.changed_count,operationIds.length);
    const after=(await app.office.call('inspect_document',{file_path:applied.edit.output,limit:100})).data.locations.map(item=>item.text);
    assert.ok(after.includes('审阅新增段前。'));
    assert.equal(after.includes('审阅新增段后。'),protocol==='chat');
    assert.ok(!after.includes('需要删除的段落。'));
    assert.ok(after.includes('第一句。')&&after.includes('第二句。'));
    assert.ok(after.includes('表格受保护。')&&after.includes('金额100元。'));
    assert.deepEqual(await readFile(await app.office.safePath(files.paragraphs.id)),original);
    scenario='normal';
  });
  await t.test('不允许结构操作、原文不完整、段落与文字重叠和错误拆分均拒绝建议',async()=>{
    for(const mode of ['paragraph_protected','paragraph_partial','paragraph_overlap','paragraph_splitbad']){
      scenario=mode;const before=await app.office.listFiles();
      assert.equal(await propose(files.paragraphs),undefined);
      assert.deepEqual(await app.office.listFiles(),before);
    }
    scenario='normal';
  });
  for(const protocol of ['chat','responses'])await t.test(`${protocol} 表格审阅到另存闭环，只执行勾选单元格与行修改`,async()=>{
    scenario='table';const original=await readFile(await app.office.safePath(files.tables.id)),before=await app.office.listFiles();
    const plan=await propose(files.tables,protocol);assert.equal(plan.operations.length,4);
    assert.equal(plan.operations[0].position,'表格 1 · 第 3 行 · 第 3 列');assert.deepEqual(plan.operations[1].after_cells,['新增','300','进行中']);
    assert.deepEqual(await app.office.listFiles(),before);
    const operationIds=protocol==='chat'?['1','2','3','4']:['1','2','4'];
    const response=await post('/api/office/review/apply',{reviewId:plan.id,operationIds});assert.equal(response.status,200,await response.clone().text());
    const result=await response.json();assert.equal(result.edit.changed_count,operationIds.length);
    const rows=(await app.office.call('inspect_document',{file_path:result.edit.output,include_tables:true,limit:100})).data.locations.filter(n=>n.section==='表格行'&&n.table===1).map(n=>n.cells);
    assert.ok(rows.some(row=>row[0]==='新增'&&row[1]==='300'));
    assert.ok(rows.some(row=>row[0]==='填写'&&row[2]==='完成'));
    assert.equal(rows.some(row=>row[0]==='删除'),protocol==='responses');
    assert.deepEqual(await readFile(await app.office.safePath(files.tables.id)),original);
    scenario='normal';
  });
  await t.test('表格受保护、行原文不完整、列数不匹配和行内冲突均不产生建议',async()=>{
    for(const mode of ['table_protected','table_partial','table_overlap','table_columns']){
      scenario=mode;const before=await app.office.listFiles();assert.equal(await propose(files.tables),undefined);assert.deepEqual(await app.office.listFiles(),before);
    }
    scenario='normal';
  });
  for(const protocol of ['chat','responses'])for(const ext of ['xlsx','pptx'])await t.test(`${protocol} ${ext} 修改建议到选择应用，原件及拒绝项保留`,async()=>{
    scenario=ext==='xlsx'?'spreadsheet':'slides';const file=files[ext],original=await readFile(await app.office.safePath(file.id)),before=await app.office.listFiles();
    const plan=await propose(file,protocol);assert.equal(plan.operations.length,2);assert.deepEqual(await app.office.listFiles(),before);
    const response=await post('/api/office/review/apply',{reviewId:plan.id,operationIds:['1']});assert.equal(response.status,200,await response.clone().text());
    const result=await response.json();assert.equal(result.edit.changed_count,1);assert.equal(result.check,null);
    const after=(await app.office.call('inspect_document',{file_path:result.edit.output,...(ext==='xlsx'?{sheet_name:'预算表',cell_range:'B2:C4'}:{})})).data.locations;
    if(ext==='xlsx'){
      assert.equal(after.find(item=>item.cell==='B2').text,'500');assert.equal(after.find(item=>item.cell==='B2').value_type,'number');
      assert.equal(after.find(item=>item.cell==='C2').text,'');assert.equal(after.find(item=>item.cell==='B4').text,'=SUM(B2:B3)');
    }else{assert.ok(after.some(item=>item.slide===1&&item.text==='预算200元'));assert.ok(after.some(item=>item.slide===2&&item.text==='预算100元'));}
    assert.deepEqual(await readFile(await app.office.safePath(file.id)),original);scenario='normal';
  });
  await t.test('Excel公式和无效数字、PPT链接和重叠修改不能生成可应用建议',async()=>{
    for(const mode of ['spreadsheet_protected','spreadsheet_number','slides_protected','slides_overlap']){
      scenario=mode;const before=await app.office.listFiles();assert.equal(await propose(mode.startsWith('slides')?files.pptx:files.xlsx),undefined);assert.deepEqual(await app.office.listFiles(),before);
    }
    scenario='normal';
  });
});
