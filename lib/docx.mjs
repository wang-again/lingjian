import { UserError } from './providers.mjs';

// Minimal OOXML writer: standard ZIP container, editable Word paragraphs/lists/tables.
const escape = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const table = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(value), crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(filename.length, 26);
    local.push(head, filename, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(filename.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, filename); offset += head.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const xml = value => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${value}`;
function runs(value) {
  const items = Array.isArray(value) ? value : [{ text: value || '' }];
  return items.map(run => {
    const style = [run.bold ? '<w:b/>' : '', run.italic ? '<w:i/>' : '', run.underline ? '<w:u w:val="single"/>' : ''].join('');
    return String(run.text || '').split('\n').map((line, i) => `<w:r>${style ? `<w:rPr>${style}</w:rPr>` : ''}${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${escape(line)}</w:t></w:r>`).join('');
  }).join('');
}
function paragraph(block) {
  let properties = '';
  if (block.type === 'heading') properties += `<w:pStyle w:val="Heading${Math.max(1, Math.min(3, Number(block.level) || 1))}"/>`;
  if (block.type === 'quote') properties += '<w:pStyle w:val="Quote"/>';
  if (block.type === 'list') properties += `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${block.ordered ? 2 : 1}"/></w:numPr>`;
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${runs(block.runs || block.text)}</w:p>`;
}
export function createDocx(title, blocks) {
  if (!Array.isArray(blocks) || blocks.length > 10_000) throw new UserError('文档结构不正确或内容过多。');
  let cells = 0;
  const body = blocks.map(block => {
    if (block.type !== 'table') return paragraph(block);
    const rows = block.rows;
    if (!Array.isArray(rows) || !rows.length || rows.some(row => !Array.isArray(row) || !row.length)) throw new UserError('表格中存在空行或无效单元格，请检查表格后再导出。');
    const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
    if (columns > 63) throw new UserError('Word 导出每张表格最多支持 63 列，请拆分表格后再导出。');
    cells += rows.reduce((total, row) => total + row.length, 0);
    if (cells > 50_000) throw new UserError('Word 导出最多支持 5 万个表格单元格，请拆分文档后再导出。');
    const grid = `<w:tblGrid>${`<w:gridCol w:w="${Math.floor(9026 / columns)}"/>`.repeat(columns)}</w:tblGrid>`;
    const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:color="D9E1DE"/>`).join('');
    const tableRows = rows.map((row, i) => {
      const properties = `${row.length < columns ? `<w:gridAfter w:val="${columns - row.length}"/>` : ''}${i === 0 ? '<w:tblHeader/>' : ''}`;
      const tableCells = row.map(cell => `<w:tc>${i === 0 ? '<w:tcPr><w:shd w:fill="EDF3F0"/></w:tcPr>' : ''}${paragraph({ text: String(cell ?? '') })}</w:tc>`).join('');
      return `<w:tr>${properties ? `<w:trPr>${properties}</w:trPr>` : ''}${tableCells}</w:tr>`;
    }).join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>${grid}${tableRows}</w:tbl><w:p/>`;
  }).join('');
  const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const styles = `<w:styles xmlns:w="${namespace}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="400"/></w:pPr><w:rPr><w:b/><w:rFonts w:eastAsia="微软雅黑"/><w:color w:val="213F38"/><w:sz w:val="40"/></w:rPr></w:style>${[1, 2, 3].map(level => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="320" w:after="160"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:rFonts w:eastAsia="微软雅黑"/><w:b/><w:color w:val="213F38"/><w:sz w:val="${[32, 28, 24][level - 1]}"/></w:rPr></w:style>`).join('')}<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:pPr><w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="16" w:color="8BA79B"/></w:pBdr></w:pPr><w:rPr><w:i/><w:color w:val="52635C"/></w:rPr></w:style></w:styles>`;
  const numbering = `<w:numbering xmlns:w="${namespace}">${[1, 2].map(id => `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${id === 1 ? 'bullet' : 'decimal'}"/><w:lvlText w:val="${id === 1 ? '•' : '%1.'}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="480" w:hanging="240"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="${id}"><w:abstractNumId w:val="${id}"/></w:num>`).join('')}</w:numbering>`;
  return zip({
    '[Content_Types].xml': xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + ['document', 'styles', 'numbering', 'footer1'].map(part => `<Override PartName="/word/${part}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${part === 'footer1' ? 'footer' : part === 'document' ? 'document.main' : part}+xml"/>`).join('') + '</Types>'),
    '_rels/.rels': xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': xml(`<w:document xmlns:w="${namespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${runs(title)}</w:p>${body}<w:sectPr><w:footerReference w:type="default" r:id="rId3"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/></w:sectPr></w:body></w:document>`),
    'word/_rels/document.xml.rels': xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>'),
    'word/styles.xml': xml(styles), 'word/numbering.xml': xml(numbering),
    'word/footer1.xml': xml(`<w:ftr xmlns:w="${namespace}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:color w:val="7B8680"/><w:sz w:val="18"/></w:rPr><w:t>— </w:t></w:r><w:fldSimple w:instr="PAGE"/><w:r><w:t> —</w:t></w:r></w:p></w:ftr>`)
  });
}
