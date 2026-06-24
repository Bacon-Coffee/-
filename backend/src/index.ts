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
  },
};
