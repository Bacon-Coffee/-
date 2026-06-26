'use strict';

/**
 * Electron 主进程
 *
 * 启动流程：
 * 1. 显示"正在启动后端服务"加载窗口
 * 2. 启动 Strapi 子进程（backend/）
 * 3. 轮询等待 Strapi 就绪（最长 180 秒，子进程早退则立即失败）
 * 4. 创建主窗口加载 frontend/index.html
 * 5. 应用退出时终止 Strapi 子进程
 */

const { app, BrowserWindow, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const http = require('http');

// 通过登录 shell 查找可执行文件路径（兼容 nvm / homebrew 等非标准安装）
function resolveCmd(name) {
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    return execSync(`${shell} -l -c "which ${name}"`, { encoding: 'utf8' }).trim();
  } catch {
    return name; // 回退到命令名，让系统自行查找
  }
}

// ---- 路径配置 ----
const IS_PACKAGED = app.isPackaged;

// 打包后 backend 在 extraResources (resources/app/backend/)，不在 asar 内
const BACKEND_DIR = IS_PACKAGED
  ? path.join(process.resourcesPath, 'app', 'backend')
  : path.join(__dirname, '..', 'backend');

// 前端 HTML 在 asar 内（开发时在仓库目录）
const FRONTEND_PATH = IS_PACKAGED
  ? path.join(process.resourcesPath, 'app.asar', 'frontend', 'index.html')
  : path.join(__dirname, '..', 'frontend', 'index.html');

const STRAPI_PORT = 1337;
// 健康检查直连 127.0.0.1，与 backend/.env 的 HOST=127.0.0.1 对齐。
// 用 localhost 在 Windows 上可能先解析到 IPv6 ::1，而 Strapi 只监听 IPv4，
// 会造成健康检查偶发首连失败、白白耗尽超时窗口。
const STRAPI_HOST = '127.0.0.1';
const STRAPI_URL  = `http://${STRAPI_HOST}:${STRAPI_PORT}`;

let strapiProcess = null;
let mainWindow    = null;
// 缓存 Strapi 子进程最近的输出，启动失败时回显真实原因（而非误导性的"未装依赖"）
let strapiLog     = '';
// 标记 Strapi 子进程是否在"就绪"前已退出，供 waitForStrapi 快速失败用
let strapiExited  = false;

// ---- 启动日志落盘 ----
// 把编排信息与 Strapi 子进程输出统一写到 userData/startup.log，
// 这样即便打包后界面只显示一个错误框，也能事后拿到真实报错栈。
function getLogPath() {
  return path.join(app.getPath('userData'), 'startup.log');
}

