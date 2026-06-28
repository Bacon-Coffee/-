/**
 * admin-auth controller
 *
 * 校验前端管理后台密码；通过后返回写入令牌（来自环境变量）。
 * 密码与令牌均存于后端 .env，不写死在前端静态文件。
 */

import crypto from 'crypto';

export default {
  async login(ctx) {
    const { password } = ctx.request.body ?? {};
    const expected = process.env.ADMIN_PANEL_PASSWORD;
    const token = process.env.ADMIN_WRITE_TOKEN;

    if (!expected || !token) {
      return ctx.internalServerError('管理后台未配置（缺少 ADMIN_PANEL_PASSWORD 或 ADMIN_WRITE_TOKEN）');
    }
    if (typeof password !== 'string' || password.length === 0) {
      return ctx.badRequest('请输入密码');
    }

    // 定长安全比较，避免时序泄露
    const a = Buffer.from(password);
    const b = Buffer.from(expected);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      return ctx.unauthorized('密码错误');
    }

    ctx.body = { token };
  },
};
