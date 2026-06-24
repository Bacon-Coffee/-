'use strict';

/**
 * electron-builder 打包配置
 * 运行方式：npm run dist（在仓库根目录 my-repo/）
 */

module.exports = {
  appId:       'com.hanzidb.manuscript',
  productName: '日本汉文写本汉方文献用字数据库',

  // 本机 WSL 调 Windows app-builder.exe 下载 Electron 发行包时网络不稳（EOF）。
  // 预先把校验通过的 electron-v33.4.11-win32-x64.zip 放到 electron-cache/，
  // electron-builder 检测到该目录含同名 zip 即直接使用、跳过下载（见
  // app-builder-lib/out/electron/ElectronFramework.js unpack()）。
  electronDist: 'electron-cache',

  // asar 中只保留 Electron 主进程和前端页面
  files: [
    'electron/**/*',
    '!electron/dist/**',
    'frontend/index.html',
    'frontend/fonts/**/*',
    'frontend/lib/**/*',
  ],

  // 后端整体放到 extraResources（Strapi 作为子进程运行，无法读取 asar）
  // 生产模式只需 dist/（编译产物）、node_modules、public、package.json、.env
  // 不包含 config/*.ts 和 src/*.ts（源码），避免 Strapi 加载 .ts 报错
  extraResources: [
    {
      from: 'backend',
      to:   'app/backend',
      filter: [
        'dist/**/*',
        'start-production.js',
        'package.json',
        '.env',
        'public/**/*',
        'data/seed.db',
        'node_modules/**/*',
        '!node_modules/**/*.map',
        '!node_modules/**/.strapi/**',
        '!node_modules/**/.cache/**',
        '!node_modules/**/test/**',
        '!node_modules/**/tests/**',
        '!node_modules/**/__tests__/**',
        '!node_modules/**/.github/**',
        '!node_modules/**/docs/**',
        '!node_modules/**/examples/**',
      ],
    },
    // 随包内置 Windows Node 运行时（启动 Strapi 子进程用，免去用户安装 Node）
    {
      from: 'runtime',
      to:   'app/runtime',
    },
  ],

  // 后端原生模块（better-sqlite3 / sharp）已预装为 win32-x64，且由随包 runtime/node.exe
  // (ABI 137) 加载，绝不能让 electron-builder 按 Electron 的 ABI 重新编译，否则会损坏。
  // 根包无生产依赖，这里显式关闭重建以彻底避免触碰 backend/node_modules。
  npmRebuild: false,

  // 原生模块不压缩进 asar（better-sqlite3 是 C++ 扩展，必须解压可用）
  asar: true,
  asarUnpack: [
    '**/node_modules/better-sqlite3/**',
  ],

  // macOS 配置
  mac: {
    category: 'public.app-category.reference',
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
    ],
  },
  dmg: {
    title: '日本汉文写本汉方文献用字数据库',
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
    ],
  },

  // Windows 配置：NSIS 安装包（安装到本机、建快捷方式、数据持久）
  win: {
    icon: 'build/icon.ico',
    target: [
      { target: 'nsis', arch: ['x64'] },
    ],
  },
  nsis: {
    oneClick: false,                 // 显示安装向导
    perMachine: false,               // 默认按用户安装，免管理员
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: '日本汉文写本汉方文献用字数据库',
  },

  // 输出目录
  directories: {
    output: 'electron/dist',
  },

  compression: 'maximum',
};
