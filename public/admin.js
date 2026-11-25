import { language, t, uiHtml } from './i18n.js';
import {escapeHtml as e} from './editor.js';
const $=id=>document.getElementById(id);
export function initAdmin({api,toast,getUser}) {
  let page=1,busy=false,serial=0;
  const size=bytes=>bytes>=1e6?`${(bytes/1e6).toFixed(1)} MB`:`${Math.ceil(bytes/1000)} KB`;
  const date=value=>value?new Date(value).toLocaleString(language):'—';
  async function show(reset=false){
    if(getUser()?.role!=='admin')return;
    if(reset)page=1;
    const request=++serial;$('admin-status').textContent=t('正在读取账号与使用量…');
    try{
      const data=await api(`/api/admin/users?page=${page}&q=${encodeURIComponent($('admin-query').value.trim())}`);
      if(request!==serial)return;
      const o=data.overview;
      $('admin-overview').innerHTML=[[t('注册账号'),o.users],[t('已启用'),o.enabled],[t('启用的管理员'),o.admins],[t('在线会话'),o.sessions],[t('执行中任务'),o.activeJobs]].map(([label,value])=>`<div><strong>${e(value)}</strong><span>${e(label)}</span></div>`).join('');
      $('admin-status').textContent=t`注册${o.registration?t('开放'):t('关闭')} · 共 ${data.total} 个匹配账号 · 第 ${data.page} 页。统计仅包含文档数量、模型配置数量和文件库占用，不包含正文、密钥或调用费用。`;
      $('admin-users').innerHTML=data.users.map(user=>uiHtml`<article class="admin-user"><div><h3>${e(user.username)}</h3><p>${user.role==='admin'?t('管理员'):t('普通用户')} · ${user.disabled?t('已停用'):t('已启用')} · 注册于 ${e(date(user.createdAt))}</p><p>${user.sessions} 个会话 · ${user.activeJobs} 个任务 · ${user.usage.documents} 篇文档 · ${user.usage.providers} 个模型配置</p><p>文件库 ${user.usage.files} 个文件 / ${size(user.usage.bytes)}${user.usage.partial?t(' · 统计不完整'):''}</p></div><button class="secondary" data-admin-id="${e(user.id)}" data-disabled="${user.disabled?'true':'false'}" ${user.id===getUser().id?'disabled':''}>${user.id===getUser().id?t('当前账号'):user.disabled?t('启用账号'):t('停用账号')}</button></article>`).join('')||uiHtml('<p>没有匹配账号。</p>');
      $('admin-prev').disabled=page<=1;$('admin-next').disabled=page*data.pageSize>=data.total;
      const labels={enable:t('启用账号'),disable:t('停用账号'),grant_admin:t('设为管理员'),revoke_admin:t('撤销管理员')};
      $('admin-audit').innerHTML=data.audit.map(item=>`<li>${e(date(item.at))} · ${e(item.actor)} · ${e(labels[item.action]||item.action)} · ${e(item.target)}</li>`).join('')||uiHtml('<li>暂无管理操作记录。</li>');
    }catch(error){if(request===serial)$('admin-status').textContent=error.message;toast(error.message,true);}
  }
  $('admin-refresh').onclick=()=>show();$('admin-search').onclick=()=>show(true);
  $('admin-query').onkeydown=event=>{if(event.key==='Enter')show(true);};
  $('admin-prev').onclick=()=>{if(page>1){page--;show();}};$('admin-next').onclick=()=>{page++;show();};
  $('admin-users').onclick=async event=>{
    const button=event.target.closest('[data-admin-id]');if(!button||busy)return;
    busy=true;button.disabled=true;
    try{await api(`/api/admin/users/${encodeURIComponent(button.dataset.adminId)}/status`,{method:'PUT',body:{disabled:button.dataset.disabled!=='true'}});toast(t('账号状态已更新'));await show();}
    catch(error){toast(error.message,true);button.disabled=false;}finally{busy=false;}
  };
  return {show};
}
