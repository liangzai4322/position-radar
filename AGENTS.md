# GitHub Pages 发布镜像约定

- 本仓库是 `D:\page\2026\trader-monitor-site\frontend` 的发布镜像。
- 功能修改先在唯一编辑源完成并运行 smoke，再复制到本仓库。
- 公共页面只使用 `GET https://liangzai666.com/api/status?rank_type=<type>`；不加入设置或排行榜 POST。
- `202 warming` 是正常冷分类状态，前端继续轮询。
- `all` 人数动态变化，验收要求大于 9，不写死 44。
- 发布前后都运行：`powershell -ExecutionPolicy Bypass -File .\tests\smoke.ps1`。
- 推送 `main` 后等待 GitHub Pages 状态为 `built`，再做桌面和 390px 移动端验收。
