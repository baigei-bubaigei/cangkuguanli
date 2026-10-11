# 正式系统采用 React＋Vite、Next.js／Node.js 与 PostgreSQL

日期：2026-10-11。

## 状态

用户已明确技术栈、PostgreSQL 选择及 Monorepo 代码组织方式。本 ADR 记录正式系统的技术方向与应用边界，本次只编写规格，没有创建正式应用或迁移数据库。

## 背景

目前已有可双击打开的原生 HTML、CSS、JavaScript Demo。用户指定正式前端使用 React、后端使用 Next.js／Node.js、以 Vite 为基座、数据库使用 PostgreSQL；前端页面以当前纯静态 Demo 为准。

## 决定

- 当前 Demo 继续作为独立的纯静态界面依据，保留不依赖服务的查看方式。
- 正式前端在 `apps/admin`、`apps/employee` 分别采用 React＋Vite，复现 Demo 的两套系统入口、导航、布局、字段与交互；管理员和员工是两个独立前端应用。
- 正式后端在 `apps/api` 采用 Next.js，在 Node.js 上提供 HTTP API，执行真实认证、权限、库存业务校验、事务与日志保存。
- Vite 承担前端开发及构建；Next.js 后端采用自身构建与运行流程，不把两个构建器合成一个构建链。
- PostgreSQL 保存共享数据；数据库集成及并发验收也使用 PostgreSQL。用户最新选择已明确，本轮不实施 SQLite 分支。
- 正式代码必须采用同一 Git 仓库内的 Monorepo：两个前端、一个共用后端。沿用 npm workspaces 管理 `apps/*` 和按需建立的 `packages/*`，三个应用各自构建。
- 两端可复用通用展示组件和接口契约，但保留独立登录、会话校验和功能导航；后端共用业务模块及一套 PostgreSQL 数据，数据库迁移集中在 `apps/api/db/migrations`。
- 前后端可通过统一外部入口提供访问，但浏览器只能通过后端接口访问数据。`prototype` 和双击 HTML 保持静态页面基准用途，不迁移成正式应用。

## 影响

前端技术改变不等于重新设计页面。Demo 的模拟账号、内存数据与假导入不能成为正式实现；正式系统需要 Node.js 后端及 PostgreSQL 服务，双击文件仅用于 Demo 查看。数据库版本、ORM、部署方式、费用及备份频率尚未确定。

这是根据用户组合选型形成的应用拆分，后续实施前应锁定兼容版本。Next.js 请求处理及构建能力、Vite 的 React 模板分别见 [Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers)、[Next.js CLI](https://nextjs.org/docs/app/api-reference/cli/next)、[Vite 指南](https://vite.dev/guide/)。