function writeLog(line) {
  // 去掉 Strapi 彩色输出的 ANSI 转义码，避免日志/错误框出现乱码
  const clean = String(line).replace(/\x1b\[[0-9;]*m/g, '');
  const stamped = `[${new Date().toISOString()}] ${clean}\n`;
  // 同步追加，避免崩溃/退出时丢日志
  try {
    fs.mkdirSync(path.dirname(getLogPath()), { recursive: true });
    fs.appendFileSync(getLogPath(), stamped);
  } catch { /* 日志写失败不应影响主流程 */ }
  // 同时进内存缓冲，错误对话框直接回显尾部
  strapiLog = (strapiLog + stamped).slice(-4000);
}

// ---- 首次启动时复制种子数据库 ----
// 注意：Strapi 的 database.js 用 path.join() 而非 path.resolve() 拼接路径，
// 绝对路径会被当成相对路径。因此直接复制到 backend/.tmp/data.db（默认位置）。
// 打包后数据库放在可写的用户数据目录（NSIS 安装目录 Program Files 只读，Strapi 需写库）
function getUserDbPath() {
  return path.join(app.getPath('userData'), 'data.db');
}

function ensureDatabase() {
  if (!IS_PACKAGED) return; // 开发模式使用 backend/.tmp/data.db
  const dbPath = getUserDbPath();
  if (fs.existsSync(dbPath)) {
    console.log('[Electron] 数据库已存在:', dbPath);
    return;
  }
  const seedDb = path.join(BACKEND_DIR, 'data', 'seed.db');
  if (fs.existsSync(seedDb)) {
    console.log('[Electron] 首次启动，复制种子数据库...');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.copyFileSync(seedDb, dbPath);
    console.log('[Electron] 数据库已复制到:', dbPath);
  } else {
    console.warn('[Electron] 种子数据库不存在:', seedDb);
  }
}

// ---- 打包产物预检 ----
// 打包后逐项检查 Strapi 启动必需的文件是否都进了包。任一缺失说明是"打包遗漏"
// 而非运行时问题，直接报出具体缺哪个文件，取代误导性的"请检查后端依赖"。
// 返回缺失项数组（为空表示齐全）。
function preflightCheck() {
  if (!IS_PACKAGED) return [];
  const required = {
    '内置 Node 运行时 (runtime/node.exe)':
      path.join(process.resourcesPath, 'app', 'runtime', 'node.exe'),
    '后端编译产物 (backend/dist)':
      path.join(BACKEND_DIR, 'dist'),
    '后端环境变量 (backend/.env)':
      path.join(BACKEND_DIR, '.env'),
    '种子数据库 (backend/data/seed.db)':
      path.join(BACKEND_DIR, 'data', 'seed.db'),
    'SQLite 原生模块 (better_sqlite3.node)':
      path.join(BACKEND_DIR, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
  };
  const missing = [];
  for (const [label, p] of Object.entries(required)) {
    const ok = fs.existsSync(p);
    writeLog(`[预检] ${ok ? 'OK  ' : '缺失'} ${label} -> ${p}`);
    if (!ok) missing.push(label);
  }
  return missing;
}

// ---- 启动 Strapi 子进程 ----
function startStrapi() {
  strapiExited = false;

  // 打包后用随包内置的 Windows Node（无需用户机器安装 Node）；开发模式用系统 Node
  const nodeCmd = IS_PACKAGED
    ? path.join(process.resourcesPath, 'app', 'runtime', 'node.exe')
    : (process.platform === 'win32' ? 'node.exe' : resolveCmd('node'));
  // 打包后使用 start-production.js（跳过 TS 检测），开发模式用 strapi CLI
  const startScript = IS_PACKAGED
    ? path.join(BACKEND_DIR, 'start-production.js')
    : path.join(BACKEND_DIR, 'node_modules', '@strapi', 'strapi', 'bin', 'strapi.js');
  const startArgs = IS_PACKAGED ? [startScript] : [startScript, 'start'];

  writeLog(`[Electron] 正在启动 Strapi... cwd=${BACKEND_DIR}`);
  writeLog(`[Electron] node 路径: ${nodeCmd}`);
  writeLog(`[Electron] 启动脚本: ${startScript}`);

  strapiProcess = spawn(nodeCmd, startArgs, {
    cwd: BACKEND_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      // 打包后把数据库指向可写的 userData 目录（绝对路径，database.ts 已支持）
      ...(IS_PACKAGED ? { DATABASE_FILENAME: getUserDbPath() } : {}),
    },
  });

  strapiProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) { console.log('[Strapi]', msg); writeLog('[Strapi] ' + msg); }
  });

  strapiProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) { console.error('[Strapi ERR]', msg); writeLog('[Strapi ERR] ' + msg); }
  });

  strapiProcess.on('error', (err) => {
    console.error('[Strapi] 子进程启动失败:', err.message);
    writeLog('[Strapi] 子进程启动失败: ' + err.message);
    strapiExited = true;
  });

  strapiProcess.on('exit', (code, signal) => {
    writeLog(`[Strapi] 进程退出 code=${code} signal=${signal}`);
    strapiExited = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox('后端服务异常退出', '请重启应用。');
    }
  });
}

