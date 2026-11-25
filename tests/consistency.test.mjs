import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { integrationMissing } from './fixtures/office-runtime.mjs';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,basename} from 'node:path';
import {readConsistencySource} from '../lib/consistency.mjs';
import {validateProvider} from '../lib/providers.mjs';
import {createTestApp,listenHttp} from './fixtures/http.mjs';
const python=process.env.OFFICE_PYTHON||resolve('.venv-office',process.platform==='win32'?'Scripts/python.exe':'bin/python');

test('一致性读取分页、上下文上限及停止，不能把局部覆盖当全文',async()=>{
  const seen=[];const office={async call(name,args){seen.push(args);const count=2300;return {data:{source_sha256:'fixture',total_locations:count,locations:Array.from({length:Math.min(100,count-args.offset)},(_,i)=>({location:`p${args.offset+i}`,section:'正文',position:`第${args.offset+i}段`,text:'用于检查的普通文字'})),more:args.offset+100<count}};}};
  const source=await readConsistencySource(office,{id:'fixture.docx'});
  assert.equal(source.coverage.complete,false);assert.ok(source.locations.size<2300);assert.ok(seen.length>1);assert.equal(seen[1].offset,100);assert.ok(source.coverage.notes.some(note=>note.includes('最多')));
  const controller=new AbortController();controller.abort();const count=seen.length;
  await assert.rejects(readConsistencySource(office,{id:'fixture.docx'},{signal:controller.signal}),/停止/);assert.equal(seen.length,count);
});

