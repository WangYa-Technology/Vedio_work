// 未显式指定时使用 Web 服务开发环境。
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "dev";
  console.log(`[环境变量：${process.env.NODE_ENV}]`);
}
