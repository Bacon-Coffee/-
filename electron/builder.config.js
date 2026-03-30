'use strict';

/**
 * electron-builder 打包配置
 * 运行方式：npm run dist（在仓库根目录 my-repo/）
 */

module.exports = {
  appId:       'com.hanzidb.manuscript',
  productName: '日本汉文写本汉方文献用字数据库',

  // asar 中只保留 Electron 主进程和前端页面
  files: [
    'electron/**/*',
    '!electron/dist/**',
    'frontend/index.html',
    'frontend/fonts/**/*',
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
  ],

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

  // Windows 配置（portable 无需 Wine 即可在 macOS 上交叉编译）
  win: {
    target: [
      { target: 'portable', arch: ['x64'] },
    ],
  },

  // 输出目录
  directories: {
    output: 'electron/dist',
  },

  compression: 'maximum',
};
