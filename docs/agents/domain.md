# 领域文档

本项目使用单一上下文，沿用已有文档，不创建额外的上下文目录。

## 阅读顺序

探索或修改相关功能前：
1. 阅读根目录 GLOSSARY.md，统一业务术语。
2. 阅读 docs/adr/ 中与本次工作有关的架构决策。

已有决策：
- 0001-preserve-packaging-state.md：保留实际包装状态。
- 0002-react-vite-nextjs-postgresql.md：正式系统使用
  React + Vite、Next.js/Node.js 和 PostgreSQL。

需求和页面验收依据分别为 docs/需求设计.md、
docs/需求拆分方案.md 和根目录的纯静态 Demo。
纯静态 Demo 的原生 HTML/CSS/JavaScript 与正式系统技术栈
各有用途，按本次任务范围处理。

## 使用规则

- 业务概念使用 GLOSSARY.md 中的名称和定义。
- 遇到尚未定义的术语，先判断是否确有缺口，不随意发明同义名称。
- 方案与已有 ADR 冲突时，明确指出冲突，不悄悄覆盖原决策。
- 文档不存在时继续当前工作，不因缺少文档预先创建额外设计。
- 修改领域文档时仅记录本次已明确的术语和决策。