test('一致性检查真实四格式、双协议、证据核验、选择应用、待确认与覆盖提示',{skip: integrationMissing,timeout:90000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'lingjian-consistency-')),app=await createTestApp({dataDir:directory});
  t.after(async()=>{await app.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('lingjian-consistency-'));await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  await promisify(execFile)(python,['-B',resolve('tests/fixtures/consistency_samples.py'),join(directory,'fixtures')],{windowsHide:true});
  let mode='normal',calls=0;
  const mock=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw),responses=req.url.endsWith('/responses'),history=responses?input.input:input.messages;
    assert.deepEqual(input.tools.map(tool=>tool.name||tool.function?.name),['submit_consistency_review']);
    const context=JSON.parse(history.find(item=>item.role==='user').content);calls++;
    const doc=context.document,canonical=doc.find(item=>item.text==='口径说明：项目总预算以100万元为准。'),target=doc.find(item=>item.text==='项目总预算为200万元。');
    const ext=context.selectedFiles[0].id.split('.').at(-1);
    const quote=item=>({location:item.location,quote:item.text});
    let findings=[];
    if(mode!=='empty'&&mode!=='stale_empty'&&canonical&&target){
      const operation={type:ext==='xlsx'?'set_spreadsheet_cell':ext==='pptx'?'replace_slide_text':'replace_text',location:target.location,find:ext==='xlsx'?target.text:'200',replace:ext==='xlsx'?'项目总预算为100万元。':'100',reason:'根据文内明确规定的预算口径统一',...(ext==='xlsx'?{value_type:'string'}:{})};
      findings=[{category:'amount',title:'项目总预算金额冲突',explanation:'两处都指向项目总预算，金额分别为100万元和200万元。',suggestion:'按文内明确口径统一为100万元。',evidence:[quote(canonical),quote(target)],basis:{kind:'document_evidence',location:canonical.location,quote:'项目总预算以100万元为准'},operations:[operation]}];
      const dateA=doc.find(item=>item.text==='项目计划在2026年12月31日验收。'),dateB=doc.find(item=>item.text==='项目计划在2027年1月31日验收。');
      findings.push({category:'date',title:'验收日期需确认',explanation:'同一项目出现两个验收日期，缺少明确基准。',suggestion:'请确认计划验收日期。',evidence:[quote(dateA),quote(dateB)],operations:[]});
      if(mode==='ambiguous')findings=findings.map(item=>({...item,basis:undefined,operations:[]}));
      if(mode==='fake_quote')findings[0].evidence[0].quote='未出现在原文的金额';
      if(mode==='fake_location')findings[0].evidence[0].location='unselected.docx#p0';
      if(mode==='duplicate')findings[0].evidence=[quote(canonical),quote(canonical)];
      if(mode==='no_basis')delete findings[0].basis;
      if(mode==='fake_basis')findings[0].basis={kind:'user_requirement',quote:'用户从未给出的统一金额'};
      if(mode==='wrong_target')findings[0].operations[0].location=dateA.location;
    }
    if(mode==='stale_empty'&&!history.some(item=>item.role==='tool'||item.type==='function_call_output')){
      const path=await app.office.safePath(context.selectedFiles[0].id);await writeFile(path,Buffer.concat([await readFile(path),Buffer.from('\n')]));
    }
    const args={source_sha256:context.source_sha256,summary:'模型检查报告',findings};
    const call={name:'submit_consistency_review',arguments:JSON.stringify(args)};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(responses?{status:'completed',output:[{type:'function_call',call_id:`c${calls}`,...call}]}:{choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{id:`c${calls}`,type:'function',function:call}]}}]}));
  });
  await listenHttp(mock);t.after(()=>new Promise(resolve=>{mock.closeAllConnections();mock.close(resolve);}));
  const token=(await(await fetch(`${app.url}/api/bootstrap`)).json()).token;
  const post=(path,body,authorized=true)=>fetch(`${app.url}${path}`,{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{'X-Workspace-Token':token}:{})},body:JSON.stringify(body)});
  const files={};for(const ext of ['docx','pdf','xlsx','pptx'])files[ext]=await app.office.upload(`一致性.${ext}`,(await readFile(join(directory,`fixtures/consistency.${ext}`))).toString('base64'));
  const scan=await app.office.upload('扫描.pdf',(await readFile(join(directory,'fixtures/scan.pdf'))).toString('base64'));
  const truncated=await app.office.upload('长段落.docx',(await readFile(join(directory,'fixtures/truncated.docx'))).toString('base64'));
  async function check(file,protocol='chat'){
    const provider=validateProvider({id:'consistency-provider',name:'fixture',model:'fixture',protocol,baseUrl:`http://127.0.0.1:${mock.address().port}/v1`});app.store.state.providers=[provider];
    const response=await post('/api/office/agent',{providerId:provider.id,files:[file.id],consistency:true,prompt:'检查全文金额、日期、名称和术语的前后一致性'});assert.equal(response.status,200);
    const events=(await response.text()).split('\n\n').filter(block=>block.startsWith('event:')).map(block=>({kind:/^event: (.+)$/m.exec(block)[1],data:JSON.parse(/^data: (.+)$/m.exec(block)[1])}));
    return {events,plan:events.find(item=>item.kind==='review')?.data,error:events.find(item=>item.kind==='error')?.data};
  }
  for(const protocol of ['chat','responses'])for(const ext of ['docx','pdf','xlsx','pptx'])await t.test(`${protocol} ${ext} 报告引用真实证据，日期待确认，只应用预算建议`,async()=>{
    mode='normal';const file=files[ext],original=await readFile(await app.office.safePath(file.id)),before=await app.office.listFiles();
    const {plan,error}=await check(file,protocol);assert.equal(error,undefined);assert.equal(plan.kind,'consistency');assert.equal(plan.findings.length,2);assert.equal(plan.operations.length,1);
    assert.equal(plan.findings[1].status,'needs_confirmation');assert.equal(plan.findings[1].operation_ids.length,0);assert.deepEqual(plan.findings[0].operation_ids,['1']);
    assert.equal(plan.coverage.complete,ext!=='pdf');if(ext==='docx')assert.ok(plan.coverage.read_locations>100);if(ext==='pdf')assert.equal(plan.coverage.pages_without_text,1);
    assert.deepEqual(await app.office.listFiles(),before);
    const response=await post('/api/office/review/apply',{reviewId:plan.id,operationIds:['1']});assert.equal(response.status,200,await response.clone().text());const applied=await response.json();
    if(ext==='pdf'){
      const old=(await app.office.call('inspect_document',{file_path:file.id,query:'项目总预算为200万元'})).data.locations[0];
      const after=(await app.office.call('inspect_document',{file_path:applied.edit.output,limit:100})).data.locations;
      const line=after.filter(item=>item.page===old.page&&Math.abs(item.bbox[1]-old.bbox[1])<2).sort((a,b)=>a.bbox[0]-b.bbox[0]).map(item=>item.text).join('');
      assert.equal(line,'项目总预算为100万元。');
    }else{const after=(await app.office.call('inspect_document',{file_path:applied.edit.output,query:'项目总预算为100万元'})).data;assert.ok(after.locations.length);}
    const dates=(await app.office.call('inspect_document',{file_path:applied.edit.output,query:'2027年1月31日'})).data;assert.ok(dates.locations.length);
    assert.deepEqual(await readFile(await app.office.safePath(file.id)),original);
  });
  await t.test('不明确依据只报告待确认，未发现问题也有覆盖范围',async()=>{
    for(const scenario of ['ambiguous','empty']){mode=scenario;const before=await app.office.listFiles(),{plan,error}=await check(files.docx);assert.equal(error,undefined);assert.equal(plan.operations.length,0);assert.equal(plan.coverage.complete,true);assert.deepEqual(await app.office.listFiles(),before);assert.equal((await post('/api/office/review/apply',{reviewId:plan.id,operationIds:[]})).status,400);}
  });
  await t.test('伪造证据、重复证据、无依据修改或错误目标均拦截',async()=>{
    for(const scenario of ['fake_quote','fake_location','duplicate','no_basis','fake_basis','wrong_target']){mode=scenario;const before=await app.office.listFiles(),{plan,error}=await check(files.docx);assert.equal(plan,undefined);assert.ok(error);assert.deepEqual(await app.office.listFiles(),before);}
  });
  await t.test('扫描件不调用模型，长段落不冒充全文，检查中原文变化拒绝报告',async()=>{
    mode='empty';const before=calls;const scanned=await check(scan);assert.equal(calls,before);assert.equal(scanned.plan.coverage.complete,false);assert.equal(scanned.plan.operations.length,0);
    const long=await check(truncated);assert.equal(long.plan.coverage.complete,false);assert.equal(long.plan.coverage.truncated_locations,1);
    const path=await app.office.safePath(files.docx.id),original=await readFile(path);mode='stale_empty';const stale=await check(files.docx);assert.equal(stale.plan,undefined);assert.match(stale.error.message,/原文已变化/);await writeFile(path,original);
  });
  assert.equal((await post('/api/office/agent',{providerId:'consistency-provider',files:[files.docx.id],consistency:true},false)).status,403);
});
