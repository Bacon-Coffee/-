# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此仓库中工作时的使用指引。

## 项目简介

本项目为**日本汉文写本汉方文献用字数据库**，由以下部分组成：

- **`backend/`** — Strapi 5 CMS 后端（Node.js、TypeScript、SQLite）
- **`frontend/`** — 前端界面（原生 Vue 3 单 HTML 文件，无需构建）
- **`electron/`** — Electron 桌面打包层

最终成品为可交付给甲方验收的桌面软件，数据量预计 8000～10000 条字符记录。

## 常用命令

### 后端（在 `backend/` 目录下执行）

```bash
cd backend

npm run dev        # 开发模式启动（文件监听 + 自动重载）
npm run start      # 生产模式启动
npm run build      # 构建管理后台
npm run import     # 从 Excel 批量导入字符数据（需先启动 Strapi）
npm run import-images  # 从 Excel 内嵌图片批量导入并关联（需先启动 Strapi）
```

### 前端

直接用浏览器打开 `frontend/index.html`，无需构建步骤。

### 桌面软件（在仓库根目录 `my-repo/` 执行）

```bash
npm install        # 首次安装 Electron 依赖
npm run dev        # 开发模式：同时启动 Strapi + Electron 窗口
npm run dist       # 打包成安装包（macOS .dmg / Windows .exe）
```

### 自定义 Claude 指令

- `/dev` — 启动 Strapi 开发服务器
- `/import-excel` — 运行 Excel 导入脚本
- `/build` — 构建 Electron 安装包

## 架构说明

### 后端：Strapi 5 CMS（`backend/`）

- **数据库：** SQLite（`.tmp/data.db`），配置文件：`config/database.ts`
- **端口：** 1337（配置文件：`config/server.ts`）
- **API 基础地址：** `http://localhost:1337/api`
- **唯一内容类型：** `character`，定义于 `src/api/character/content-types/character/schema.json`
- **控制器/路由/服务：** 均使用 Strapi 默认工厂函数，暂无自定义逻辑
- **管理后台：** `http://localhost:1337/admin`

#### 字符（Character）字段说明

| 字段      | 类型            | 备注                                |
| --------- | --------------- | ----------------------------------- |
| Index     | string          | 必填，唯一标识符                    |
| Imge      | media（多文件） | 必填 — 字段名有拼写错误，非 "Image" |
| Character | string          | 必填，字位                          |
| Type      | string          | 必填，字种                          |
| Symbol    | string          | 可选，语符                          |
| Source    | string          | 可选，文献出处                      |
| Era       | string          | 可选，时代                          |
| Usage     | string          | 可选，用法                          |

#### 环境变量

将 `backend/.env.example` 复制为 `.env` 并填写：
`HOST`、`PORT`、`APP_KEYS`、`API_TOKEN_SALT`、`ADMIN_JWT_SECRET`、`TRANSFER_TOKEN_SALT`、`JWT_SECRET`、`ENCRYPTION_KEY`

#### API 分页配置（`config/api.ts`）

- `defaultLimit: 25`（每页默认条数）
- `maxLimit: 100`（每页最大条数）

### 前端：Vue 3 SPA（`frontend/`）

- `index.html` — 主应用，通过 Bearer Token 访问 `http://localhost:1337/api/characters`
- `示例数据-種々薬帳1.xlsx` — 示例数据文件（用于 Excel 导入 demo）

#### 服务端检索参数（前端通过 Strapi REST API 过滤）

- `filters[Type][$contains]=值` — 按字种过滤
- `filters[Character][$contains]=值` — 按字位过滤
- `filters[Symbol][$contains]=值` — 按语符过滤
- `filters[Era][$contains]=值` — 按时代过滤
- `pagination[page]=1&pagination[pageSize]=20` — 分页（多字段同时填写为 AND 逻辑）

API Token 在 `frontend/index.html` 中硬编码，轮换 Token 时需更新该文件。

### 桌面打包：Electron（`electron/`）

- `electron/main.js` — 主进程：将 Strapi 作为子进程启动，轮询就绪后打开主窗口加载前端 HTML
- `electron/builder.config.js` — electron-builder 配置，生成 macOS `.dmg` 和 Windows `.exe`
- 根目录 `package.json` — 协调 Electron 与 Strapi 联合构建/启动

打包后 SQLite 数据库路径自动切换到系统用户数据目录（`app.getPath('userData')/data.db`），通过 `DATABASE_FILENAME` 环境变量注入。

### Excel 数据导入（`backend/scripts/`）

- `scripts/import-excel.js` — 解析 `frontend/示例数据-種々薬帳1.xlsx`，通过 REST API 批量写入 Strapi
- `scripts/import-images.js` — 从同一 Excel 内嵌图片中提取，自动上传并关联到 Strapi 字符记录
- Excel 列名与 Strapi 字段的映射在脚本顶部的 `COLUMN_MAP` 中配置
- 两个脚本均幂等：已存在的记录/图片会跳过，可安全重复运行

## 重要注意事项

- `Imge` 字段名为原始 schema 中的拼写错误，**不要在未迁移现有数据前擅自重命名**
- Strapi 项目体积约 816 MB（含 node_modules）；前端极小（约 3.9 MB）
- SQLite 不支持高并发写入，Excel 导入脚本采用串行逐批写入（10条/批），避免 `SQLITE_BUSY` 错误
- Strapi 5 的 `draftAndPublish` 默认开启，新建记录需传 `publishedAt` 字段才能在 API 中被检索到
- 数据库支持切换为 MySQL/PostgreSQL，相关配置已在 `config/database.ts` 中注释保留
