import {createLiveEdit} from '/live-edit.js';
import {captureFragment} from '/fragments.js';
const results=document.querySelector('#results');
function assert(value,message){if(!value)throw Error(message);}
function caseOf(name,run){const row=document.createElement('li');try{run();row.textContent='PASS '+name;}catch(error){row.textContent='FAIL '+name+': '+error.message;}results.append(row);}
function setup(html){const editor=document.createElement('div');editor.innerHTML=html;document.querySelector('#sandbox').replaceChildren(editor);return editor;}
function capture(editor,range){return captureFragment(editor,{rangeCount:1,getRangeAt:()=>range},'doc');}
function rewrite(editor,range){return createLiveEdit(editor,{mode:'rewrite',selection:capture(editor,range),documentId:'doc'});}
caseOf('行内改写保留前后文本和周围格式',()=>{
 const e=setup('<p>前缀 <strong>旧内容</strong> 后缀</p><p>保留段</p>'),r=document.createRange();r.selectNodeContents(e.querySelector('strong'));
 const task=rewrite(e,r);task.update('新');task.update('新内容');task.finish();
 assert(e.innerHTML==='<p>前缀 <strong>新内容</strong> 后缀</p><p>保留段</p>','行内边界或格式变化');
});
caseOf('整段选区可以实时拆成两段，选区外节点不变',()=>{
 const e=setup('<p>首</p><p>选中</p><p>尾</p>'),last=e.lastChild,r=document.createRange();r.setStart(e,1);r.setEnd(e,2);
 const task=rewrite(e,r);task.update('甲');task.update('甲\n乙');task.finish();
 assert(e.innerHTML==='<p>首</p><p>甲</p><p>乙</p><p>尾</p>'&&e.lastChild===last,'整段边界不正确');
});
caseOf('跨两个段落的部分选区不覆盖外侧文字',()=>{
 const e=setup('<p>前A</p><p>B后</p><p>不改</p>'),last=e.lastChild,r=document.createRange();r.setStart(e.firstChild.firstChild,1);r.setEnd(e.children[1].firstChild,1);
 const task=rewrite(e,r);task.update('X');task.update('XY');task.finish();
 assert(e.textContent==='前XY后不改'&&e.lastChild===last,'跨段选区丢失外侧文字');
});
caseOf('续写保持原文和已完成段落节点，不整篇重绘',()=>{
 const e=setup('<p>原文</p>'),original=e.firstChild,task=createLiveEdit(e,{mode:'continue'});
 task.update('## 标题\n\n完整段落\n\n尾');const heading=e.querySelector('h2'),paragraph=heading.nextSibling;
 task.update('## 标题\n\n完整段落\n\n尾段继续');task.finish();
 assert(e.firstChild===original&&e.querySelector('h2')===heading&&heading.nextSibling===paragraph,'重绘了已完成节点');
 assert(!e.innerHTML.includes('ai-start')&&!e.querySelector('[data-ai-writing]'),'临时标记没有清除');
});
caseOf('富选区等待完整图片与表格，完成后保留图片引用',()=>{
 const src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6BfQAAAAASUVORK5CYII=';
 const e=setup('<p><img src="'+src+'" alt="示意"></p><table><tbody><tr><td>项目</td><td>值</td></tr><tr><td>旧值</td><td>100</td></tr></tbody></table>'),r=document.createRange();r.selectNodeContents(e);
 const fragment=capture(e,r),task=createLiveEdit(e,{mode:'rewrite',selection:fragment,documentId:'doc'}),before=e.innerHTML;
 assert(task.update('只有半截文字')===false&&e.innerHTML===before,'半截结果覆盖了图片表格');
 assert(task.update(fragment.text.replace('旧值','新值'),true),'完整结果没有显示');task.finish();
 assert(e.querySelector('img')?.getAttribute('src')===src&&e.querySelectorAll('table').length===1&&e.textContent.includes('新值'),'富选区内容没有保留');
});
caseOf('模型遗漏图片时拒绝完成，未接收内容时不改原文',()=>{
 const e=setup('<p>原文</p>'),task=createLiveEdit(e,{mode:'write'});assert(task.update('   ')===false&&e.innerHTML==='<p>原文</p>','空输出清空原文');task.finish();
 const src='data:image/png;base64,AAAA',rich=setup('<p><img src="'+src+'" alt="x"></p>'),r=document.createRange();r.selectNodeContents(rich);
 const t=rewrite(rich,r);let rejected=false;try{t.update('没有保留图片',true);}catch{rejected=true;}t.finish();
 assert(rejected&&rich.querySelector('img'),'未阻止图片丢失');
});
document.querySelector('#summary').textContent=results.querySelectorAll('li').length+' cases; '+[...results.children].filter(x=>x.textContent.startsWith('FAIL')).length+' failures';
