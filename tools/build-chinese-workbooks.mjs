// Run with the bundled Node runtime and artifact-tool dependencies.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
process.on('uncaughtException', error => { console.error(error.message); process.exit(1); });

const root = fileURLToPath(new URL('../', import.meta.url));
const dest = `${root}/resources/templates`;
const qa = `${root}/test-results/chinese-templates`;
await fs.mkdir(qa, { recursive: true });
const originals = JSON.parse(await fs.readFile(`${dest}/catalog.json`, 'utf8'));
const catalog = JSON.parse(await fs.readFile(`${dest}/catalog.zh-CN.json`, 'utf8')).filter(t => !['zh-business-budget', 'zh-cash-flow'].includes(t.id));

for (const cash of [false, true]) {
  const id = cash ? 'zh-cash-flow' : 'zh-business-budget';
  const title = cash ? '月度现金流预测表 中文版' : '年度预算执行表 中文版';
  const original = originals.find(t => t.id === (cash ? 'cash-flow' : 'business-budget'));
  const book = Workbook.create();
  const sheet = book.worksheets.add(cash ? '现金流预测' : '预算执行');
  const headers = cash ? ['月份','期初余额','销售收款','其他流入','流入合计','采购付款','经营支出','其他流出','流出合计','净流量','期末余额'] : ['月份','预算收入','实际收入','预算支出','实际支出','预算结余','实际结余','结余差额'];
  const last = cash ? 'K' : 'H';
  sheet.showGridLines = false;
  sheet.getRange(`A1:${last}25`).format.font.name = 'Microsoft YaHei';
  sheet.getRange(`A1:${last}25`).format.font.size = 11;
  sheet.getRange(`A1:${last}25`).format.font.color = '#252936';
  sheet.getRange(`A1:${last}25`).format.rowHeight = 29;
  sheet.getRange(`A1:${last}1`).merge();
  sheet.getRange('A1').values = [[title]];
  sheet.getRange('A1').format.font.size = 18;
  sheet.getRange('A1').format.font.bold = true;
  sheet.getRange(`A2:${last}2`).merge();
  sheet.getRange('A2').values = [['单位／项目：[待填写]    年度：[待填写]    金额单位：[待填写，全文一致]']];
  sheet.getRange(`A3:${last}3`).merge();
  sheet.getRange('A3').values = [[cash ? '填写浅蓝色输入格；首月期初填 B7，后续月份自动结转；空白按 0 计算。' : '填写浅蓝色输入格；结余与差额自动计算；差额＝实际结余－预算结余；空白按 0 计算。']];
  sheet.getRange(`A4:${last}4`).merge();
  sheet.getRange('A4').values = [['统一采用含税或不含税口径。月份按 1—12 月排列，其他会计年度可修改月份标签。']];
  sheet.getRange(`A6:${last}6`).values = [headers];
  sheet.getRange(`A6:${last}6`).format.fill = '#293140';
  sheet.getRange(`A6:${last}6`).format.font.color = '#FFFFFF';
  sheet.getRange(`A6:${last}6`).format.font.bold = true;
  sheet.getRange(`A6:${last}6`).format.rowHeight = 34;
  sheet.getRange(`A1:${last}25`).format.columnWidth = 15;
  sheet.getRange('A:A').format.columnWidth = 11;
  sheet.getRange(`B7:${last}20`).setNumberFormat('#,##0.00;[Red](#,##0.00);"—"');
  for (let i = 0; i < 12; i++) {
    const row = i + 7;
    sheet.getRange(`A${row}`).values = [[`${i + 1}月`]];
    const inputs = cash ? ['C','D','F','G','H'] : ['B','C','D','E'];
    for (const col of inputs) sheet.getRange(`${col}${row}`).format.fill = '#EDF1F7';
    if (cash) {
      if (i === 0) { sheet.getRange(`B${row}`).values = [[0]]; sheet.getRange(`B${row}`).format.fill = '#EDF1F7'; }
      else sheet.getRange(`B${row}`).formulas = [[`=K${row-1}`]];
      for (const [col, formula] of Object.entries({E:`SUM(C${row}:D${row})`,I:`SUM(F${row}:H${row})`,J:`E${row}-I${row}`,K:`B${row}+J${row}`})) sheet.getRange(`${col}${row}`).formulas = [[`=${formula}`]];
    } else for (const [col, formula] of Object.entries({F:`B${row}-D${row}`,G:`C${row}-E${row}`,H:`G${row}-F${row}`})) sheet.getRange(`${col}${row}`).formulas = [[`=${formula}`]];
  }
  sheet.getRange('A20').values = [[cash ? '年度／期末' : '年度合计']];
  for (let col = 1; col < headers.length; col++) {
    const letter = String.fromCharCode(65 + col);
    const formula = cash && letter === 'B' ? '=B7' : cash && letter === 'K' ? '=K18' : `=SUM(${letter}7:${letter}18)`;
    sheet.getRange(`${letter}20`).formulas = [[formula]];
  }
  sheet.getRange(`A20:${last}20`).format.fill = '#E0E5EC';
  sheet.getRange(`A20:${last}20`).format.font.bold = true;
  sheet.getRange(`A6:${last}20`).format.borders = {insideHorizontal:{style:'thin',color:'#E0E5EC'}};
  sheet.freezePanes.freezeRows(6);
  sheet.getRange(`A22:${last}22`).merge();
  sheet.getRange('A22').values = [['来源：business.gov.au 通用预算／现金流模板；灵笺中文改编，调整月份、字段及版式。']];
  sheet.getRange(`A23:${last}23`).merge();
  sheet.getRange('A23').values = [[original.source.url]];
  sheet.getRange(`A24:${last}24`).merge();
  sheet.getRange('A24').values = [['© Commonwealth of Australia 2020 · CC BY 3.0 AU · https://creativecommons.org/licenses/by/3.0/au/']];
  sheet.getRange(`A25:${last}25`).merge();
  sheet.getRange('A25').values = [['本表用于内部计划和跟踪；请以实际收支核对，按需要补充科目，不作为法定财务报表。']];
  sheet.getRange(`A22:${last}25`).format.font.size = 10;
  // Exercise the actual calculation engine, including later-month roll-forward.
  if (cash) {
    sheet.getRange('B7:D7').values = [[1000,200,0]];
    sheet.getRange('F7').values = [[50]];
    book.recalculate();
    assert.equal(sheet.getRange('K7').values[0][0],1150);
    assert.equal(sheet.getRange('B8').values[0][0],1150);
    sheet.getRange('B7:D7').values = [[0,null,null]];
    sheet.getRange('F7').values = [[null]];
  } else {
    sheet.getRange('B7:E7').values = [[1000,1200,200,250]];
    book.recalculate();
    assert.equal(sheet.getRange('F7').values[0][0],800);
    assert.equal(sheet.getRange('G7').values[0][0],950);
    assert.equal(sheet.getRange('H20').values[0][0],150);
    sheet.getRange('B7:E7').values = [[null,null,null,null]];
  }
  book.recalculate();
  const errors = await book.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#NUM!|#NULL!|#SPILL!|#CALC!',options:{useRegex:true,maxResults:10},maxChars:1500});
  console.log(id, errors.ndjson);
  const preview = await book.render({sheetName:sheet.name,range:`A1:${last}25`,scale:1.3,format:'png'});
  await fs.writeFile(`${qa}/${id}.png`,new Uint8Array(await preview.arrayBuffer()));
  const filename = `${id}-workbook.xlsx`;
  await (await SpreadsheetFile.exportXlsx(book)).save(`${dest}/${filename}`);
  const bytes = await fs.readFile(`${dest}/${filename}`);
  catalog.push({id,category:'财务表格',title:cash?'月度现金流预测表 中文版':'年度预算执行表 中文版',subtitle:cash?'自动结转期初期末余额，追踪每月资金变化':'逐月对照预算与实际，自动计算结余差额',language:'中文',description:'根据 business.gov.au 开放许可模板改编为简体中文，重排为单页工作表，包含输入区域、自动计算和来源说明。',sections:cash?['期初余额','现金流入','现金流出','净流量','期末余额']:['预算收入','实际收入','预算支出','实际支出','结余与差额'],rules:cash?'统一金额单位和含税口径，仅填写输入格，保留汇总与期初结转公式。现金收入和利润不能混用，未提供的数值不得虚构。':'统一金额单位和统计周期，区分预算和实际，只填写输入格，保留结余及年度合计公式，不虚构收支。',usage:['先填写单位、年度、金额单位，统一含税或不含税口径。',cash?'填写 B7 首月期初余额和浅蓝色收支输入格，后续月份自动结转。':'填写浅蓝色预算与实际输入格，结余及差额自动计算。','空白输入按 0 计算；确认数据完整后再使用合计，插入新科目后复核公式。'],source:{...original.source,attribution:'© Commonwealth of Australia 2020. Adapted into Simplified Chinese by 灵笺; layout, month labels and fields modified under CC BY 3.0 AU.'},assets:[{id:'workbook',label:'中文 Excel 自动计算版',format:'XLSX',file:filename,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),derivedFrom:original.assets[0].sha256}]});
}
await fs.writeFile(`${dest}/catalog.zh-CN.json`,JSON.stringify(catalog,null,2)+'\n');
