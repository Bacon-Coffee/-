❯ 我想知道 开发应该怎么开发现在

⏺ 开发流程基本没变，只是打包前多了一步。

日常开发

# 方式 1：Electron + Strapi 联合启动

npm run dev

# 方式 2：只启动 Strapi 后端

cd backend && npm run dev

两种方式都使用 backend/.tmp/data.db，和之前完全一样。

打包发布前

需要多做一步 —— 更新种子数据库：

cp backend/.tmp/data.db backend/data/seed.db
npm run dist

如果你没有新增/修改过数据（数据库没变），可以跳过 cp 直接打包。

需要注意的点

- backend/.tmp/data.db → 开发用，实时变动，不进 git
- backend/data/seed.db → 打包用快照，数据有变化时手动更新
- backend/start-production.js → 打包专用启动脚本，不要删除
- 修改了 backend/config/\*.ts 后记得 cd backend && npm run build 重新编译，打包时用的是 dist/ 里的 .js 文件
