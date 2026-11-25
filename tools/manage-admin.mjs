import {readFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {atomicJson} from '../lib/accounts.mjs';
import {acquireDataLock} from '../lib/data-lock.mjs';

export async function setAdminRole({dataDir,username,revoke=false,apply=false}) {
  const release=await acquireDataLock(dataDir);
  try {
    const file=join(dataDir,'accounts.json'),users=JSON.parse(await readFile(file,'utf8'));
    const name=String(username).trim().normalize('NFKC').toLowerCase(),target=users.find(user=>user.username===name);
    if(!target)throw new Error('请先注册目标账号，再停止服务执行此命令。');
    if(target.disabled===true)throw new Error('请先启用目标账号。');
    const role=revoke?'user':'admin';
    if(revoke&&target.role==='admin'&&users.filter(user=>user.role==='admin'&&user.disabled!==true).length<=1)throw new Error('不能撤销最后一个启用的管理员。');
    if(apply&&target.role!==role){
      const event={id:randomUUID(),at:new Date().toISOString(),actor:'服务器命令',target:target.username,action:revoke?'revoke_admin':'grant_admin'};
      await atomicJson(file,users.map(user=>user.id===target.id?{...user,role,adminHistory:[...(user.adminHistory||[]),event].slice(-20)}:user));
    }
    return {username:target.username,role,applied:apply};
  }finally{await release();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  const args=process.argv.slice(2),index=args.indexOf('--username');
  if(index<0||!args[index+1]||args[index+1].startsWith('--')){console.error('用法：node tools/manage-admin.mjs --username 用户名 [--revoke] [--apply]（先停止服务，默认只预览）');process.exitCode=1;}
  else setAdminRole({dataDir:join(dirname(fileURLToPath(import.meta.url)),'..','.data'),username:args[index+1],revoke:args.includes('--revoke'),apply:args.includes('--apply')}).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
