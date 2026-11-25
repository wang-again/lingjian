import {readFile,readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {UserError} from './providers.mjs';
import {publicUser} from './accounts.mjs';

// 只缓存「文档数 / 模型数」，键里带源文件大小与 mtime，文件一变即失效。
const countCache = new Map();

// 优先读 store 维护的 meta.json：大小与 mtime 都吻合说明计数仍对应当前工作区，
// 无需解析整份文件。meta 缺失（旧版本首次升级）时退回解析，并按 mtime 缓存。
async function counts(directory, file, info) {
  try {
    const meta = JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8'));
    if (meta?.version === 1 && meta.sourceSize === info.size && Math.round(meta.sourceMtimeMs) === Math.round(info.mtimeMs)
      && Number.isInteger(meta.documents) && Number.isInteger(meta.providers)) {
      return { documents: meta.documents, providers: meta.providers, partial: false };
    }
  } catch {}
  const key = `${file}:${info.size}:${Math.round(info.mtimeMs)}`;
  const hit = countCache.get(key);
  if (hit) return { ...hit, partial: false };
  const workspace = JSON.parse(await readFile(file, 'utf8'));
  const value = { documents: workspace.documents?.length || 0, providers: workspace.providers?.length || 0 };
  if (countCache.size > 500) countCache.clear();
  countCache.set(key, value);
  return { ...value, partial: false };
}

export async function usage(directory) {
  let documents = 0, providers = 0, files = 0, bytes = 0, partial = false;
  try {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('linked');
    const file = join(directory, 'workspace.json');
    if ((await lstat(file)).isSymbolicLink()) throw new Error('linked');
    const result = await counts(directory, file, await lstat(file));
    documents = result.documents; providers = result.providers; partial = result.partial;
  } catch (error) { if (error.code !== 'ENOENT') partial = true; }
  const office=join(directory,'office'),root=join(office,'files'),pending=[];
  try{if((await lstat(directory)).isSymbolicLink()||(await lstat(office)).isSymbolicLink()||(await lstat(root)).isSymbolicLink())return {documents,providers,files,bytes,partial:true};pending.push(root);}catch(error){if(error.code!=='ENOENT')partial=true;}
  let visited=0;
  while(pending.length&&visited<10000){
    const path=pending.pop();
    try{for(const entry of await readdir(path,{withFileTypes:true})){
      if(++visited>10000){partial=true;break;}
      const target=join(path,entry.name),info=await lstat(target);
      if(info.isSymbolicLink()){partial=true;continue;}
      if(info.isDirectory()){if(entry.name!=='_scratch')pending.push(target);}
      else if(info.isFile()){files++;bytes+=info.size;}
    }}catch{partial=true;}
  }
  return {documents,providers,files,bytes,partial:partial||pending.length>0};
}

export async function handleAdmin({req,url,send,readJson,accounts,session,dataDir,activeByUser,activeCount}) {
  if(!url.pathname.startsWith('/api/admin/'))return false;
  if(!accounts)throw new UserError('管理端仅在账号模式开放。',403);
  accounts.requireAdmin(session);
  accounts.limit(`admin:${session.user.id}`,60,60000);
  if(req.method==='GET'&&url.pathname==='/api/admin/users'){
    const page=Number(url.searchParams.get('page')||1),query=(url.searchParams.get('q')||'').trim().normalize('NFKC').toLowerCase();
    if(!Number.isInteger(page)||page<1||page>1000||query.length>40)throw new UserError('分页或搜索条件无效。');
    accounts.sweep();
    const filtered=accounts.users.filter(user=>user.username.includes(query)),rows=filtered.slice((page-1)*25,page*25);
    const users=[];
    for(const user of rows)users.push({...publicUser(user),disabled:user.disabled===true,createdAt:user.createdAt,sessions:[...accounts.sessions.values()].filter(item=>item.user.id===user.id).length,activeJobs:activeByUser.get(user.id)||0,usage:await usage(join(dataDir,'users',user.id))});
    send(200,{users,page,pageSize:25,total:filtered.length,overview:{users:accounts.users.length,enabled:accounts.users.filter(user=>user.disabled!==true).length,admins:accounts.users.filter(user=>user.role==='admin'&&user.disabled!==true).length,sessions:accounts.sessions.size,activeJobs:activeCount(),registration:accounts.registration},audit:accounts.users.flatMap(user=>user.adminHistory||[]).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,30)});return true;
  }
  const match=/^\/api\/admin\/users\/([a-f0-9-]{36})\/status$/.exec(url.pathname);
  if(req.method==='PUT'&&match){const input=await readJson(req,2000);const user=await accounts.setDisabled(session,match[1],input.disabled);send(200,{user});return true;}
  throw new UserError('没有找到这个管理接口。',404);
}
