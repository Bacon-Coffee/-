'use strict';

/**
 * 「室町时代材料录入」批量导入脚本（单趟：信息 + 图片 一次完成）
 *
 * 背景与现有 import-excel.js / import-images.js 的差异：
 *   1. 原始「序号」(如 11-6) 不唯一 —— 多行共用，不能直接当 Index。
 *      → Index = `源-NNNN`（源取文件名，每文件内从 1 递增补零四位），全库唯一。
 *      → 原始序号存入新字段 SearchIndex（查找序号），可重复，仅存储/检索用。
 *   2. 三个文件繁简表头混用 —— 改用「列位置」读值，规避表头名差异。
 *   3. 跨文件图片同名（imageN.png 编号重叠）—— 上传时给文件名加源前缀防错误复用。
 *
 * 硬约束：每条记录必须有图片。导入前对每个有效数据行强制校验「图片数 ≥ 1」；
 *         一旦某文件出现任何「有字无图」行，输出完整清单并中止该文件（不写库）。
 *
 * 用法（在 backend/ 目录下，Strapi 须已启动）：
 *   node scripts/import-muromachi.js "../室町时代材料录入(1)"      # 传文件夹，跑完全部 xlsx
 *   node scripts/import-muromachi.js "../室町时代材料录入(1)/傷寒初心抄.xlsx"  # 传单个文件
 *
 * 幂等：记录按 Index 去重，已存在且有图→跳过；已存在无图→补图；中断后可重跑续传。
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');
const XLSX = require('xlsx');

// ---- 配置 ----
const argv       = process.argv.slice(2);
const DRY_RUN    = argv.includes('--dry-run'); // 仅解析 + 无图校验，不连 Strapi、不写库
const CLI_PATH   = argv.find(a => !a.startsWith('--'));
// 令牌不再硬编码：从 backend/.env 读取 ADMIN_WRITE_TOKEN，或环境变量 STRAPI_TOKEN
try { require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); } catch (e) {}
const STRAPI_URL = process.env.STRAPI_URL   || 'http://localhost:1337';
const API_TOKEN  = process.env.STRAPI_TOKEN || process.env.ADMIN_WRITE_TOKEN;
if (!API_TOKEN && !DRY_RUN) {
  console.error('✖ 缺少 API 令牌：请在 backend/.env 设置 ADMIN_WRITE_TOKEN，或导出环境变量 STRAPI_TOKEN');
  process.exit(1);
}

const HEADERS = { Authorization: `Bearer ${API_TOKEN}` };
const delay   = (ms) => new Promise(r => setTimeout(r, ms));

// 列位置映射（0-based）；B 列(=1)「字样」仅图片无单元格值，故不读
const COL = {
  searchIndex: 0, // A 序号 → SearchIndex
  character:   2, // C 字位 → Character (必填)
  type:        3, // D 字种 → Type      (必填)
  symbol:      4, // E 语符 → Symbol
  usage:       5, // F 使用属性 → Usage
  source:      6, // G 出处 → Source
  era:         7, // H 时代 → Era
  note:        8, // I 备注 → Note
};

// ============================================================
// 图片锚点解析（逻辑复用自 import-images.js，已在《種種藥帳》验证）
// ============================================================

function extractXlsx(xlsxPath) {
  const tmpDir = path.join(os.tmpdir(), 'strapi_muro_' + Date.now() + '_' + Math.random().toString(36).slice(2));
  fs.mkdirSync(tmpDir, { recursive: true });
  execSync(`unzip -o "${xlsxPath}" -d "${tmpDir}"`, { stdio: 'pipe' });
  return tmpDir;
}

function parseDrawingRels(relsPath) {
  const xml = fs.readFileSync(relsPath, 'utf8');
  const ridToFile = {};
  const re = /Id="(rId\d+)"[^>]+Target="\.\.\/media\/([^"]+)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) ridToFile[m[1]] = m[2];
  return ridToFile;
}

// 仅提取行高（point）与默认行高，用于图片锚点按覆盖面积归行
function parseRowHeights(sheetPath) {
  const sheetXml = fs.readFileSync(sheetPath, 'utf8');
  let defaultRowHeight = 15;
  const fmt = /<sheetFormatPr[^>]*defaultRowHeight="([\d.]+)"/.exec(sheetXml);
  if (fmt) defaultRowHeight = parseFloat(fmt[1]);
  const rowHeights = {};
  const rowRe = /<row r="(\d+)"([^>]*)>/g;
  let m;
  while ((m = rowRe.exec(sheetXml)) !== null) {
    const htM = /\bht="([\d.]+)"/.exec(m[2]);
    if (htM) rowHeights[parseInt(m[1])] = parseFloat(htM[1]);
  }
  return { rowHeights, defaultRowHeight };
}

function makeRowHeightEmu(rowHeights, defaultRowHeight) {
  const DEFAULT_EMU = defaultRowHeight * 12700;
  return (rowNum) => {
    const pt = rowHeights[rowNum];
    return pt !== undefined ? pt * 12700 : DEFAULT_EMU;
  };
}

function parseFromTo(xml, tag) {
  const m = new RegExp(`<xdr:${tag}>([\\s\\S]*?)<\\/xdr:${tag}>`).exec(xml);
  if (!m) return null;
  const rowM    = /<xdr:row>(\d+)<\/xdr:row>/.exec(m[1]);
  const rowOffM = /<xdr:rowOff>(-?\d+)<\/xdr:rowOff>/.exec(m[1]);
  if (!rowM) return null;
  return { row: parseInt(rowM[1]), rowOff: rowOffM ? parseInt(rowOffM[1]) : 0 };
}

function resolveAnchorRow(from, to, rowHeightEmu) {
  if (from.row === to.row) return from.row + 1;
  const coverage = {};
  for (let r = from.row; r <= to.row; r++) {
    const sheetRow = r + 1;
    const h        = rowHeightEmu(sheetRow);
    const start    = r === from.row ? from.rowOff : 0;
    let   end      = r === to.row   ? to.rowOff   : h;
    if (end > h) end = h;
    coverage[sheetRow] = Math.max(0, end - start);
  }
  let bestRow = from.row + 1, bestVal = -1;
  for (const [r, v] of Object.entries(coverage)) {
    if (v > bestVal) { bestVal = v; bestRow = parseInt(r); }
  }
  return bestRow;
}

function extToVirtualTo(from, extCy, rowHeightEmu) {
  let row = from.row;
  let remain = from.rowOff + extCy;
  let h = rowHeightEmu(row + 1);
  while (remain > h) { remain -= h; row += 1; h = rowHeightEmu(row + 1); }
  return { row, rowOff: remain };
}

function parseDrawing(drawingPath, ridToFile, rowHeightEmu) {
  const xml = fs.readFileSync(drawingPath, 'utf8');
  const rowToImages = {};
  const stats = { oneCellAnchor: 0, twoCellAnchor: 0, absoluteAnchor: 0, skipped: 0 };
  const anchorRe =
    /<xdr:(oneCellAnchor|twoCellAnchor|absoluteAnchor)(?:\s[^>]*)?>([\s\S]*?)<\/xdr:\1>/g;
  let m;
  while ((m = anchorRe.exec(xml)) !== null) {
    const type  = m[1];
    const block = m[2];
    const embedMatch = /r:embed="(rId\d+)"/.exec(block);
    if (!embedMatch) { stats.skipped++; continue; }
    const filename = ridToFile[embedMatch[1]];
    if (!filename) { stats.skipped++; continue; }
    const from = parseFromTo(block, 'from');
    if (!from) { stats.skipped++; continue; }
    let to;
    if (type === 'twoCellAnchor') {
      to = parseFromTo(block, 'to');
      if (!to) { stats.skipped++; continue; }
    } else {
      const extM = /<xdr:ext\s+cx="\d+"\s+cy="(\d+)"/.exec(block);
      const cy   = extM ? parseInt(extM[1]) : 0;
      to = extToVirtualTo(from, cy, rowHeightEmu);
    }
    const sheetRow = resolveAnchorRow(from, to, rowHeightEmu);
    (rowToImages[sheetRow] = rowToImages[sheetRow] || []).push(filename);
    stats[type]++;
  }
  return { rowToImages, stats };
}

// 同行去重（同锚点重复引用的图片只保留一次）
function dedupe(arr) {
  const out = [];
  for (const x of (arr || [])) if (!out.includes(x)) out.push(x);
  return out;
}

// ============================================================
// Strapi 交互
// ============================================================

// 按源前缀拉取媒体库已上传文件（用于重跑复用，避免重复上传）
async function fetchMediaByPrefix(prefix) {
  const nameToId = {};
  const res = await fetch(
    `${STRAPI_URL}/api/upload/files?filters[name][$startsWith]=${encodeURIComponent(prefix + '-')}`,
    { headers: HEADERS }
  );
  if (!res.ok) return nameToId; // best-effort，失败则一律新上传
  const data  = await res.json();
  const files = Array.isArray(data) ? data : (data.results || []);
  for (const f of files) if (f.name) nameToId[f.name] = f.id;
  return nameToId;
}

async function uploadImage(imagePath, uploadName) {
  const fileBuffer = fs.readFileSync(imagePath);
  const blob = new Blob([fileBuffer], { type: 'image/png' });
  const formData = new FormData();
  formData.append('files', blob, uploadName);
  const res = await fetch(`${STRAPI_URL}/api/upload`, { method: 'POST', headers: HEADERS, body: formData });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`上传 HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const file = Array.isArray(data) ? data[0] : data;
  return file.id;
}

// 查 Index 是否已存在 → { exists, documentId, hasImage }
async function findByIndex(indexVal) {
  const params = new URLSearchParams({
    'filters[Index][$eq]': indexVal,
    'populate[Imge][fields][0]': 'id',
    'pagination[pageSize]': '1',
  });
  const res = await fetch(`${STRAPI_URL}/api/characters?${params}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`查询 HTTP ${res.status}`);
  const data = await res.json();
  const item = (data.data || [])[0];
  if (!item) return { exists: false };
  return {
    exists: true,
    documentId: item.documentId,
    hasImage: Array.isArray(item.Imge) && item.Imge.length > 0,
  };
}

async function createRecord(record, fileIds) {
  const res = await fetch(`${STRAPI_URL}/api/characters`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { ...record, Imge: fileIds, publishedAt: new Date().toISOString() } }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`创建 HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

async function linkImages(documentId, fileIds) {
  const res = await fetch(`${STRAPI_URL}/api/characters/${documentId}`, {
    method: 'PUT',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { Imge: fileIds } }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`关联 HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// ============================================================
// 单个文件处理
// ============================================================

const cell = (arr, i) => {
  const v = arr[i];
  return v === undefined || v === null ? '' : String(v).trim();
};

async function processFile(xlsxPath, summary) {
  const prefix = path.basename(xlsxPath, path.extname(xlsxPath));
  console.log(`\n========================================`);
  console.log(`文件：${prefix}.xlsx`);
  console.log(`========================================`);

  // 1) 解压 + 解析图片锚点
  let tmpDir;
  try {
    tmpDir = extractXlsx(xlsxPath);
  } catch (e) {
    console.error(`  [中止] 解压失败：${e.message}`);
    summary.fileErrors.push(`${prefix}: 解压失败`);
    return;
  }

  try {
    const mediaDir  = path.join(tmpDir, 'xl/media');
    const relsPath  = path.join(tmpDir, 'xl/drawings/_rels/drawing1.xml.rels');
    const drawPath  = path.join(tmpDir, 'xl/drawings/drawing1.xml');
    const sheetPath = path.join(tmpDir, 'xl/worksheets/sheet1.xml');

    const ridToFile   = parseDrawingRels(relsPath);
    const { rowHeights, defaultRowHeight } = parseRowHeights(sheetPath);
    const rowHeightEmu = makeRowHeightEmu(rowHeights, defaultRowHeight);
    const { rowToImages, stats } = parseDrawing(drawPath, ridToFile, rowHeightEmu);
    console.log(`  锚点：oneCell=${stats.oneCellAnchor} twoCell=${stats.twoCellAnchor} absolute=${stats.absoluteAnchor} skipped=${stats.skipped}`);

    // 2) 读单元格值（SheetJS，第一个工作表）；Excel 行号 = 数组下标 + 1
    const wb   = XLSX.readFile(xlsxPath);
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true, defval: '' });

    // 3) 组装有效数据行（从第 2 行起，跳过表头）
    const planned = [];     // { excelRow, record, images }
    let seq = 0, skippedInvalid = 0;
    for (let r = 2; r <= rows.length; r++) {
      const arr = rows[r - 1] || [];
      const character = cell(arr, COL.character);
      const type      = cell(arr, COL.type);
      // 非数据行（字位+字种均空）静默跳过
      if (!character && !type) continue;
      // 必填缺失 → 告警跳过，不占用 seq
      if (!character || !type) {
        console.warn(`  [跳过] Excel 第 ${r} 行：必填字段缺失（字位="${character}" 字种="${type}"）`);
        skippedInvalid++;
        continue;
      }
      seq += 1;
      const record = { Index: `${prefix}-${String(seq).padStart(4, '0')}`, Character: character, Type: type };
      const searchIndex = cell(arr, COL.searchIndex);
      const symbol = cell(arr, COL.symbol);
      const usage  = cell(arr, COL.usage);
      const source = cell(arr, COL.source);
      const era    = cell(arr, COL.era);
      const note   = cell(arr, COL.note);
      if (searchIndex) record.SearchIndex = searchIndex;
      if (symbol) record.Symbol = symbol;
      if (usage)  record.Usage  = usage;
      if (source) record.Source = source;
      if (era)    record.Era    = era;
      if (note)   record.Note   = note;
      planned.push({ excelRow: r, record, images: dedupe(rowToImages[r]) });
    }

    const totalImgs = planned.reduce((s, p) => s + p.images.length, 0);
    console.log(`  有效数据行：${planned.length}（跳过无效 ${skippedInvalid}）；归属图片：${totalImgs} 张`);

    // 4) 硬约束：无图行检测（先于任何写库）
    const noImage = planned.filter(p => p.images.length === 0);
    if (noImage.length > 0) {
      const reportPath = path.resolve(process.cwd(), `import-muromachi-no-image-${prefix}.txt`);
      const lines = [
        `# ${prefix}.xlsx 无图数据行清单（共 ${noImage.length} 行）`,
        `# 生成时间：${new Date().toISOString()}`,
        `# 格式：Excel行号\t查找序号\t字位\t出处`,
        ...noImage.map(p => `${p.excelRow}\t${p.record.SearchIndex || ''}\t${p.record.Character}\t${p.record.Source || ''}`),
      ];
      fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
      console.error(`\n  [中止] 检测到 ${noImage.length} 个「有字无图」行，已写报告：${reportPath}`);
      console.error(`         按「入库必有图」硬约束，本文件不创建任何记录。请人工核对后重跑。`);
      noImage.slice(0, 10).forEach(p =>
        console.error(`           Excel第${p.excelRow}行 序号=${p.record.SearchIndex || ''} 字位=${p.record.Character}`));
      if (noImage.length > 10) console.error(`           ……另有 ${noImage.length - 10} 行见报告文件`);
      summary.fileErrors.push(`${prefix}: ${noImage.length} 无图行，已中止`);
      return;
    }
    console.log(`  ✓ 无图校验通过：全部 ${planned.length} 行均有图片`);

    if (DRY_RUN) {
      const ex = planned[0];
      console.log(`  [dry-run] 首行示例：${JSON.stringify(ex.record)} 图片=${ex.images.join(',')}`);
      console.log(`  [dry-run] 末行示例：Index=${planned[planned.length - 1].record.Index}`);
      summary.created += planned.length; // dry-run 下用 created 统计"将创建"数
      summary.files.push({ prefix, planned: planned.length, created: planned.length, linked: 0, skipped: 0, failed: 0 });
      return;
    }

    // 5) 拉取该源已上传媒体（复用，避免重跑重复上传）
    const nameToId = await fetchMediaByPrefix(prefix);
    if (Object.keys(nameToId).length) console.log(`  媒体库已存在该源图片：${Object.keys(nameToId).length} 张（将复用）`);

    // 6) 逐行：建记录 + 传图 + 关联
    console.log(`  开始写库（逐行，节流 80ms）...`);
    let created = 0, linked = 0, skipped = 0, uploaded = 0, failed = 0;
    for (let i = 0; i < planned.length; i++) {
      const { excelRow, record, images } = planned[i];
      try {
        const existing = await findByIndex(record.Index);
        if (existing.exists && existing.hasImage) { skipped++; await delay(20); continue; }

        // 收集 / 上传图片 → fileIds
        const fileIds = [];
        for (const imgFile of images) {
          const uploadName = `${prefix}-${imgFile}`;
          let id = nameToId[uploadName];
          if (!id) {
            const imgPath = path.join(mediaDir, imgFile);
            if (!fs.existsSync(imgPath)) throw new Error(`图片文件不存在: ${imgFile}`);
            id = await uploadImage(imgPath, uploadName);
            nameToId[uploadName] = id;
            uploaded++;
          }
          fileIds.push(id);
        }
        if (fileIds.length === 0) throw new Error('无可用图片 ID（不应发生）');

        if (existing.exists) {
          await linkImages(existing.documentId, fileIds);
          linked++;
        } else {
          await createRecord(record, fileIds);
          created++;
        }
      } catch (e) {
        console.error(`  [失败] ${record.Index}（Excel第${excelRow}行）：${e.message}`);
        failed++;
      }
      await delay(80);
      if ((i + 1) % 100 === 0) console.log(`    进度 ${i + 1}/${planned.length}（创建${created} 补图${linked} 跳过${skipped} 失败${failed}）`);
    }

    console.log(`  完成：创建 ${created}，补图 ${linked}，跳过 ${skipped}，新上传图片 ${uploaded}，失败 ${failed}`);
    summary.created += created;
    summary.linked  += linked;
    summary.skipped += skipped;
    summary.uploaded += uploaded;
    summary.failed  += failed;
    summary.files.push({ prefix, planned: planned.length, created, linked, skipped, failed });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ============================================================
// 主函数
// ============================================================

function resolveTargets(inputPath) {
  const abs = path.resolve(process.cwd(), inputPath);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    return fs.readdirSync(abs)
      .filter(f => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$') && !f.startsWith('.'))
      .sort()
      .map(f => path.join(abs, f));
  }
  return [abs];
}

async function main() {
  console.log('=== 室町时代材料 批量导入（信息 + 图片，单趟）===');

  if (!CLI_PATH) {
    console.error('用法：node scripts/import-muromachi.js <文件夹或xlsx路径>');
    process.exit(1);
  }

  let targets;
  try {
    targets = resolveTargets(CLI_PATH);
  } catch (e) {
    console.error(`路径无效：${e.message}`);
    process.exit(1);
  }
  if (targets.length === 0) {
    console.error('未找到任何 .xlsx 文件。');
    process.exit(1);
  }
  console.log(`待处理文件（${targets.length}）：\n  ${targets.map(t => path.basename(t)).join('\n  ')}`);

  // 连接测试（dry-run 跳过）
  if (DRY_RUN) {
    console.log('【DRY-RUN】仅解析与无图校验，不连接 Strapi、不写库。');
  } else {
    try {
      const ping = await fetch(`${STRAPI_URL}/api/characters?pagination[pageSize]=1`, { headers: HEADERS });
      if (!ping.ok) throw new Error(`HTTP ${ping.status}`);
      console.log(`Strapi 连接正常（${STRAPI_URL}）`);
    } catch (e) {
      console.error(`无法连接 Strapi：${e.message}\n请确认已 npm run dev 且 API_TOKEN 有效。`);
      process.exit(1);
    }
  }

  const summary = { created: 0, linked: 0, skipped: 0, uploaded: 0, failed: 0, files: [], fileErrors: [] };
  for (const t of targets) {
    await processFile(t, summary);
  }

  console.log(`\n================ 总汇总 ================`);
  console.log(`  成功创建：${summary.created} 条`);
  console.log(`  补传关联：${summary.linked} 条`);
  console.log(`  已跳过：  ${summary.skipped} 条（已存在且有图）`);
  console.log(`  新上传图：${summary.uploaded} 张`);
  console.log(`  失败：    ${summary.failed} 条`);
  if (summary.fileErrors.length) {
    console.log(`\n  ⚠ 被中止/出错的文件：`);
    summary.fileErrors.forEach(e => console.log(`    - ${e}`));
  }
  console.log(`\n请刷新前端 frontend/index.html 查看。`);
}

main().catch(e => {
  console.error('\n脚本执行异常：', e);
  process.exit(1);
});
