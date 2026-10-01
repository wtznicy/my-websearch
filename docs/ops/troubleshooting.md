# MyWebSearch 运维排查与部署指南 (Operations & Troubleshooting)

本文档面向生产部署与运维排查，汇集服务健康检查、指标监控、反爬对抗、代理配置及 Docker 部署的最佳实践。

---

## 1. 服务监控与健康检查端点

`my-websearch` 在不同模式下均提供了自省与可观测性端点：

| 端点 | 请求方法 | 适用模式 | 说明 |
| :--- | :--- | :--- | :--- |
| `/health` | `GET` | HTTP / Docker / Daemon | 服务健康检查，返回 `{ "status": "healthy", "version": "...", "name": "my-websearch" }` |
| `/ping` | `GET` | HTTP / Docker / Daemon | 极简心跳探活接口，返回 200 OK |
| `/status` | `GET` | 本地守护进程 (`serve`) | 获取详细运行时状态（内存占用、会话数、引擎列表、启动时间） |
| `/metrics` | `GET` | HTTP / Daemon | Prometheus 格式指标输出（需 `METRICS_ENABLED=true` 启用实时统计） |
| `/cache/clear` | `POST` | 本地守护进程 (`serve`) | 运行时主动清空当前 TTL 搜索缓存 |

> 💡 **Prometheus 指标核心字段**：
> - `search_requests_total{engine="...", outcome="success|failure"}`: 各引擎请求计数
> - `search_cache_hits_total` / `search_cache_misses_total`: 缓存命中率指标
> - `search_circuit_open_total{engine="..."}`: 引擎熔断触发次数
> - `security_events_total{type="ssrf_blocked"}`: SSRF 拦截与重绑定拦截计数

---

## 2. 常见故障排查与恢复

### ① Bing 搜索返回 0 结果或触发软封禁
- **机制原理**：当 HTTP 模式（或 `wreq-js` impersonate）由于特定出口 IP 反爬或页面微调解析不到结果时，系统会自动抛出异常：
  - 若 `BING_PLAYWRIGHT_FALLBACK=true`（默认开启）：自动唤起无头/隐藏浏览器完成真实渲染交互；
  - 若 Playwright 未就绪：触发下游智能级联，自动调用百度、DuckDuckGo 或 Brave 补齐结果。
- **排查建议**：
  1. 单独验证 Bing 实时探测：`npm run test:bing:live`；
  2. 若出口 IP 被 Bing 限制，可开启代理或使用国际版 Host：`OPEN_WEBSEARCH_BING_HOST=https://www.bing.com/search`。

### ② Brave 遇到 HTTP 429 (Rate Limit)
- **机制原理**：Brave 搜索公开接口对单一 IP 高频调用设有限频。
- **自动恢复**：内置熔断器检测到 HTTP 429 后会自动进入 5 分钟冷却熔断（Circuit Open），期间配额自动转让给其他引擎，防止级联请求被重复挂起。

### ③ Clash TUN / Fake-IP 模式报私网拦截 (`is private IP address`)
- **机制原理**：Fake-IP 模式会将公网域名映射到 `198.18.0.0/15` 网段，触发默认 SSRF 规则。
- **解决方案**：服务已默认包含 `198.18.0.0/15` 白名单。若自定义了 Fake-IP 段，通过环境变量追加：
  ```bash
  FAKE_IP_CIDRS="198.18.0.0/15,198.20.0.0/16"
  ```

### ④ Context7 匿名配额耗尽 (`quota exhausted`)
- **机制原理**：Context7 官方文档服务对每个出口 IP 提供每月免费匿名配额（每月 1 日重置）。
- **解决方案**：在 [Context7 官网](https://context7.com) 申请专属免费 API Key，配置环境变量 `CONTEXT7_API_KEY=your_key` 即可获得高额度。

---

## 3. Docker 与生产容器部署

### 推荐 Docker 启动命令
```bash
docker run -d \
  --name my-websearch \
  -p 3211:3211 \
  -e MODE=http \
  -e HOST=0.0.0.0 \
  -e MAX_CONCURRENT_SEARCHES=20 \
  --restart unless-stopped \
  my-websearch:latest
```

### 生产环境变量推荐清单
```env
# 运行模式：仅 HTTP MCP 服务
MODE=http
HOST=0.0.0.0
PORT=3211

# 并发与超时控制
MAX_CONCURRENT_SEARCHES=20
SEARCH_DEADLINE_MS=30000
DEFAULT_MIN_RESULTS=5

# 浏览器兜底
PLAYWRIGHT_HEADLESS=true

# 会话治理
MCP_MAX_SESSIONS=100
MCP_SESSION_TTL_MS=1800000
```
