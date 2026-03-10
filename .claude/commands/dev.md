启动 Strapi 开发服务器（后端 API，端口 1337）：

```bash
cd my-strapi-project && npm run dev
```

服务启动后：
- API 地址：http://localhost:1337/api
- 管理后台：http://localhost:1337/admin
- 前端：直接用浏览器打开 strapi-project/index.html

如果遇到端口占用，运行：`lsof -ti:1337 | xargs kill -9`
