'use strict';

/**
 * 「室町时代材料」本地直连导入（不经 HTTP / 不需 token / 不需 admin 构建）
 *
 * 解析逻辑与 scripts/import-muromachi.js 完全一致（列位置 + 图片锚点归行），
 * 区别仅在于：用 compileStrapi() 启动 Strapi 内核后，直接调用
 *   - upload 插件 service 上传图片
 *   - documents API 创建并发布 character
 * 速度远快于 HTTP 版（无网络往返、无节流）。
 *
 * 用法（backend/ 下）：
 *   node scripts/import-local.js "../室町时代材料录入(1)"            # 全部 xlsx
 *   node scripts/import-local.js "../室町时代材料录入(1)/雲陣夜話.xlsx" --limit 20   # 单文件前20行（自测）
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');
const XLSX = require('xlsx');
const { compileStrapi, createStrapi } = require('@strapi/core');

const argv     = process.argv.slice(2);
const CLI_PATH = argv.find(a => !a.startsWith('--'));
const LIMIT    = (() => { const i = argv.indexOf('--limit'); return i >= 0 ? parseInt(argv[i + 1], 10) : Infinity; })();
const UID      = 'api::character.character';

// 列位置映射（0-based），与 import-muromachi.js 一致
const COL = { searchIndex: 0, character: 2, type: 3, symbol: 4, usage: 5, source: 6, era: 7, note: 8 };

// ============ XLSX 图片锚点解析（复用自 import-muromachi.js） ============
function extractXlsx(xlsxPath) {
  const tmpDir = path.join(os.tmpdir(), 'strapi_muro_' + process.pid + '_' + Math.round(process.hrtime()[1]));
  fs.mkdirSync(tmpDir, { recursive: true });
  execSync(`unzip -o "${xlsxPath}" -d "${tmpDir}"`, { stdio: 'pipe' });
  return tmpDir;
}
function parseDrawingRels(relsPath) {
  const xml = fs.readFileSync(relsPath, 'utf8');
  const ridToFile = {};
  const re = /Id="(rId\d+)"[^>]+Target="\.\.\/media\/([^"]+)"/g;
  let m; while ((m = re.exec(xml)) !== null) ridToFile[m[1]] = m[2];
  return ridToFile;
}
function parseRowHeights(sheetPath) {
  const sheetXml = fs.readFileSync(sheetPath, 'utf8');
  let defaultRowHeight = 15;
  const fmt = /<sheetFormatPr[^>]*defaultRowHeight="([\d.]+)"/.exec(sheetXml);
  if (fmt) defaultRowHeight = parseFloat(fmt[1]);
  const rowHeights = {};
  const rowRe = /<row r="(\d+)"([^>]*)>/g;
  let m; while ((m = rowRe.exec(sheetXml)) !== null) {
    const htM = /\bht="([\d.]+)"/.exec(m[2]);
    if (htM) rowHeights[parseInt(m[1])] = parseFloat(htM[1]);
  }
  return { rowHeights, defaultRowHeight };
}
function makeRowHeightEmu(rowHeights, defaultRowHeight) {
  const DEFAULT_EMU = defaultRowHeight * 12700;
  return (rowNum) => { const pt = rowHeights[rowNum]; return pt !== undefined ? pt * 12700 : DEFAULT_EMU; };
}
function parseFromTo(xml, tag) {
  const m = new RegExp(`<xdr:${tag}>([\\s\\S]*?)<\\/xdr:${tag}>`).exec(xml);
  if (!m) return null;
  const rowM = /<xdr:row>(\d+)<\/xdr:row>/.exec(m[1]);
  const rowOffM = /<xdr:rowOff>(-?\d+)<\/xdr:rowOff>/.exec(m[1]);
  if (!rowM) return null;
  return { row: parseInt(rowM[1]), rowOff: rowOffM ? parseInt(rowOffM[1]) : 0 };
}
function resolveAnchorRow(from, to, rowHeightEmu) {
  if (from.row === to.row) return from.row + 1;
  const coverage = {};
  for (let r = from.row; r <= to.row; r++) {
    const sheetRow = r + 1; const h = rowHeightEmu(sheetRow);
    const start = r === from.row ? from.rowOff : 0;
    let end = r === to.row ? to.rowOff : h; if (end > h) end = h;
    coverage[sheetRow] = Math.max(0, end - start);
  }
  let bestRow = from.row + 1, bestVal = -1;
  for (const [r, v] of Object.entries(coverage)) if (v > bestVal) { bestVal = v; bestRow = parseInt(r); }
  return bestRow;
}
function extToVirtualTo(from, extCy, rowHeightEmu) {
  let row = from.row, remain = from.rowOff + extCy, h = rowHeightEmu(row + 1);
  while (remain > h) { remain -= h; row += 1; h = rowHeightEmu(row + 1); }
  return { row, rowOff: remain };
}
function parseDrawing(drawingPath, ridToFile, rowHeightEmu) {
  const xml = fs.readFileSync(drawingPath, 'utf8');
  const rowToImages = {};
  const anchorRe = /<xdr:(oneCellAnchor|twoCellAnchor|absoluteAnchor)(?:\s[^>]*)?>([\s\S]*?)<\/xdr:\1>/g;
  let m;
  while ((m = anchorRe.exec(xml)) !== null) {
    const type = m[1], block = m[2];
    const embedMatch = /r:embed="(rId\d+)"/.exec(block); if (!embedMatch) continue;
    const filename = ridToFile[embedMatch[1]]; if (!filename) continue;
    const from = parseFromTo(block, 'from'); if (!from) continue;
    let to;
    if (type === 'twoCellAnchor') { to = parseFromTo(block, 'to'); if (!to) continue; }
    else { const extM = /<xdr:ext\s+cx="\d+"\s+cy="(\d+)"/.exec(block); to = extToVirtualTo(from, extM ? parseInt(extM[1]) : 0, rowHeightEmu); }
    const sheetRow = resolveAnchorRow(from, to, rowHeightEmu);
    (rowToImages[sheetRow] = rowToImages[sheetRow] || []).push(filename);
  }
  return { rowToImages };
}
function dedupe(arr) { const out = []; for (const x of (arr || [])) if (!out.includes(x)) out.push(x); return out; }
const cell = (arr, i) => { const v = arr[i]; return v === undefined || v === null ? '' : String(v).trim(); };

// ============ Strapi 内核交互 ============
let strapi;

async function uploadOne(imgPath, uploadName) {
  const size = fs.statSync(imgPath).size;
  const files = { filepath: imgPath, originalFilename: uploadName, mimetype: 'image/png', size };
  const res = await strapi.plugin('upload').service('upload').upload({ data: {}, files });
  const file = Array.isArray(res) ? res[0] : res;
  return file.id;
}

async function createPublished(record, fileIds) {
  const doc = await strapi.documents(UID).create({ data: { ...record, Imge: fileIds } });
  await strapi.documents(UID).publish({ documentId: doc.documentId });
}

// ============ 单文件处理 ============
async function processFile(xlsxPath, summary) {
  const prefix = path.basename(xlsxPath, path.extname(xlsxPath));
  console.log(`\n======== 文件：${prefix}.xlsx ========`);
  const tmpDir = extractXlsx(xlsxPath);
  try {
    const mediaDir  = path.join(tmpDir, 'xl/media');
    const ridToFile = parseDrawingRels(path.join(tmpDir, 'xl/drawings/_rels/drawing1.xml.rels'));
    const { rowHeights, defaultRowHeight } = parseRowHeights(path.join(tmpDir, 'xl/worksheets/sheet1.xml'));
    const rowHeightEmu = makeRowHeightEmu(rowHeights, defaultRowHeight);
    const { rowToImages } = parseDrawing(path.join(tmpDir, 'xl/drawings/drawing1.xml'), ridToFile, rowHeightEmu);

    const wb = XLSX.readFile(xlsxPath);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true, defval: '' });

    const planned = [];
    let seq = 0;
    for (let r = 2; r <= rows.length; r++) {
      const arr = rows[r - 1] || [];
      const character = cell(arr, COL.character), type = cell(arr, COL.type);
      if (!character && !type) continue;
      if (!character || !type) { console.warn(`  [跳过] 第${r}行必填缺失`); continue; }
      seq += 1;
      const record = { Index: `${prefix}-${String(seq).padStart(4, '0')}`, Character: character, Type: type };
      const sv = cell(arr, COL.searchIndex); if (sv) record.SearchIndex = sv;
      const sy = cell(arr, COL.symbol); if (sy) record.Symbol = sy;
      const us = cell(arr, COL.usage);  if (us) record.Usage = us;
      const so = cell(arr, COL.source); if (so) record.Source = so;
      const er = cell(arr, COL.era);    if (er) record.Era = er;
      const no = cell(arr, COL.note);   if (no) record.Note = no;
      planned.push({ excelRow: r, record, images: dedupe(rowToImages[r]) });
    }

    const noImage = planned.filter(p => p.images.length === 0);
    if (noImage.length > 0) {
      console.error(`  [中止] ${noImage.length} 个无图行，跳过本文件`);
      summary.fileErrors.push(`${prefix}: ${noImage.length} 无图行`);
      return;
    }

    const work = planned.slice(0, LIMIT === Infinity ? planned.length : LIMIT);
    console.log(`  待入库：${work.length} 行（共解析 ${planned.length}）`);

    const nameToId = {};            // 同源同名图片只上传一次
    let created = 0, uploaded = 0, failed = 0;
    for (let i = 0; i < work.length; i++) {
      const { excelRow, record, images } = work[i];
      try {
        const fileIds = [];
        for (const imgFile of images) {
          const uploadName = `${prefix}-${imgFile}`;
          let id = nameToId[uploadName];
          if (!id) {
            const imgPath = path.join(mediaDir, imgFile);
            if (!fs.existsSync(imgPath)) throw new Error(`图片缺失 ${imgFile}`);
            id = await uploadOne(imgPath, uploadName);
            nameToId[uploadName] = id; uploaded++;
          }
          fileIds.push(id);
        }
        await createPublished(record, fileIds);
        created++;
      } catch (e) {
        console.error(`  [失败] ${record.Index}（第${excelRow}行）：${e.message}`);
        failed++;
      }
      if ((i + 1) % 200 === 0) console.log(`    进度 ${i + 1}/${work.length}（建${created} 传图${uploaded} 失败${failed}）`);
    }
    console.log(`  完成：创建 ${created}，上传图片 ${uploaded}，失败 ${failed}`);
    summary.created += created; summary.uploaded += uploaded; summary.failed += failed;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

function resolveTargets(inputPath) {
  const abs = path.resolve(process.cwd(), inputPath);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    return fs.readdirSync(abs)
      .filter(f => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$') && !f.startsWith('.'))
      .sort().map(f => path.join(abs, f));
  }
  return [abs];
}

async function main() {
  if (!CLI_PATH) { console.error('用法：node scripts/import-local.js <文件夹或xlsx路径> [--limit N]'); process.exit(1); }
  const targets = resolveTargets(CLI_PATH);
  console.log(`=== 本地直连导入（${targets.length} 个文件）===`);

  console.log('正在编译并启动 Strapi 内核（仅服务端，不构建 admin）...');
  const appContext = await compileStrapi();
  strapi = createStrapi(appContext);
  strapi.log.level = 'error';        // 减少噪声
  await strapi.load();
  console.log('Strapi 内核已就绪。');

  const summary = { created: 0, uploaded: 0, failed: 0, fileErrors: [] };
  try {
    for (const t of targets) await processFile(t, summary);
  } finally {
    console.log(`\n===== 总汇总 =====`);
    console.log(`  创建 ${summary.created}，上传图片 ${summary.uploaded}，失败 ${summary.failed}`);
    if (summary.fileErrors.length) summary.fileErrors.forEach(e => console.log(`   ⚠ ${e}`));
    await strapi.destroy();
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('脚本异常：', e); process.exit(1); });
