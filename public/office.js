import { language, t, uiHtml } from './i18n.js';
import {escapeHtml as e,markdownToHtml} from './editor.js';
import { createActivityTimeline, officeToolLabel, responseEvents } from './task-activity.js';
const $ = id=>document.getElementById(id);
const icon = name=>`<svg aria-hidden="true"><use href="/icon.svg#${name}"/></svg>`;
const group = name=>/docx/.test(name)?'word':/xlsx/.test(name)?'excel':/pptx/.test(name)?'ppt':name.startsWith('pdf_')?'pdf':'files';

export function initOffice({api,toast,showModal,createDocument,addSource,getContext,getOwner,beforeAgent,openSettings}) {
  let files=[],tools=[],selected=new Set(),agentController=null,busy=false,review=null,uncertainTask=false;
  const activityTimeline = createActivityTimeline($('office-activity'));
  const size = bytes=>bytes>=1000000?`${(bytes/1000000).toFixed(1)} MB`:`${Math.max(1,Math.round(bytes/1000))} KB`;
  const fileURL = (id,inline=false)=>`/api/office/file?id=${encodeURIComponent(id)}${inline?'&inline=1':''}`;
  const fileDate = new Intl.DateTimeFormat(language, {year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
  function checkHtml(report) {
    return `<div class="delivery-check ${report.status === 'passed' ? 'passed' : 'needs-review'}"><strong>${e(report.file)} · ${e(report.summary)}</strong><p>${e(t`${report.stats.paragraphs} 个段落 · ${report.stats.tables} 个表格 · ${report.findings.length} 个发现`)}</p>${report.findings.length ? `<ul>${report.findings.slice(0, 12).map(item => `<li>${e(item.location)}：${e(item.message)}</li>`).join('')}</ul>` : ''}<p>${report.limitations.map(e).join(' ')}</p></div>`;
  }
  async function uploadFile(file) {
    if (file.size > 20_000_000) throw new Error(t`「${file.name}」超过 20 MB。`);
    const bytes=new Uint8Array(await file.arrayBuffer()); let binary='';
    for(let i=0;i<bytes.length;i+=32768) binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
    const result=await api('/api/office/upload',{method:'POST',body:{name:file.name,base64:btoa(binary)}});
    files=result.files; selected.add(result.file.id); renderFiles(); return result.file;
  }
  async function uploadAndExtract(file) { const uploaded=await uploadFile(file); return {...await api('/api/office/extract',{method:'POST',body:{id:uploaded.id}}),name:file.name}; }
  function renderFiles() {
    selected=new Set([...selected].filter(id=>files.some(file=>file.id===id)));
    const visibleFiles=files.filter(file=>!/[.]check_[a-f0-9]{8}[.]json$/i.test(file.id));
    $('office-file-count').textContent=visibleFiles.length;
    $('office-selected').textContent=selected.size?t`已选择 ${selected.size} 个文件`:t('未选择文件 · 也可直接创建新文件');
    const query = $('file-name-filter').value.trim().toLowerCase();
    const matches = visibleFiles.filter(file => file.name.toLowerCase().includes(query));
    const rows = matches.map(file => {
      const type = file.extension.slice(1).toUpperCase();
      const image = /\.(png|jpe?g|webp)$/i.test(file.id);
      const id = e(file.id), name = e(file.name);
      const timestamp = Date.parse(file.modifiedAt);
      const modified = Number.isFinite(timestamp) ? fileDate.format(timestamp) : '—';
      return uiHtml`<div class="file-entry">
        <input type="checkbox" data-office-select="${id}" aria-label="选择 ${name}" ${selected.has(file.id) ? 'checked' : ''}>
        <details><summary class="file-columns"><strong>${name}</strong><span>${e(type)}</span><time>${e(modified)}</time>${icon('chevron')}</summary>
          <div class="office-file-actions"><small>${size(file.size)}</small>
            ${image ? uiHtml`<a href="${fileURL(file.id,true)}" target="_blank" rel="noopener">预览</a>` : ''}
            ${type === 'JSON' ? '' : uiHtml`<button data-office-import="${id}">${image ? t('识别文字') : t('读入编辑器')}</button><button data-office-source="${id}">作为资料</button>`}
            ${type === 'DOCX' ? uiHtml`<button data-office-check="${id}">交付检查</button>` : ''}
            <a href="${fileURL(file.id)}" download aria-label="下载 ${name}">${icon('download')}下载</a>
          </div>
        </details></div>`;
    });
    $('office-file-list').innerHTML = rows.length
      ? uiHtml('<div class="file-columns file-head"><span>名称</span><span>格式</span><span>修改时间</span></div>') + rows.join('')
      : `<p class="office-empty">${visibleFiles.length ? t('没有匹配的文件。') : t('文件库为空。')}</p>`;
  }
  function renderTools() {
    const category=$('office-tool-category').value;
    $('office-tool-count').textContent=tools.length;
    $('office-tool-grid').innerHTML=tools.filter(tool=>category==='all'||group(tool.name)===category).map(tool=>`<button class="office-tool-card" data-office-tool="${e(tool.name)}"><span>${icon(group(tool.name)==='files'?'folder':'doc')}</span><div><strong>${e(officeToolLabel(tool.name))}</strong><small>${e(tool.name)}</small><p>${e((tool.description||'').split('\n')[0].slice(0,110))}</p></div>${icon('chevron')}</button>`).join('');
  }
  async function show() {
    activityTimeline.show(getOwner());
    try {
      $('office-engine-status').textContent=t('正在准备文件处理…');
      const [status,library]=await Promise.all([api('/api/office/status'),api('/api/office/files')]);
      tools=status.tools;files=library.files;renderFiles();renderTools();
      $('office-engine-status').classList.toggle('unavailable',!status.available);
      $('office-engine-status').textContent=status.available?(status.version==='upstream-local'?t('基础 Office 工具已就绪'):t('文件处理已就绪')):t`未连接：${t(status.error)}`;
    } catch(error){toast(error.message,true);$('office-engine-status').textContent=error.message;}
  }
  function parameters(tool) {
    const chosen=files.find(file=>selected.has(file.id)), id=chosen?.id||'请填写文件 ID';
    const result={};
    for(const [key,property] of Object.entries(tool.inputSchema?.properties||{})){
      if(property.default!==undefined)result[key]=property.default;
      else if((tool.inputSchema.required||[]).includes(key))result[key]=property.type==='boolean'?false:property.type==='number'||property.type==='integer'?1:property.type==='array'?[]:'';
      if(['file_path','filepath','image_path','source'].includes(key))result[key]=id;
      if(key==='path')result[key]=tool.name==='list_directory'?'.':id;
      if(key==='output')result[key]=`新文档_${Date.now()}.${tool.name.includes('docx')?'docx':tool.name.includes('xlsx')?'xlsx':'pptx'}`;
    }
    if(tool.name==='write_docx')result.content_json=JSON.stringify([{type:'heading',text:'一、文档概述'},{type:'paragraph',text:'请在这里填写正文内容。'}]);
    if(tool.name==='search_sources')Object.assign(result,{files:[...selected],query:'',limit:12});
    if(tool.name==='edit_docx')result.spec_json=JSON.stringify({operations:[{op:'replace_all',find:'待补充',replace:'请填写新内容'}]});
    if(tool.name==='write_pptx_design')result.spec_json=JSON.stringify({slides:[{id:'s1',bg:{cover:true},items:[{t:'title',x:112,y:200,w:1300,h:120,s:'演示标题',size:40,color:'5EA0FF'}]}]});
    if(tool.name==='file_info'&&!chosen)result.path='.';
    if('bbox'in result)result.bbox=[50,50,250,100];
    if('new_text'in result)result.new_text='新文字';
    if(tool.name==='pdf_add_text')Object.assign(result,{text:'新文字',x:50,y:50});
    if(tool.name==='read_image'&&!chosen)result.image_path='请先选择图片';
    return result;
  }
  function showTool(toolName){
    const tool=tools.find(item=>item.name===toolName);if(!tool)return;
    showModal('OFFICE TOOL / '+toolName,uiHtml`<h2>${e(officeToolLabel(toolName))}</h2><p class="modal-description">${e((tool.description||'').split('\n')[0])}</p><label class="office-parameters-label">工具参数（JSON）<textarea id="office-tool-arguments" rows="10" spellcheck="false">${e(JSON.stringify(parameters(tool),null,2))}</textarea></label><details class="office-schema"><summary>查看完整参数说明</summary><pre>${e(tool.description)}\n\n${e(JSON.stringify(tool.inputSchema,null,2))}</pre></details><p class="office-parameter-note">路径相对于文件库，文件 ID 可在下方列表选择后自动带入。PDF 修改后需运行「保存 PDF 修改」。</p><div id="office-call-error" class="inline-error" role="alert" hidden></div><button id="office-call-run" class="primary full-width">运行工具${icon('arrow')}</button>`);
    $('office-call-run').onclick=async()=>{
      const button=$('office-call-run');button.disabled=true;$('office-call-error').hidden=true;
      try{
        let args;try{args=JSON.parse($('office-tool-arguments').value);}catch{throw new Error(t('参数不是有效 JSON，请检查引号和逗号。'));}
        const result=await api('/api/office/call',{method:'POST',body:{name:toolName,arguments:args}});
        files=result.files;renderFiles();renderResult(toolName,result);$('modal').close();toast(t('工具执行完成'));
      }catch(error){$('office-call-error').textContent=error.message;$('office-call-error').hidden=false;}
      finally{button.disabled=false;}
    };
  }
  function renderResult(name,result){
    $('office-tool-result').hidden=false;
    const previews=result.data?.previews || (Array.isArray(result.data)?result.data.filter(item=>item.image_path).map(item=>item.image_path):[]);
    $('office-tool-result').innerHTML=uiHtml`<div class="office-result-title"><strong>${e(name==='check_docx'?t('文件检查'):officeToolLabel(name))} · 执行结果</strong><button class="text-button" id="office-result-close">收起</button></div>${name === 'check_docx' ? checkHtml(result.data) : ''}${(result.images||[]).slice(0,8).map(image=>uiHtml`<img class="office-preview-image" src="data:${e(image.mimeType)};base64,${e(image.data)}" alt="工具返回的图片预览">`).join('')}${previews.slice(0,8).map(path=>uiHtml`<img class="office-preview-image" src="${fileURL(path,true)}" alt="文件页面预览">`).join('')}${name==='check_docx'?'':`<pre>${e(typeof result.data==='string'?result.data:JSON.stringify(result.data,null,2))}</pre>`}`;
    $('office-result-close').onclick=()=>{$('office-tool-result').hidden=true;};
    if(name==='search_sources'){
      const data=result.data;
      $('office-tool-result').innerHTML=uiHtml`<div class="office-result-title"><strong>资料检索 · ${data.results.length} 个匹配片段</strong><button class="text-button" id="office-result-close">收起</button></div><p>${e(data.note)}</p>${data.more_matches?uiHtml('<p>仍有更多匹配，可缩小关键词范围或提高返回数量。</p>'):''}${data.results.map(hit=>`<blockquote class="source-search-hit"><strong>${e(hit.name)} · ${e(hit.location)}</strong><p>${e(hit.excerpt)}</p><small>${e(hit.citation)}</small></blockquote>`).join('')||uiHtml('<p>未找到匹配文字，可更换关键词。</p>')}${data.warnings.map(warning=>`<p>${e(warning.file)}：${e(warning.message)}</p>`).join('')}`;
      $('office-result-close').onclick=()=>{$('office-tool-result').hidden=true;};
    }
  }
  async function useFile(id,asSource){
    toast(t('正在提取文件内容…'));
    try{
      const data=await api('/api/office/extract',{method:'POST',body:{id}});
      if(asSource){await addSource({name:files.find(file=>file.id===id)?.name||id,text:data.text});toast(t('已添加到当前文档参考资料'));}
      else{await createDocument(data.title,null,data.html);toast(data.warnings.length?data.warnings.join(' '):t('文件内容已读入新文档'));}
    }catch(error){toast(error.message,true);}
  }
  const reviewLabels = {replace_text:[t('替换文字'),t('原文'),t('修改为')],insert_before:[t('在段前插入'),t('参考段落（保留）'),t('插入新段落')],insert_after:[t('在段后插入'),t('参考段落（保留）'),t('插入新段落')],delete_paragraph:[t('删除段落'),t('待删除的完整段落'),t('删除后')],split_paragraph:[t('拆分段落'),t('完整原段落'),t('拆分为两段')]};
  Object.assign(reviewLabels,{set_cell_text:['改写单元格','原单元格','改写为'],insert_row_before:['在行前插入','参考行（保留）','插入新行'],insert_row_after:['在行后插入','参考行（保留）','插入新行'],delete_row:['删除行','待删除的完整行','删除后']});
  const reviewContent=(value,cells,empty)=>Array.isArray(cells)?`<table>${cells.map((cell,i)=>uiHtml`<tr><th scope="row">第 ${i+1} 列</th><td>${e(cell)||t('（空白）')}</td></tr>`).join('')}</table>`:`<p>${e(value)||empty}</p>`;
  Object.assign(reviewLabels,{set_spreadsheet_cell:['修改Excel单元格','原单元格底层值','新值'],replace_slide_text:['替换幻灯片文字','原文','修改为']});
  function consistencyHtml(plan) {
    if(plan.kind!=='consistency')return '';
    const coverage=plan.coverage,category={amount:'金额与单位',date:'日期',name:'名称',term:'术语',numbering:'编号',other:'其他'};
    return uiHtml`<div class="consistency-coverage"><strong>${coverage.complete?t('已覆盖全部可提取文字位置'):t('本次覆盖不完整')}</strong><p>已检查 ${e(coverage.read_locations)} / ${e(coverage.total_locations)} 个可提取位置</p>${coverage.notes.map(note=>`<p>${e(note)}</p>`).join('')}</div>${plan.findings.map(finding=>uiHtml`<article class="consistency-finding"><h4>${e(category[finding.category])} · ${e(finding.title)}</h4><strong>${finding.status==='suggested'?t('有修改建议'):t('待确认')}</strong><p>${e(finding.explanation)}</p>${finding.evidence.map(item=>`<blockquote><strong>${e(item.position)}</strong><p>${e(item.quote)}</p></blockquote>`).join('')}<p><strong>建议：</strong>${e(finding.suggestion)}</p>${finding.basis?uiHtml`<p><strong>统一依据 · ${e(finding.basis.position)}：</strong>${e(finding.basis.quote)}</p>`:''}${finding.operation_ids.length?uiHtml`<p>对应下方第 ${finding.operation_ids.map(e).join('、')} 项修改，请逐条审阅。</p>`:uiHtml('<p>此项仅供核对，不包含可直接应用的修改。</p>')}</article>`).join('')}`;
  }
  function renderReview(plan) {
    review=plan;
    const panel=$('office-review');panel.hidden=false;
    panel.innerHTML=uiHtml`<h3>${plan.kind==='consistency'?t('一致性检查'):t('待审阅修改')} · ${e(plan.file.name)}</h3><p>${e(plan.summary)}</p>${consistencyHtml(plan)}<p class="office-agent-note">建议有效期30分钟，服务重启后需重新生成。仅应用勾选项，结果另存为副本。</p><div class="office-review-actions"><button type="button" data-review-all>全选</button><button type="button" data-review-none>全部拒绝</button></div>${plan.operations.map((op,index)=>uiHtml`<article class="office-review-item"><label><input type="checkbox" data-review-operation="${e(op.id)}" checked>接受第 ${index+1} 项 · ${e((reviewLabels[op.type]||reviewLabels.replace_text)[0])}</label><small>${e(op.position)}${op.value_type?t` · 新值类型：${e({string:t('文本'),number:t('数字'),boolean:t('布尔'),blank:t('清空')}[op.value_type])}`:''}</small><div class="office-review-before"><strong>${e((reviewLabels[op.type]||reviewLabels.replace_text)[1])}</strong>${reviewContent(op.find,op.before_cells,t('（空白单元格）'))}</div><div class="office-review-after"><strong>${e((reviewLabels[op.type]||reviewLabels.replace_text)[2])}</strong>${reviewContent(op.replace,op.after_cells,op.type==='delete_row'?t('（整行移除）'):op.type==='delete_paragraph'?t('（整段移除）'):t('（清空文字）'))}</div><p><strong>理由：</strong>${e(op.reason)}</p><details><summary>查看原文上下文</summary><p>${e(op.context)}</p></details></article>`).join('')}<p>${plan.limitations.map(e).join(' ')}</p><p id="office-review-status" role="status" aria-live="polite"></p><button class="primary full-width" id="office-review-apply">应用选中修改并另存</button>`;
    $('office-review-apply').hidden=!plan.operations.length;
    const selection=()=>[...panel.querySelectorAll('[data-review-operation]:checked')].map(input=>input.dataset.reviewOperation);
    const update=()=>{const count=selection().length;$('office-review-status').textContent=plan.operations.length?t`已接受 ${count} / ${plan.operations.length} 项修改`:t('没有可直接应用的修改；请查看检查结果与待确认事项。');$('office-review-apply').disabled=!count||busy;};
    panel.onchange=update;
    panel.querySelector('[data-review-all]').onclick=()=>{panel.querySelectorAll('[data-review-operation]').forEach(input=>input.checked=true);update();};
    panel.querySelector('[data-review-none]').onclick=()=>{panel.querySelectorAll('[data-review-operation]').forEach(input=>input.checked=false);update();};
    $('office-review-apply').onclick=async()=>{
      if(busy||review!==plan)return;
      const operationIds=selection();if(!operationIds.length)return;
      busy=true;panel.querySelectorAll('button,input').forEach(input=>input.disabled=true);
      $('office-agent-run').disabled=true;$('office-review-run').disabled=true;$('office-consistency-run').disabled=true;
      $('office-review-status').textContent=t('正在核对原文并保存修订副本…');
      try{
        const result=await api('/api/office/review/apply',{method:'POST',body:{reviewId:plan.id,operationIds}});
        files=result.files;renderFiles();review=null;
        if(result.check)$('office-delivery-checks').innerHTML=checkHtml(result.check);
        $('office-review-status').innerHTML=uiHtml`已另存修订副本，实际修改 ${e(result.edit.changed_count)} 处。<a href="${fileURL(result.edit.output)}" download>下载修订版</a><p>${result.edit.limitations.map(e).join(' ')}${e(result.checkError||'')}${result.check&&result.check.status!=='passed'?t(' 结构检查有待确认项，请查看检查结果。'):''}</p>`;
        $('office-review-apply').textContent=t('已应用选中修改');
        toast(t('修订副本已保存'));
      }catch(error){
        $('office-review-status').textContent=error.message;
        if(error.status===409){review=null;$('office-review-apply').textContent=t('请重新生成建议');}
        else panel.querySelectorAll('button,input').forEach(input=>input.disabled=false);
        toast(error.message,true);
      }finally{busy=false;$('office-agent-run').disabled=false;$('office-review-run').disabled=false;$('office-consistency-run').disabled=false;}
    };
    update();
  }
  async function runAgent(reviewMode=false,consistencyMode=false){
    if(busy)return;const context=getContext();
    if(!context.providerId){toast(t('先配置一个支持工具调用的模型。'));openSettings();return;}
    const prompt=$('office-agent-prompt').value.trim();if(!prompt&&!consistencyMode){$('office-agent-prompt').focus();toast(t('请输入文件处理要求。'));return;}
    if(reviewMode&&(selected.size!==1||!(/\.(docx|pdf|xlsx|pptx)$/i.test([...selected][0])))){toast(t('请只选择一份 DOCX、文字型 PDF、XLSX 或 PPTX 生成修改建议。'));return;}
    if (!reviewMode && uncertainTask) {
      uncertainTask = !(await api('/api/office/files').then(library => {
        files = library.files;
        renderFiles();
        toast(t('已刷新文件库。请核对已有文件，确认还需要处理时再运行。'));
        return true;
      }).catch(error => {
        toast(t`无法核对已有文件：${error.message}`, true);
        return false;
      }));
      return;
    }
    review=null;$('office-review').hidden=true;$('office-review-run').hidden=true;$('office-consistency-run').hidden=true;
    busy=true;agentController=new AbortController();$('office-agent-run').hidden=true;$('office-agent-stop').hidden=false;$('office-agent-result').hidden=true;$('office-agent-log').innerHTML='';$('office-delivery-checks').innerHTML='';
    const activity = activityTimeline.start(getOwner());
    const submission = activity.record('提交文件处理任务', 'running');
    if (reviewMode) activity.record('准备文件处理上下文', 'done', { files: files.filter(file => selected.has(file.id)).map(file => file.name) });
    const log=(text,error=false)=>{const line=document.createElement('div');line.textContent=text;if(error)line.className='failure';$('office-agent-log').replaceChildren(line);};
    let submitted = false;
    try{
      await beforeAgent();
      submitted = true;
      const response=await api('/api/office/agent',{method:'POST',raw:true,signal:agentController.signal,body:{providerId:context.providerId,prompt,files:[...selected],review:reviewMode,consistency:consistencyMode,documentId:context.documentId,includeDocument:!reviewMode&&$('office-include-document').checked}});
      submission('done');
      let doneEvent=false,reviewRequired=false;
      for await (const { kind, data } of responseEvents(response.body)) {
        if(kind==='activity') activity.update(data);
        if(kind==='step') {
          log(t(data.ok===false?'正在调整处理步骤…':data.tool==='check_docx'?'正在检查生成文件…':data.tool?'正在处理文件…':'正在分析需求…'));
          if(reviewMode && data.text) {
            const text = Number.isInteger(data.locationsRead) ? t`正在读取检查范围（已读取 ${data.locationsRead} 个位置）…` : data.text;
            activity.record(text, data.ok===false ? 'attention' : 'notice');
          }
        }
        if(kind==='review')renderReview(data);
        if(kind==='check')$('office-delivery-checks').insertAdjacentHTML('beforeend',checkHtml(data));
        if(kind==='files'){files=data.files;renderFiles();}
        if(kind==='delta'){$('office-agent-result').hidden=false;$('office-agent-result').innerHTML=markdownToHtml(data.text);}
        if(kind==='error')throw new Error(data.message);
        if(kind==='done'){doneEvent=true;reviewRequired=data.reviewRequired;}
      }
      if(!doneEvent)throw new Error(t('连接提前结束，请检查文件库中已经生成的文件。'));log(consistencyMode?(review?.coverage.complete?'可提取文字检查完成，请审阅问题与依据。':'本次覆盖不完整，请查看检查范围。'):reviewMode?(review?'修改建议已生成，请逐条审阅后应用。':'未生成可应用的修改建议，请查看说明。'):reviewRequired?'处理已完成，交付检查中有待确认项。':'本次任务已完成。');
      activity.finish(reviewRequired || (consistencyMode && !review?.coverage.complete) ? 'attention' : 'done');
    }catch(error){
      if (!reviewMode && submitted) uncertainTask = true;
      const message = error.name === 'AbortError' ? t('已停止后续步骤。已执行的文件操作会保留。') : error.message;
      activity.finish(error.name === 'AbortError' ? 'stopped' : 'failed');
      log(uncertainTask && !reviewMode ? `${message} 再次点击运行时会先刷新文件库，供你核对已有产物。` : message, true);
    }
    finally{busy=false;if(review)$('office-review-apply').disabled=!$('office-review').querySelector('[data-review-operation]:checked');$('office-review-run').hidden=false;$('office-consistency-run').hidden=false;agentController=null;$('office-agent-run').hidden=false;$('office-agent-stop').hidden=true;const library=await api('/api/office/files').catch(()=>null);if(library){files=library.files;renderFiles();}}
  }
  $('office-refresh').onclick=show;$('office-upload').onclick=()=>$('office-file-input').click();
  $('office-search').onclick=async()=>{
    if(!selected.size){toast(t('先勾选需要检索的资料。'));return;}
    const query=$('office-search-query').value.trim();if(!query){$('office-search-query').focus();toast(t('请输入检索关键词。'));return;}
    $('office-search').disabled=true;
    try{const result=await api('/api/office/call',{method:'POST',body:{name:'search_sources',arguments:{files:[...selected],query}}});renderResult('search_sources',result);}
    catch(error){toast(error.message,true);}finally{$('office-search').disabled=false;}
  };
  $('office-search-query').onkeydown=event=>{if(event.key==='Enter')$('office-search').click();};
  const uploadFiles=async list=>{if(!list.length)return;$('office-upload').disabled=true;try{for(const file of list)await uploadFile(file);toast(t`已上传 ${list.length} 个文件`);}catch(error){toast(error.message,true);}finally{$('office-upload').disabled=false;}};
  $('office-file-input').onchange=async event=>{await uploadFiles([...event.target.files]);event.target.value='';};
  $('office-dropzone').onclick=()=>$('office-file-input').click();
  $('file-name-filter').oninput=renderFiles;
  $('office-dropzone').ondragover=event=>{event.preventDefault();$('office-dropzone').classList.add('dragging');};$('office-dropzone').ondragleave=()=>$('office-dropzone').classList.remove('dragging');
  $('office-dropzone').ondrop=event=>{event.preventDefault();$('office-dropzone').classList.remove('dragging');uploadFiles([...event.dataTransfer.files]);};
  $('office-file-list').onchange=event=>{if(event.target.dataset.officeSelect){event.target.checked?selected.add(event.target.dataset.officeSelect):selected.delete(event.target.dataset.officeSelect);$('office-selected').textContent=t`已选择 ${selected.size} 个文件`;}};
  $('office-file-list').onclick=async event=>{const edit=event.target.closest('[data-office-import]'),source=event.target.closest('[data-office-source]'),check=event.target.closest('[data-office-check]');if(edit)useFile(edit.dataset.officeImport,false);if(source)useFile(source.dataset.officeSource,true);if(check){check.disabled=true;try{const result=await api('/api/office/call',{method:'POST',body:{name:'check_docx',arguments:{file_path:check.dataset.officeCheck}}});files=result.files;renderFiles();renderResult('check_docx',result);}catch(error){toast(error.message,true);}finally{check.disabled=false;}}};
  $('office-tool-category').onchange=renderTools;$('office-tool-grid').onclick=event=>{const button=event.target.closest('[data-office-tool]');if(button)showTool(button.dataset.officeTool);};
  $('office-files-tab').onclick=()=>{$('office-files-panel').hidden=false;$('office-tools-panel').hidden=true;$('office-files-tab').setAttribute('aria-pressed','true');$('office-tools-tab').setAttribute('aria-pressed','false');};
  $('office-tools-tab').onclick=()=>{$('office-files-panel').hidden=true;$('office-tools-panel').hidden=false;$('office-files-tab').setAttribute('aria-pressed','false');$('office-tools-tab').setAttribute('aria-pressed','true');};
  document.querySelectorAll('[data-office-prompt]').forEach(button=>{button.onclick=()=>{$('office-agent-prompt').value=button.dataset.officePrompt;$('office-agent-prompt').focus();};});
  $('office-agent-run').onclick=()=>runAgent(false);$('office-review-run').onclick=()=>runAgent(true);$('office-consistency-run').onclick=()=>runAgent(true,true);$('office-agent-stop').onclick=()=>agentController?.abort();
  window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
  return{show,uploadAndExtract,get busy(){return busy;},selectTemplate(result){files=result.files;selected=new Set([result.file.id]);renderFiles();const prompt=$('office-agent-prompt');prompt.value=result.prompt;prompt.focus();const start=result.prompt.indexOf('（请在这里填写）');if(start>=0)prompt.setSelectionRange(start,start+'（请在这里填写）'.length);}};
}
