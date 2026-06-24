export default () => ({
  // 前端只用原图 URL，不需要响应式缩略图；关闭可大幅加快批量导入并减小体积
  upload: {
    config: {
      breakpoints: {},
    },
  },
});
