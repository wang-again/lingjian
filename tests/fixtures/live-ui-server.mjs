// Disposable workspace and local mock model; no real documents, credentials or paid APIs.
import http from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../../server.mjs';
const model=http.createServer(async(req,res)=>{
  let text='';for await(const part of req)text+=part;
  const input=JSON.parse(text);
  if(input.tools){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'准备完成'},finish_reason:'stop'}]}));return;}
  const system=input.messages[0].content,request=input.messages.at(-1).content;
  const parts=system.includes('只修改')?['这一段','已由 AI','实时修改。']:system.includes('只输出审阅意见')?['## 一、审阅结果\n\n','原文结构清晰。\n\n','建议补充验收标准。']:['## 一、实时编写验收\n\n','第一段正在中间正文生成。\n\n','## 二、已保存的进度\n\n','第二段继续追加，原文可以整轮撤回。\n\n','| 项目 | 结果 |\n| --- | --- |\n| 实时修改 | 通过 |'];
  res.writeHead(200,{'Content-Type':'text/event-stream'});let n=0;
  const timer=setInterval(()=>{
    if(n===parts.length){res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');clearInterval(timer);}
    else if(request.includes('模拟失败')&&n===2){res.destroy();clearInterval(timer);}
    else res.write(`data: ${JSON.stringify({choices:[{delta:{content:parts[n++]}}]})}\n\n`);
  },request.includes('慢速')?2500:300);
  res.on('close',()=>clearInterval(timer));
});
await new Promise(resolve=>model.listen(3212,'127.0.0.1',resolve));
const app=await createApp({authMode:'local',port:3211,dataDir:await mkdtemp(join(tmpdir(),'lingjian-live-ui-'))});
app.store.state.providers=[{id:'live-qa-model',name:'实时修改验收（模拟）',model:'qa-live-model',protocol:'chat',baseUrl:'http://127.0.0.1:3212/v1',maxTokens:4096,timeout:60,tokenField:'max_tokens',temperature:null,stream:true}];
app.store.state.activeProviderId='live-qa-model';await app.store.persist();
console.log('Live editing QA: http://127.0.0.1:3211');
