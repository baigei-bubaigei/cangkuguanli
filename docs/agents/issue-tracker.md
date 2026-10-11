# 任务跟踪：GitHub Issues

本项目的需求和开发任务记录在 baigei-bubaigei/cangkuguanli 的
GitHub Issues，使用 gh CLI 操作。运行命令前核对 git remote -v。

## 操作约定

- 创建任务：gh issue create --repo baigei-bubaigei/cangkuguanli
  --title "标题" --body-file <正文文件>
- 读取任务及评论：gh issue view <编号>
  --repo baigei-bubaigei/cangkuguanli --comments
- 查询任务：gh issue list --repo baigei-bubaigei/cangkuguanli
  --state open --json number,title,body,labels
- 添加评论：gh issue comment <编号>
  --repo baigei-bubaigei/cangkuguanli --body-file <评论文件>
- 调整标签：gh issue edit <编号>
  --repo baigei-bubaigei/cangkuguanli --add-label "标签"
  或 --remove-label "标签"
- 关闭任务：gh issue close <编号>
  --repo baigei-bubaigei/cangkuguanli

多行正文写入临时文件，再通过 --body-file 传入，保留真实换行。
若 gh 不可用或未登录，明确报告，不能声称任务已发布。

## 技能指令的含义

- “发布到任务跟踪器”：创建 GitHub Issue，并记录返回的编号和链接。
- “读取相关任务”：读取对应 Issue 的正文、标签和评论。
- 本地需求文档继续保留；此配置不自动发布已有文档。

## Pull requests as a triage surface

PRs as a request surface: no.
