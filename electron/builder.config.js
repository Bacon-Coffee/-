'use strict';

/**
 * electron-builder 打包配置
 * 运行方式：npm run dist（在仓库根目录 my-repo/）
 */

module.exports = {
  appId:       'com.hanzidb.manuscript',
  productName: '日本汉文写本汉方文献用字数据库',

  // 打包时包含的文件（相对于根目录 my-repo/）
  files: [
    'electron/**/*',
    'frontend/index.html',
    'backend/dist/**/*',
    'backend/config/**/*',
    'backend/src/**/*',
    'backend/package.json',
    'backend/.env',
  ],

  // 额外资源（不走 asar 压缩，保留目录结构）
  extraResources: [
    {
      from: 'backend/node_modules',
      to:   'app/backend/node_modules',
      filter: [
        '**/*',
        '!**/*.map',
        '!**/.strapi/**',
        '!**/.cache/**',
        '!**/test/**',
        '!**/tests/**',
        '!**/__tests__/**',
        '!**/.github/**',
        '!**/docs/**',
        '!**/examples/**',
      ],
    },
    {
      from: 'backend/public',
      to:   'app/backend/public',
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
