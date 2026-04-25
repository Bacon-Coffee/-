'use strict';

/**
 * Excel 图片全自动导入脚本
 *
 * 功能：从 Excel 内嵌图片中提取，自动上传并关联到对应 Strapi 字符记录
 * 使用：npm run import-images（在 backend/ 目录下）
 * 前置：Strapi 已启动，且文字数据已导入（npm run import）
 *
 * Strapi 5 正确关联方式：
 *   1. 上传图片 → 获得文件 ID（若媒体库已存在则直接复用）
 *   2. PUT /api/characters/:documentId { data: { Imge: [id1, id2] } }
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

// ---- 配置 ----
// 支持命令行：npm run import-images -- <path> [--fresh]
//   --fresh: 跳过媒体库按文件名复用，强制为每张图新上传（跨 Excel 防止同名图错误复用）
const argv      = process.argv.slice(2);
const FRESH     = argv.includes('--fresh');
const CLI_PATH  = argv.find(a => !a.startsWith('--'));
const EXCEL_PATH = CLI_PATH
  ? path.resolve(process.cwd(), CLI_PATH)
  : path.resolve(__dirname, '../../frontend/示例数据-種々薬帳1.xlsx');
const STRAPI_URL = process.env.STRAPI_URL   || 'http://localhost:1337';
const API_TOKEN  = process.env.STRAPI_TOKEN ||
  'c21a49ab9d05d68d493c0db6f7f8062e006ffec23ae71d9126041231f913c7ea42e991821e4ef3c4e26c33bd71c9a6bfb7fe834b6e4ebe80d36c81aa2f4ded1108e2b070e0fdf9630446d38fbe296d646e9963f0a485dbbb10619cab72978bbb4e6509883b1027f58a0f13930a1ad139b766b208b4d471473d3eac90be340b29';

const HEADERS = { Authorization: `Bearer ${API_TOKEN}` };
const delay   = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================
// 步骤 A：解析 Excel XML，建立 Index → [imageFilename] 映射
// ============================================================

function extractXlsx(xlsxPath) {
  const tmpDir = path.join(os.tmpdir(), 'strapi_img_' + Date.now());
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

// 解析 <xdr:from> / <xdr:to> 块中的 row + rowOff（EMU）
function parseFromTo(xml, tag) {
  const m = new RegExp(`<xdr:${tag}>([\\s\\S]*?)<\\/xdr:${tag}>`).exec(xml);
  if (!m) return null;
  const rowM    = /<xdr:row>(\d+)<\/xdr:row>/.exec(m[1]);
  const rowOffM = /<xdr:rowOff>(-?\d+)<\/xdr:rowOff>/.exec(m[1]);
  if (!rowM) return null;
  return {
    row:    parseInt(rowM[1]),               // 0-indexed
    rowOff: rowOffM ? parseInt(rowOffM[1]) : 0,
  };
}

// 按覆盖面积选定图片归属的 sheet row (1-indexed)
function resolveAnchorRow(from, to, rowHeightEmu) {
  // 同行直接返回（绝大多数情况）
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

// 从 oneCellAnchor 的 from + ext 推导虚拟 to
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

  // 匹配三种锚点；\1 回引保证类型匹配
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
      // oneCellAnchor / absoluteAnchor：由 ext.cy 推导
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

function parseSheetIndex(sheetPath, ssPath) {
  // 读 sharedStrings
  const ssXml = fs.readFileSync(ssPath, 'utf8');
  const strings = [];
  const siRe = /<si[^>]*>[\s\S]*?<t[^>]*>([^<]*)<\/t>[\s\S]*?<\/si>/g;
  let si;
  while ((si = siRe.exec(ssXml)) !== null) strings.push(si[1]);

  const sheetXml = fs.readFileSync(sheetPath, 'utf8');

  // sheetFormatPr defaultRowHeight（单位: point，1pt = 12700 EMU；缺省 15）
  let defaultRowHeight = 15;
  const fmt = /<sheetFormatPr[^>]*defaultRowHeight="([\d.]+)"/.exec(sheetXml);
  if (fmt) defaultRowHeight = parseFloat(fmt[1]);

  // 逐行解析：A 列 (Index) + ht 属性 (行高 point)
  const rowToIndex = {};
  const rowHeights = {};   // rowNum (1-based) -> point
  const rowRe = /<row r="(\d+)"([^>]*)>([\s\S]*?)<\/row>/g;
  let rowEl;
  while ((rowEl = rowRe.exec(sheetXml)) !== null) {
    const rowNum = parseInt(rowEl[1]);
    const attrs  = rowEl[2];
    const body   = rowEl[3];

    const htMatch = /\bht="([\d.]+)"/.exec(attrs);
    if (htMatch) rowHeights[rowNum] = parseFloat(htMatch[1]);

    const cellMatch = /<c r="A\d+" [^>]*t="s"[^>]*><v>(\d+)<\/v><\/c>/.exec(body);
    if (cellMatch) rowToIndex[rowNum] = strings[parseInt(cellMatch[1])] || '';
  }
  return { rowToIndex, rowHeights, defaultRowHeight };
}

// 行高查询工具：返回指定行的高度 (EMU)
function makeRowHeightEmu(rowHeights, defaultRowHeight) {
  const DEFAULT_EMU = defaultRowHeight * 12700;
  return (rowNum) => {
    const pt = rowHeights[rowNum];
    return pt !== undefined ? pt * 12700 : DEFAULT_EMU;
  };
}

function buildIndexToImages(rowToImages, rowToIndex) {
  const result = {};
  for (const [row, images] of Object.entries(rowToImages)) {
    const idx = rowToIndex[parseInt(row)];
    if (!idx) continue;
    const bucket = (result[idx] = result[idx] || []);
    for (const f of images) {
      if (!bucket.includes(f)) bucket.push(f);   // 去重：同锚点重复引用的图片只保留一次
    }
  }
  return result;
}

// ============================================================
// 步骤 B：从 Strapi 媒体库获取已存在的图片文件名 → ID 映射
// ============================================================
async function fetchMediaLibrary() {
  console.log('读取 Strapi 媒体库...');
  // upload files API 不支持真正的分页，直接返回全部匹配结果
  const res = await fetch(
    `${STRAPI_URL}/api/upload/files?filters[name][$startsWith]=image`,
    { headers: HEADERS }
  );
  if (!res.ok) throw new Error(`媒体库请求失败: HTTP ${res.status}`);
  const data = await res.json();
  const files = Array.isArray(data) ? data : (data.results || []);
  const nameToId = {};
  for (const f of files) {
    if (f.name) nameToId[f.name] = f.id;
  }
  console.log(`  媒体库中 image*.png 文件: ${Object.keys(nameToId).length} 张`);
  return nameToId;
}

// ============================================================
// 步骤 C：上传单张图片（若媒体库中不存在）
// ============================================================
async function uploadImage(imagePath) {
  const fileBuffer = fs.readFileSync(imagePath);
  const blob = new Blob([fileBuffer], { type: 'image/png' });
  const formData = new FormData();
  formData.append('files', blob, path.basename(imagePath));

  const res = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST',
    headers: HEADERS,   // 注意：不要手动设置 Content-Type，让 fetch 自动设置 multipart boundary
    body: formData,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const file = Array.isArray(data) ? data[0] : data;
  return file.id;
}

// ============================================================
// 步骤 D：从 Strapi 获取所有字符记录（分页）
// ============================================================
async function fetchAllCharacters() {
  console.log('获取 Strapi 字符记录...');
  const records = {};
  let page = 1;
  while (true) {
    const params = new URLSearchParams({
      'fields[0]': 'Index',
      'populate[Imge][fields][0]': 'id',
      'pagination[page]': page,
      'pagination[pageSize]': 100,
    });
    const res = await fetch(`${STRAPI_URL}/api/characters?${params}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`获取字符失败: HTTP ${res.status}`);
    const data = await res.json();
    for (const item of (data.data || [])) {
      if (item.Index && item.documentId) {
        records[item.Index] = {
          documentId: item.documentId,
          hasImage: Array.isArray(item.Imge) && item.Imge.length > 0,
        };
      }
    }
    const pg = data.meta?.pagination || {};
    if (page >= (pg.pageCount || 1)) break;
    page++;
  }
  console.log(`  共 ${Object.keys(records).length} 条字符记录`);
  return records;
}

// ============================================================
// 步骤 E：PUT 关联图片到字符记录
// ============================================================
async function linkImages(documentId, fileIds) {
  const res = await fetch(`${STRAPI_URL}/api/characters/${documentId}`, {
    method: 'PUT',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { Imge: fileIds } }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`PUT 失败 HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// ============================================================
// 主函数
// ============================================================
async function main() {
  console.log('=== 日本汉文写本汉方文献用字数据库 图片关联工具 ===\n');

  // A. 解析 Excel 建立映射
  console.log('解压并解析 Excel...');
  let tmpDir;
  try {
    tmpDir = extractXlsx(EXCEL_PATH);
  } catch (e) {
    console.error(`解压失败: ${e.message}`);
    process.exit(1);
  }

  const mediaDir  = path.join(tmpDir, 'xl/media');
  const relsPath  = path.join(tmpDir, 'xl/drawings/_rels/drawing1.xml.rels');
  const drawPath  = path.join(tmpDir, 'xl/drawings/drawing1.xml');
  const sheetPath = path.join(tmpDir, 'xl/worksheets/sheet1.xml');
  const ssPath    = path.join(tmpDir, 'xl/sharedStrings.xml');

  const ridToFile     = parseDrawingRels(relsPath);
  const { rowToIndex, rowHeights, defaultRowHeight } = parseSheetIndex(sheetPath, ssPath);
  const rowHeightEmu  = makeRowHeightEmu(rowHeights, defaultRowHeight);
  const { rowToImages, stats } = parseDrawing(drawPath, ridToFile, rowHeightEmu);
  const indexToImages = buildIndexToImages(rowToImages, rowToIndex);

  const totalRecords = Object.keys(indexToImages).length;
  const totalImgs    = Object.values(indexToImages).reduce((s, a) => s + a.length, 0);
  console.log(`  锚点解析: oneCell=${stats.oneCellAnchor}, twoCell=${stats.twoCellAnchor}, absolute=${stats.absoluteAnchor}, skipped=${stats.skipped}`);
  console.log(`  Excel 中有图片的记录: ${totalRecords} 条，共 ${totalImgs} 张\n`);

  // B. 读取媒体库（已上传的文件）
  let nameToId;
  if (FRESH) {
    console.log('--fresh 已启用：跳过媒体库复用，所有图片将作为新文件上传');
    nameToId = {};
  } else {
    try {
      nameToId = await fetchMediaLibrary();
    } catch (e) {
      console.error(`读取媒体库失败: ${e.message}\n请确认 Strapi 已启动。`);
      process.exit(1);
    }
  }

  // C. 获取字符记录
  let allRecords;
  try {
    allRecords = await fetchAllCharacters();
  } catch (e) {
    console.error(`获取字符失败: ${e.message}`);
    process.exit(1);
  }

  // D. 逐条处理：上传缺失图片 + PUT 关联
  console.log('\n开始关联图片...\n');
  let linked = 0, skipped = 0, uploaded = 0, failed = 0, notFound = 0;

  const entries = Object.entries(indexToImages);
  for (let i = 0; i < entries.length; i++) {
    const [idx, imageFiles] = entries[i];
    const record = allRecords[idx];

    if (!record) {
      console.log(`  [未找到] Index="${idx}"（请先运行 npm run import）`);
      notFound++;
      continue;
    }

    if (record.hasImage) {
      skipped++;
      continue;
    }

    // 收集该记录所有图片的文件 ID
    const fileIds = [];
    let hasError = false;

    for (const imgFile of imageFiles) {
      let fileId = nameToId[imgFile];

      if (!fileId) {
        // 媒体库中不存在，需上传
        const imgPath = path.join(mediaDir, imgFile);
        if (!fs.existsSync(imgPath)) {
          console.log(`  [警告] 图片文件不存在: ${imgFile}`);
          hasError = true;
          continue;
        }
        try {
          fileId = await uploadImage(imgPath);
          nameToId[imgFile] = fileId;  // 缓存，避免重复上传
          uploaded++;
        } catch (e) {
          console.log(`  [上传失败] ${imgFile}: ${e.message}`);
          hasError = true;
          continue;
        }
      }
      fileIds.push(fileId);
    }

    if (fileIds.length === 0) {
      failed++;
      continue;
    }

    // PUT 关联
    try {
      await linkImages(record.documentId, fileIds);
      process.stdout.write(`  [关联] Index="${idx}" → ${imageFiles.join(', ')} (id: ${fileIds.join(',')})\n`);
      linked++;
    } catch (e) {
      console.log(`  [关联失败] Index="${idx}": ${e.message}`);
      hasError = true;
      failed++;
    }

    if (hasError) failed++;

    // 避免请求过快
    await delay(50);

    // 每50条显示进度
    if ((i + 1) % 50 === 0) {
      console.log(`  --- 进度 ${i + 1}/${entries.length} ---`);
    }
  }

  // 清理临时目录
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  // 汇总
  console.log('\n=== 完成 ===');
  console.log(`  成功关联: ${linked} 条记录`);
  console.log(`  新上传:   ${uploaded} 张图片`);
  console.log(`  已跳过:   ${skipped} 条（已有图片）`);
  console.log(`  未找到:   ${notFound} 条（Strapi 中无此 Index）`);
  console.log(`  失败:     ${failed} 条`);
  console.log(`\n请刷新前端页面查看图片: frontend/index.html`);
}

main().catch(e => {
  console.error('\n脚本执行异常:', e);
  process.exit(1);
});
