'use strict';

/**
 * 生产模式启动脚本（供 Electron 打包后使用）
 * 直接调用 Strapi core API，跳过 TypeScript 工具链检测
 */

const path = require('path');

// 确保从 appDir 加载 .env（dotenv 默认从 process.cwd() 读取）
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { createStrapi } = require('@strapi/core');

const appDir = __dirname;
const distDir = path.join(appDir, 'dist');

createStrapi({ appDir, distDir }).start();
