// import type { Core } from '@strapi/strapi';

/**
 * 幂等地为 public 角色开启指定 action 的访问权限。
 * 打包后的桌面软件前端免 token 直接读取 characters。
 */
async function ensurePublicPermissions(strapi: any, actions: string[]) {
  const publicRole = await strapi
    .query('plugin::users-permissions.role')
    .findOne({ where: { type: 'public' } });
  if (!publicRole) return;

  for (const action of actions) {
    const existing = await strapi
      .query('plugin::users-permissions.permission')
      .findOne({ where: { action, role: publicRole.id } });
    if (!existing) {
      await strapi
        .query('plugin::users-permissions.permission')
        .create({ data: { action, role: publicRole.id } });
      strapi.log.info(`[bootstrap] 已为 public 角色开启权限: ${action}`);
    }
  }
}

/**
 * 幂等地撤销 public 角色对指定 action 的访问权限。
 * 用于确保「未携带令牌」的请求无法写入——增删改必须经管理后台密码登录取得的令牌。
 */
async function revokePublicPermissions(strapi: any, actions: string[]) {
  const publicRole = await strapi
    .query('plugin::users-permissions.role')
    .findOne({ where: { type: 'public' } });
  if (!publicRole) return;

  for (const action of actions) {
    const existing = await strapi
      .query('plugin::users-permissions.permission')
      .findOne({ where: { action, role: publicRole.id } });
    if (existing) {
      await strapi
        .query('plugin::users-permissions.permission')
        .delete({ where: { id: existing.id } });
      strapi.log.info(`[bootstrap] 已撤销 public 角色权限: ${action}`);
    }
  }
}

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }: { strapi: any }) {
    await ensurePublicPermissions(strapi, [
      'api::character.character.find',
      'api::character.character.findOne',
    ]);
    // 撤销 public 角色的写权限：增删改、图片上传均必须携带管理后台令牌（密码登录后获取）
    await revokePublicPermissions(strapi, [
      'api::character.character.create',
      'api::character.character.update',
      'api::character.character.delete',
      'plugin::upload.content-api.upload',
    ]);
  },
};
