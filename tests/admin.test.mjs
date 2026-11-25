import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {createTestApp} from './fixtures/http.mjs';
import {setAdminRole} from '../tools/manage-admin.mjs';
const password='admin-test-password-2026';

test('管理端权限、管理员引导、账号启停与会话撤销、统计隐私、审计及重启持久化',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'lingjian-admin-'));
  let app=await createTestApp({dataDir:directory,authMode:'accounts'});
  t.after(async()=>{await app.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('lingjian-admin-'));await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  async function client(name,register=false,extra={}){
    const response=await fetch(`${app.url}/api/auth/${register?'register':'login'}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:name,password,...extra})});
    assert.equal(response.status,200,await response.clone().text());const cookie=response.headers.get('set-cookie').split(';')[0];
    const boot=await(await fetch(`${app.url}/api/bootstrap`,{headers:{Cookie:cookie}})).json();
    return {boot,call:(path,body,method='GET',csrf=true)=>fetch(`${app.url}${path}`,{method,headers:{Cookie:cookie,...(csrf?{'X-Workspace-Token':boot.token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})})};
  }
  const first=await client('owner',true,{role:'admin'});assert.equal(first.boot.user.role,'user');
  assert.equal((await first.call('/api/admin/users')).status,403);
  await assert.rejects(setAdminRole({dataDir:directory,username:'owner',apply:true}),/运行|锁|使用/);
  await app.close();
  assert.equal((await setAdminRole({dataDir:directory,username:'owner'})).applied,false);
  let stored=JSON.parse(await readFile(join(directory,'accounts.json'),'utf8'));assert.notEqual(stored[0].role,'admin');
  await setAdminRole({dataDir:directory,username:'owner',apply:true});
  app=await createTestApp({dataDir:directory,authMode:'accounts'});
  const admin=await client('owner');assert.equal(admin.boot.user.role,'admin');
  const user=await client('reader',true,{role:'admin'}),second=await client('reader');assert.equal(user.boot.user.role,'user');
  assert.equal((await fetch(`${app.url}/api/admin/users`)).status,401);
  assert.equal((await user.call('/api/admin/users')).status,403);
  const path=`/api/admin/users/${user.boot.user.id}/status`;
  assert.equal((await user.call(path,{disabled:true},'PUT')).status,403);
  assert.equal((await admin.call(path,{disabled:true},'PUT',false)).status,403);
  assert.equal((await admin.call(`/api/admin/users/${admin.boot.user.id}/status`,{disabled:true},'PUT')).status,409);
  await user.call('/api/documents',{title:'私密标题不可泄露',html:'<p>正文不可泄露</p>',sources:[]},'POST');
  await user.call('/api/office/upload',{name:'私密文件名.txt',base64:Buffer.from('文件正文不可泄露').toString('base64')},'POST');
  let response=await admin.call('/api/admin/users'),data=await response.json();
  assert.equal(data.overview.users,2);assert.equal(data.overview.admins,1);
  const row=data.users.find(item=>item.id===user.boot.user.id);assert.equal(row.sessions,2);assert.equal(row.usage.files,1);assert.ok(row.usage.documents>=1);
  const output=JSON.stringify(data);for(const secret of ['salt','hash','私密标题','正文不可泄露','私密文件名','password',password])assert.ok(!output.includes(secret),secret);
  const targetSessions=[...app.accounts.sessions.values()].filter(item=>item.user.id===user.boot.user.id);targetSessions[0].keys.set('fake','must-clear');
  assert.equal((await admin.call(path,{disabled:true},'PUT')).status,200);
  assert.ok(targetSessions.every(session=>session.abort.signal.aborted&&session.keys.size===0));
  assert.equal((await user.call('/api/bootstrap')).status,401);assert.equal((await second.call('/api/bootstrap')).status,401);
  const login=await fetch(`${app.url}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'reader',password})});assert.equal(login.status,403);
  data=await(await admin.call('/api/admin/users?q=reader')).json();assert.equal(data.total,1);assert.equal(data.users[0].disabled,true);assert.equal(data.audit[0].action,'disable');
  await app.close();app=await createTestApp({dataDir:directory,authMode:'accounts'});
  const reopened=await client('owner');data=await(await reopened.call('/api/admin/users')).json();assert.equal(data.users.find(item=>item.username==='reader').disabled,true);
  assert.equal((await reopened.call(path,{disabled:false},'PUT')).status,200);await client('reader');
  const owner=app.accounts.users.find(item=>item.username==='owner');owner.role='user';assert.equal((await reopened.call('/api/admin/users')).status,403);owner.role='admin';
  await app.close();await assert.rejects(setAdminRole({dataDir:directory,username:'owner',revoke:true,apply:true}),/最后/);
});

test('单机模式不开放管理端API',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'lingjian-admin-local-')),app=await createTestApp({dataDir:directory});
  t.after(async()=>{await app.close();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('lingjian-admin-local-'));await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  assert.equal((await fetch(`${app.url}/api/admin/users`)).status,403);
});
