const { strapi } = require("@strapi/client");

// 1. 初始化客户端
const client = strapi({
  baseURL: "http://localhost:1337/api",
  auth: "c21a49ab9d05d68d493c0db6f7f8062e006ffec23ae71d9126041231f913c7ea42e991821e4ef3c4e26c33bd71c9a6bfb7fe834b6e4ebe80d36c81aa2f4ded1108e2b070e0fdf9630446d38fbe296d646e9963f0a485dbbb10619cab72978bbb4e6509883b1027f58a0f13930a1ad139b766b208b4d471473d3eac90be340b29", // 确保这里是你完整的 Token
});

// 2. 编写测试函数
async function testConnection() {
  console.log("🚀 正在尝试连接 Strapi...");
  try {
    // 使用你刚学到的 collection('名').find() 语法
    const response = await client.collection("characters").find({
      query: { populate: "*" }, // 必须带上这个，才能看到图片
    });

    console.log("✅ 连接成功！拿到数据如下：");
    // 使用 JSON.stringify 让打印出的数据格式更好看
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error("❌ 测试失败！原因：", error.message);
    if (error.status === 401) console.log("提示：Token 可能无效或已过期。");
    if (error.status === 403)
      console.log("提示：Token 权限不足，请在后台检查。");
  }
}

// 3. 执行测试
testConnection();
