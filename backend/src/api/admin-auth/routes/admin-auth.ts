/**
 * admin-auth router
 *
 * 提供前端管理后台的密码登录接口。
 * config.auth=false：校验密码这一步本身无需令牌（公开可访问）。
 */

export default {
  routes: [
    {
      method: 'POST',
      path: '/admin-auth/login', // → POST /api/admin-auth/login
      handler: 'admin-auth.login',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