// ---- 轮询等待 Strapi 就绪 ----
function waitForStrapi(maxWaitMs = 90000, intervalMs = 1000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      http.get(`${STRAPI_URL}/api/characters?pagination[pageSize]=1`, (res) => {
        // 任意非 5xx 响应（包括 401/403）说明服务已启动
        if (res.statusCode < 500) {
          resolve();
        } else {
          retry();
        }
      }).on('error', retry);
    };
    const retry = () => {
      // 子进程已在就绪前退出/启动失败 → 立即失败，不必傻等满超时窗口
      if (strapiExited) {
        reject(new Error('Strapi 子进程在就绪前已退出（详见 startup.log）'));
      } else if (Date.now() - start >= maxWaitMs) {
        reject(new Error(`Strapi 在 ${maxWaitMs / 1000} 秒内未能启动`));
      } else {
        setTimeout(check, intervalMs);
      }
    };
    check();
  });
}

// ---- 创建主窗口 ----
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: '日本汉文写本汉方文献用字数据库',
    webPreferences: {
      // file:// 协议需要跨域访问 localhost:1337
      webSecurity: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(FRONTEND_PATH);

  // 开发模式打开 DevTools
  if (!IS_PACKAGED) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---- 应用生命周期 ----
app.whenReady().then(async () => {
  // 加载中窗口
  const loadingWin = new BrowserWindow({
    width: 420,
    height: 200,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false },
  });
  loadingWin.loadURL(`data:text/html;charset=utf-8,
    <html><body style="margin:0;background:%23fdfaf2;display:flex;flex-direction:column;
    align-items:center;justify-content:center;height:100vh;font-family:serif;color:%237f1d1d">
    <p style="font-size:1.4em;font-weight:bold">✒️ 日本汉文写本汉方文献用字数据库</p>
    <p style="color:%2378716c;font-size:0.9em">正在启动后端服务，请稍候...</p>
    </body></html>`
  );

  // 每次启动开新日志，便于定位本次问题
  try { fs.writeFileSync(getLogPath(), ''); } catch { /* ignore */ }
  writeLog(`[Electron] 应用启动，IS_PACKAGED=${IS_PACKAGED}`);

  // 打包产物预检：若必需文件缺失，直接报出具体项（取代误导性的"检查依赖"）
  const missing = preflightCheck();
  if (missing.length) {
    loadingWin.close();
    dialog.showErrorBox(
      '安装包文件缺失',
      `检测到以下打包必需文件缺失，应用无法启动：\n\n- ${missing.join('\n- ')}\n\n` +
      `这是打包遗漏，请重新打包。\n日志：${getLogPath()}`
    );
    app.quit();
    return;
  }

  ensureDatabase();
  startStrapi();

  try {
    // Strapi 5 冷启动较重，叠加杀软首次扫描 node_modules，首启可能数十秒到 2 分钟，
    // 故超时放宽到 180s，避免误判为启动失败。
    await waitForStrapi(180000);
    loadingWin.close();
    createWindow();
  } catch (e) {
    loadingWin.close();
    // 回显 Strapi 真实输出，而非误导性的"未装依赖"提示
    const detail = strapiLog.trim()
      ? `\n\n后端最近输出：\n${strapiLog.trim()}`
      : '\n\n（后端无任何输出，可能是内置 Node 运行时或原生模块无法加载）';
    dialog.showErrorBox('后端服务启动超时', `${e.message}\n\n日志：${getLogPath()}${detail}`);
    app.quit();
  }
});

// ---- 退出时清理 Strapi ----
app.on('window-all-closed', () => {
  if (strapiProcess) {
    console.log('[Electron] 正在关闭 Strapi...');
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(strapiProcess.pid), '/f', '/t']);
    } else {
      strapiProcess.kill('SIGTERM');
    }
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
