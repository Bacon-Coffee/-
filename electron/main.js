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
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

// ---- 路径配置 ----
const IS_PACKAGED = app.isPackaged;

const REPO_ROOT = IS_PACKAGED
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

const STRAPI_DIR    = path.join(REPO_ROOT, 'backend');
const FRONTEND_PATH = path.join(REPO_ROOT, 'frontend', 'index.html');
const STRAPI_PORT   = 1337;
const STRAPI_URL    = `http://localhost:${STRAPI_PORT}`;

let strapiProcess = null;
let mainWindow    = null;

// ---- 启动 Strapi 子进程 ----
function startStrapi() {
  console.log('[Electron] 正在启动 Strapi...', STRAPI_DIR);
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  strapiProcess = spawn(npmCmd, ['run', 'start'], {
    cwd: STRAPI_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      // 打包后将数据库存入用户数据目录（可写）
      DATABASE_FILENAME: IS_PACKAGED
        ? path.join(app.getPath('userData'), 'data.db')
        : path.join(STRAPI_DIR, '.tmp', 'data.db'),
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
