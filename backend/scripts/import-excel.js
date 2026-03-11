'use strict';

/**
 * Excel 数据导入脚本
 * 使用方式（在 backend/ 目录下）：npm run import
 *
 * 前置条件：Strapi 服务已启动（npm run dev 或 npm run start）
 * 注意：图片（Imge 字段）不在此脚本处理范围，需在 Strapi 管理后台手动上传关联。
 */

const path = require('path');
const XLSX = require('xlsx');

// ---- 配置区域 ----
const EXCEL_PATH = path.resolve(
  __dirname,
  '../../frontend/示例数据-種々薬帳1.xlsx'
);
const STRAPI_URL = process.env.STRAPI_URL || 'http://localhost:1337';
const API_TOKEN  = process.env.STRAPI_TOKEN ||
  'c21a49ab9d05d68d493c0db6f7f8062e006ffec23ae71d9126041231f913c7ea42e991821e4ef3c4e26c33bd71c9a6bfb7fe834b6e4ebe80d36c81aa2f4ded1108e2b070e0fdf9630446d38fbe296d646e9963f0a485dbbb10619cab72978bbb4e6509883b1027f58a0f13930a1ad139b766b208b4d471473d3eac90be340b29';

// 每批次记录数（串行写入，避免 SQLite BUSY 错误）
const BATCH_SIZE = 10;

// Excel 列名 → Strapi 字段映射
// 如首次运行后列名不匹配，根据日志中"检测到的列名"调整左侧 key
const COLUMN_MAP = {
  '序号': 'Index',     // 必填，唯一标识
  '字位': 'Character', // 必填
  '字种': 'Type',      // 必填
  '语符': 'Symbol',      // 可选
  '出处': 'Source',      // 可选
  '时代': 'Era',         // 可选
  '使用属性': 'Usage',   // 可选（Excel 列名为"使用属性"）
};

// ---- 工具函数 ----

function readExcel(filePath) {
  console.log(`正在读取 Excel 文件：${filePath}`);
  const workbook  = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const rows      = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
  console.log(`共读取到 ${rows.length} 行数据（工作表：${sheetName}）`);
  return rows;
}

function mapRow(rawRow) {
  const record = {};
  for (const [excelCol, strapiField] of Object.entries(COLUMN_MAP)) {
    const val = rawRow[excelCol];
    if (val !== undefined && val !== '') {
      record[strapiField] = String(val).trim();
    }
  }
  return record;
}

function isValid(record, rowIndex) {
  const required = ['Index', 'Character', 'Type'];
  for (const field of required) {
    if (!record[field]) {
      console.warn(`  [跳过] 第 ${rowIndex + 2} 行：必填字段 "${field}" 为空`);
      return false;
    }
  }
  return true;
}

async function createRecord(record) {
  // 先检查 Index 是否已存在（幂等）
  const checkUrl = `${STRAPI_URL}/api/characters?filters[Index][$eq]=${encodeURIComponent(record.Index)}&pagination[pageSize]=1`;
  const checkRes = await fetch(checkUrl, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  const checkData = await checkRes.json();
  if (checkData.meta?.pagination?.total > 0) {
    return { skipped: true, index: record.Index };
  }

  // 创建并直接发布（publishedAt 绕过 draftAndPublish）
  const createRes = await fetch(`${STRAPI_URL}/api/characters`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: { ...record, publishedAt: new Date().toISOString() },
    }),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`HTTP ${createRes.status}: ${errText}`);
  }
  return { skipped: false, index: record.Index };
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ---- 主函数 ----
async function main() {
  console.log('=== 汉字数据库 Excel 导入工具 ===\n');

  // 1. 读取 Excel
  let rawRows;
  try {
    rawRows = readExcel(EXCEL_PATH);
  } catch (e) {
    console.error(`无法读取 Excel 文件：${e.message}`);
    console.error(`请确认文件路径：${EXCEL_PATH}`);
    process.exit(1);
  }

  if (rawRows.length === 0) {
    console.log('Excel 文件中没有数据行，退出。');
    return;
  }

  // 2. 显示列名，方便调整 COLUMN_MAP
  const colNames   = Object.keys(rawRows[0]);
  const mappedCols = Object.keys(COLUMN_MAP);
  const unmapped   = colNames.filter(c => !mappedCols.includes(c));
  console.log(`检测到的列名：${colNames.join('、')}`);
  if (unmapped.length) {
    console.warn(`以下列未映射（将被忽略）：${unmapped.join('、')}`);
    console.warn('如需导入，请在脚本 COLUMN_MAP 中添加对应映射。\n');
  }

  // 3. 映射并校验
  const records = [];
  rawRows.forEach((row, i) => {
    const record = mapRow(row);
    if (isValid(record, i)) records.push(record);
  });
  console.log(`\n有效记录数：${records.length} / ${rawRows.length}\n`);

  if (records.length === 0) {
    console.log('没有可导入的有效记录，退出。');
    return;
  }

  // 4. 测试 Strapi 连接
  try {
    const pingRes = await fetch(`${STRAPI_URL}/api/characters?pagination[pageSize]=1`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    if (!pingRes.ok) throw new Error(`HTTP ${pingRes.status}`);
    console.log(`Strapi 连接正常（${STRAPI_URL}）\n`);
  } catch (e) {
    console.error(`无法连接 Strapi：${e.message}`);
    console.error('请确认 Strapi 已启动（npm run dev）并且 API_TOKEN 有效。');
    process.exit(1);
  }

  // 5. 分批串行导入
  let created = 0, skipped = 0, failed = 0;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch      = records.slice(i, i + BATCH_SIZE);
    const batchNum   = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatch = Math.ceil(records.length / BATCH_SIZE);
    console.log(`处理第 ${batchNum}/${totalBatch} 批（${batch.length} 条）...`);

    for (const record of batch) {
      try {
        const result = await createRecord(record);
        if (result.skipped) {
          console.log(`  [跳过] Index="${result.index}"（已存在）`);
          skipped++;
        } else {
          console.log(`  [创建] Index="${result.index}"`);
          created++;
        }
      } catch (e) {
        console.error(`  [失败] Index="${record.Index}"：${e.message}`);
        failed++;
      }
    }

    if (i + BATCH_SIZE < records.length) await delay(200);
  }

  // 6. 汇总报告
  console.log('\n=== 导入完成 ===');
  console.log(`  成功创建：${created} 条`);
  console.log(`  已跳过：  ${skipped} 条（Index 重复）`);
  console.log(`  失败：    ${failed} 条`);
  console.log('\n提示：图片（Imge 字段）需在 Strapi 管理后台手动关联。');
  console.log(`管理后台地址：${STRAPI_URL}/admin`);
}

main().catch(e => {
  console.error('脚本执行异常：', e);
  process.exit(1);
});
