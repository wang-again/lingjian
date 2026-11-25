import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, resolve, basename} from 'node:path';
import {createTestApp} from './fixtures/http.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),'lingjian-ai-edit-test-'));
  const app = await createTestApp({dataDir:directory});
  t.after(async()=>{await app.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('lingjian-ai-edit-test-'));await rm(directory,{recursive:true,force:true});});
  const boot = await (await fetch(app.url+'/api/bootstrap')).json();
  return {original:boot.documents[0], call:async(body)=>{
    const response = await fetch(app.url+'/api/documents/'+boot.documents[0].id,{method:'PUT',headers:{'Content-Type':'application/json','X-Workspace-Token':boot.token},body:JSON.stringify(body)});
    return {status:response.status,...await response.json()};
  },boot:async()=>await(await fetch(app.url+'/api/bootstrap')).json()};
}
test('streaming checkpoints keep one original snapshot; stop, reload and undo restore exactly',async t=>{
  const f=await fixture(t),original=f.original;
  let doc=original;
  for(const [html,status] of [['<p>第一段</p>','streaming'],['<p>第一段</p><p>半截</p>','streaming'],['<p>第一段</p><p>半截</p>','interrupted']]){
    const result=await f.call({...doc,html,aiCheckpoint:{id:'run-one',status}});assert.equal(result.status,200);doc=result.document;
    assert.equal(doc.history.length,1);assert.equal(doc.history[0].html,original.html);
  }
  const reloaded=(await f.boot()).documents[0];assert.equal(reloaded.aiEdit.status,'interrupted');
  const undo=await f.call({revision:doc.revision,undoAiEdit:'run-one'});
  assert.equal(undo.status,200);assert.equal(undo.document.html,original.html);assert.equal(undo.document.title,original.title);assert.equal(undo.document.aiEdit,null);
  assert.equal(undo.document.history[0].html,doc.html);
  assert.equal((await f.call({revision:undo.document.revision,undoAiEdit:'run-one'})).status,409);
});
test('later manual edits require confirmation and retain a recovery version; stale revisions cannot undo',async t=>{
  const f=await fixture(t),first=await f.call({...f.original,html:'<p>AI 版本</p>',aiCheckpoint:{id:'run-two',status:'complete'}});
  const changed=await f.call({...first.document,html:'<p>我又手动写了一段</p>'});assert.equal(changed.status,200);
  assert.equal((await f.call({revision:first.document.revision,undoAiEdit:'run-two',allowLaterEdits:true})).status,409);
  assert.equal((await f.call({revision:changed.document.revision,undoAiEdit:'run-two'})).status,409);
  const undo=await f.call({revision:changed.document.revision,undoAiEdit:'run-two',allowLaterEdits:true});
  assert.equal(undo.status,200);assert.equal(undo.document.html,f.original.html);assert.equal(undo.document.history[0].html,changed.document.html);
});
test('another window changing the document stops checkpoint overwrites; closed tasks cannot resume',async t=>{
  const f=await fixture(t),first=await f.call({...f.original,html:'<p>AI 片段</p>',aiCheckpoint:{id:'run-three',status:'streaming'}});
  const external=await f.call({...first.document,html:'<p>另一窗口保存</p>'});assert.equal(external.status,200);
  assert.equal((await f.call({...first.document,html:'<p>不可覆盖</p>',aiCheckpoint:{id:'run-three',status:'complete'}})).status,409);
  assert.equal((await f.call({...external.document,html:'<p>不可重新续写</p>',aiCheckpoint:{id:'run-three',status:'complete'}})).status,409);
  assert.equal((await f.boot()).documents[0].html,external.document.html);
  const final=await f.call({...external.document,html:'<p>新一轮</p>',aiCheckpoint:{id:'run-four',status:'complete'}});assert.equal(final.status,200);
  assert.equal((await f.call({...final.document,html:'<p>不能续写已完成任务</p>',aiCheckpoint:{id:'run-four',status:'streaming'}})).status,409);
});
test('empty or unchanged output does not create an undo record; malformed metadata is rejected',async t=>{
  const f=await fixture(t),same=await f.call({...f.original,aiCheckpoint:{id:'same',status:'complete'}});
  assert.equal(same.status,200);assert.equal(same.document.aiEdit,null);assert.equal(same.document.history.length,0);
  assert.equal((await f.call({...same.document,html:'<p>bad</p>',aiCheckpoint:{id:42,status:'streaming'}})).status,400);
  assert.equal((await f.call({...same.document,html:'<p>bad</p>',aiCheckpoint:{id:'bad',status:'unknown'}})).status,400);
});
