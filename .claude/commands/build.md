构建 Electron 桌面安装包（macOS .dmg / Windows .exe）。

**第一步：构建 Strapi 管理后台**
```bash
cd backend && npm run build
```

**第二步：打包 Electron 安装包**
```bash
cd .. && npm run dist
```

输出文件位于 `electron/dist/` 目录：
- macOS：`*.dmg`（同时支持 Intel x64 和 Apple Silicon arm64）
- Windows：`*.exe`（便携版，无需安装）

**首次构建前请确认：**
- 已在根目录安装依赖：`npm install`
- 已在 `backend/` 安装依赖：`cd backend && npm install`
