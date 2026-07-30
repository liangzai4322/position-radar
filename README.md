# 交易员仓位雷达（静态前端）

零框架、零 CDN、可直接部署到 GitHub Pages 的只读交易监控前端。实时 API 默认指向 `https://liangzai666.com/api/status`。

- 正式站点：https://liangzai4322.github.io/position-radar/
- 唯一编辑源：`D:\page\2026\trader-monitor-site\frontend`
- 发布镜像：`D:\page\2026\position-radar-pages`

## 本地预览

```powershell
cd D:\page\2026\trader-monitor-site\frontend
python -m http.server 4173
```

- 实时接口：<http://localhost:4173/>
- 固定样本：<http://localhost:4173/?demo=1>

不要直接双击 `index.html`；PWA 和请求策略需要 HTTP 环境。

## 部署配置

编辑 `config.js`：

```js
window.APP_CONFIG = Object.freeze({
  API_BASE_URL: 'https://liangzai666.com',
  STATUS_PATH: '/api/status',
  REQUEST_TIMEOUT_MS: 12000,
  STALE_AFTER_SECONDS: 45,
  MIN_POLL_SECONDS: 10
});
```

如果变更 API 域名，需要同步修改 `index.html` 中 CSP 的 `connect-src`。该目录所有资源均使用 `./` 相对路径，可部署到 GitHub Pages 的仓库子路径。

### 后端接口契约

公开请求格式：

```text
GET https://liangzai666.com/api/status?rank_type=<type>
```

支持的 `type`：

| 值 | 界面分类 |
| --- | --- |
| `composite` | 综合排序 |
| `yieldRatio` | 收益率 |
| `pnl` | 收益额 |
| `winRatio` | 胜率 |
| `aum` | 带单规模 |
| `traderFollowerLimit` | 跟单人数 |
| `followTotalPnl` | 跟单用户收益 |
| `all` | 所有交易员 |

- 已缓存分类返回 `200` 和与 `status.sample.json` 同结构的数据。
- 首次准备返回 `202`、`{"status":"warming","rank_type":"<type>"}`；前端每 2 秒重试。
- `all` 人数动态变化，不能按固定 44 人实现或测试；应验证其人数大于普通 9 人榜单。
- API 对 GitHub Pages Origin 开放 `GET`/`OPTIONS`，响应使用 `Cache-Control: no-store`。
- 公共前端只读取状态接口；设置、排行切换等写接口留在服务器内部。

## 已实现能力

- **视觉与信息层级**：品牌标题、雷达式风险总览、爆仓标尺、多空力量刻度、账户信号卡。
- **筛选与偏好**：账户/币种搜索、币种/方向/风险/仓位筛选、六种排序、收藏置顶、本地持久化。
- **排行榜分类**：综合、收益率、收益额、胜率、带单规模、跟单人数、跟单用户收益和所有交易员分别读取独立列表，不再复用同一组 9 人。
- **风险评分**：对每个账户按最高杠杆、最差收益率、最低保证金率、最近爆仓距离与后端 danger 标记计算 0–100 分；详情中展示评分原因。
- **移动端**：390px 无横向裁切、固定两列关键数字、底部筛选抽屉、所有主要触控区至少 40–44px。
- **状态反馈**：首屏骨架、超时/离线/错误/陈旧提示、重试、最近成功数据本地回退。
- **请求调度**：遵循服务端更新间隔、10% 随机抖动、页面隐藏时降频、AbortController 防叠加、12 秒超时。
- **数据变化**：收益率与持仓值相较上轮变化时给出方向文字和一次性高亮；遵循 `prefers-reduced-motion`。
- **可访问性**：跳过链接、语义区块、ARIA live/alert、清晰焦点、原生 dialog 焦点圈闭、颜色之外的方向符号和文字。
- **PWA**：Manifest、Favicon、Apple Touch Icon、离线壳、同源静态资源 Service Worker 缓存。
- **依赖与 CSP**：原生 JS/CSS，无第三方运行时，首页无内联脚本/样式，CSP 限制连接域名。

## 风险评分阈值

| 等级 | 分值 | 含义 |
| --- | ---: | --- |
| 紧急 | 60–100 | 多个高风险因子叠加 |
| 偏高 | 38–59 | 杠杆、亏损或爆仓距离显著 |
| 关注 | 18–37 | 存在需要关注的单项因子 |
| 平稳 | 0–17 | 当前公开数据未出现显著风险因子 |

该评分是界面排序信号，不是投资建议。

## 验证

```powershell
powershell -ExecutionPolicy Bypass -File .\tests\smoke.ps1
```

脚本检查静态资产、API 契约样本、Manifest、CSP、可访问性标记、只读约束、轮询实现与 JavaScript 语法。
