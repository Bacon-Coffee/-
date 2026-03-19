'use strict';

/**
 * Electron 主进程
 *
 * 启动流程：
 * 1. 显示"正在启动后端服务"加载窗口
 * 2. 启动 Strapi 子进程（backend/）
 * 3. 轮询等待 Strapi 就绪（最长 90 秒）
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
const STRAPI_URL  = `http://localhost:${STRAPI_PORT}`;

let strapiProcess = null;
let mainWindow    = null;

// ---- 首次启动时复制种子数据库 ----
// 注意：Strapi 的 database.js 用 path.join() 而非 path.resolve() 拼接路径，
// 绝对路径会被当成相对路径。因此直接复制到 backend/.tmp/data.db（默认位置）。
function ensureDatabase() {
  if (!IS_PACKAGED) return; // 开发模式使用 backend/.tmp/data.db
  const dbPath = path.join(BACKEND_DIR, '.tmp', 'data.db');
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

// ---- 启动 Strapi 子进程 ----
function startStrapi() {
  console.log('[Electron] 正在启动 Strapi...', BACKEND_DIR);

  const nodeCmd = process.platform === 'win32' ? 'node.exe' : resolveCmd('node');
  // 打包后使用 start-production.js（跳过 TS 检测），开发模式用 strapi CLI
  const startScript = IS_PACKAGED
    ? path.join(BACKEND_DIR, 'start-production.js')
    : path.join(BACKEND_DIR, 'node_modules', '@strapi', 'strapi', 'bin', 'strapi.js');
  const startArgs = IS_PACKAGED ? [startScript] : [startScript, 'start'];
  console.log('[Electron] node 路径:', nodeCmd);
  console.log('[Electron] 启动脚本:', startScript);

  strapiProcess = spawn(nodeCmd, startArgs, {
    cwd: BACKEND_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
  });

  strapiProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.log('[Strapi]', msg);
  });

  strapiProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.error('[Strapi ERR]', msg);
  });

  strapiProcess.on('exit', (code, signal) => {
    console.log(`[Strapi] 进程退出 code=${code} signal=${signal}`);
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
      if (Date.now() - start >= maxWaitMs) {
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

  ensureDatabase();
  startStrapi();

  try {
    await waitForStrapi(90000);
    loadingWin.close();
    createWindow();
  } catch (e) {
    loadingWin.close();
    dialog.showErrorBox('启动失败', e.message + '\n\n请确认 backend 依赖已安装（npm install）。');
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
