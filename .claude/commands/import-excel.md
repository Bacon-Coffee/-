从示例 Excel 文件批量导入字符数据到 Strapi。

**前置条件：** Strapi 服务已在 1337 端口运行（先执行 `/dev`）

```bash
cd my-strapi-project && npm run import
```

脚本读取 `strapi-project/示例数据-種々薬帳1.xlsx`，解析所有行并通过 REST API 写入数据库。

**注意事项：**
1. 脚本幂等，可重复运行，Index 已存在的记录会自动跳过
2. 首次运行后若报"列名不匹配"，查看日志中的"检测到的列名"，在脚本顶部的 `COLUMN_MAP` 中调整映射
3. 图片字段（Imge）不在此脚本处理范围，需在管理后台手动上传并关联
4. 导入完成后在管理后台确认：http://localhost:1337/admin
