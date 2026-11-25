import { buildMessages, htmlToText } from './prompts.mjs';
import { runModel, modelToolTurn, UserError } from './providers.mjs';
import { selectSkill } from './skills.mjs';
import { createSkillRuntime } from './agent-skills.mjs';
import { runOfficeAgent } from './office-agent.mjs';

export async function runWritingTask(config, key, document, input, { signal, onEvent = () => {}, office, customTemplates = [] } = {}) {
  const explicit = input.skillId && !['auto', 'none'].includes(input.skillId);
  const skill = explicit ? selectSkill(input.skillId, { surface: 'writing' }) : null;
  const runtime = createSkillRuntime('writing');
  const messages = buildMessages(document, input, customTemplates);
  onEvent('skill', skill ? { id: skill.id, title: skill.title } : { id: 'none', title: '通用写作' });
  const usageByStage = new Map();
  const usage = stage => value => {
    usageByStage.set(stage, { input_tokens: value.prompt_tokens ?? value.input_tokens, output_tokens: value.completion_tokens ?? value.output_tokens });
    const total = {};
    for (const report of usageByStage.values()) for (const field of ['input_tokens', 'output_tokens']) {
      if (Number.isFinite(report[field])) total[field] = (total[field] || 0) + report[field];
    }
    onEvent('usage', total);
  };
  if (skill) await runtime.activate({ skill_id: skill.id });
  else if (input.skillId !== 'none' && input.mode === 'write') {
    onEvent('step', { phase: 'prepare', text: '正在分析写作需求…' });
    const preparation = [{ ...messages[0], content: messages[0].content + '\n' + runtime.catalogPrompt + '\n当前为任务准备阶段，按需加载技能；准备就绪后简短确认，不输出正文。' }, ...messages.slice(1)];
    const tools = [runtime.tool];
    const processFiles = office && await office.isConfigured().catch(() => false);
    if (processFiles) {
      tools.push({name:'process_files',description:'仅在用户明确要求生成实际 Word/Excel/PPT/PDF 文件时，交给平台文件流程生成并交付下载。普通草稿、润色或审阅不使用。',inputSchema:{type:'object',properties:{request:{type:'string',description:'保留用户要求的具体文件交付任务'}},required:['request'],additionalProperties:false}});
      preparation[0].content += '\n用户要求实际文件时调用 process_files，并且不设置 ready_for_writing。只需编辑器正文时继续准备写作。';
    } else {
      preparation[0].content += '\n当前只生成编辑器正文，用户可用编辑器导出 DOCX。';
    }
    preparation[0].content += '\n如需正文技能，可在本轮一次选择多项；最后一个 use_skill 调用指定 ready_for_writing:true，平台会加载全部选中技能后直接起草，无需另行确认“准备完成”。仍需其他准备时不设置。';
    const rules = preparation[0].content;
    for (let round = 0; round < 4; round++) {
      const turn = await modelToolTurn(config, key, preparation, tools, signal);
      if (turn.usage) usage(`prepare-${round}`)(turn.usage);
      if (!turn.calls.length) break;
      preparation.push(...turn.append);
      let ready = false, preparationFailed = false;
      for (const call of turn.calls) {
        if (call.name === 'process_files' && processFiles) {
          let args; try { args = JSON.parse(call.arguments || '{}'); } catch { throw new UserError('文件任务准备失败，请重试。', 502); }
          if (typeof args.request !== 'string' || !args.request.trim() || args.request.length > 10000) throw new UserError('文件处理要求为空或过长。');
          const context = [document.title, htmlToText(document.html), ...document.sources.filter(source=>source.enabled!==false).map(source=>`[资料：${source.name}]\n${source.text}`)].join('\n\n');
          if (context.length > 80000) throw new UserError('文件生成的正文与资料超过 8 万字符，请精简后重试。');
          onEvent('delivery', {fileTask: true});
          const initial = new Set((await office.listFiles()).map(file=>file.id));
          let fileUsageStage = 0;
          const outputRule = input.outputLanguage === 'en' ? '\nWrite the file content in English.' : input.outputLanguage === 'zh-CN' ? '\n请用简体中文撰写文件正文。' : '';
          await runOfficeAgent(config,key,office,{prompt:`用户原始要求：${input.prompt}\n文件交付任务：${args.request}${outputRule}`,files:[],document:context},{signal,onEvent:(kind,data)=>{
            if(kind==='files') onEvent(kind,{files:data.files.filter(file=>!initial.has(file.id)&&!/[.]check_[a-f0-9]{8}[.]json$/i.test(file.id))});
            else if(kind==='usage') usage(`file-${fileUsageStage++}`)(data);
            else onEvent(kind,data);
          }});
          return { fileTask: true };
        }
        let output;
        try {
          if (call.name !== 'use_skill' || !call.id) throw new Error('不支持的准备操作。');
          const args = JSON.parse(call.arguments || '{}');
          output = JSON.stringify(await runtime.activate(args));
          ready ||= args.ready_for_writing === true;
        } catch (error) { preparationFailed = true; output = JSON.stringify({ error: error.message }); }
        preparation.push(config.protocol === 'responses' ? { type: 'function_call_output', call_id: call.id, output } : { role: 'tool', tool_call_id: call.id, content: output });
      }
      preparation[0].content = rules + '\n' + runtime.instructions;
      if (ready && !preparationFailed) break;
      if (round === 3) throw new UserError('任务准备未能完成，请缩小需求后重试。', 502);
    }
  }
  messages[0].content += '\n' + runtime.instructions;
  if (runtime.active.has('report-writing') && input.mode === 'write') {
    onEvent('step', { phase: 'plan', text: '正在整理资料依据与报告提纲…' });
    const plan = await runModel(config, key, [...messages, { role: 'user', content: '本次先只输出写作提纲：列明章节、各章可用的资料依据和待补充项，控制在 1500 字内。下一步才起草正文。' }], { signal, onUsage: usage('plan') });
    if (plan.length > 12000) throw new UserError('写作提纲过长，请缩小报告范围后重试。', 502);
    messages.push({ role: 'assistant', content: plan }, { role: 'user', content: '按上述提纲和原始资料撰写本次要求的正文。只输出可直接审阅的正文，不重复提纲说明。' });
  }
  onEvent('step', { phase: 'draft', text: skill?.id === 'source-synthesis' ? '正在归纳资料与来源…' : '正在生成正文…' });
  return runModel(config, key, messages, { signal, onProgress: phase => onEvent('step', { phase, text: '模型正在思考…' }), onDelta: text => onEvent('delta', { text }), onUsage: usage('draft') });
}
