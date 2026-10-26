# Playwright 到 Chrome DevTools Protocol (CDP) 映射表

本文档记录了 `my-websearch` 中原先使用 `playwright-core` 的所有 API 子集及其对应的 Raw CDP 命令映射与实现策略。

## 1. 架构总览

在移除 `playwright-core` 依赖后，系统采用基于 `chrome-remote-interface` 的轻量 CDP 适配层：
- **浏览器生命周期**：直接通过 Node.js `child_process.spawn` 启动本地已安装的 Chrome/Edge，携带 `--headless=new` 与 `--remote-debugging-port=0`。
- **端口探测**：通过 `<user-data-dir>/DevToolsActivePort` 读取分配到的动态调试端口。
- **协议连接**：通过 `chrome-remote-interface` 连接该端口，管理 Target、BrowserContext 与 Page。
- **资源清理**：退出时执行 `Browser.close`，并在操作系统层面杀掉进程树（Windows 使用 `taskkill /pid <PID> /T /F`，POSIX 使用 `process.kill(-pid)`），删除临时目录。

---

## 2. API 逐项映射表

| Playwright API | CDP 对应命令 / 实现机制 | 说明与关键参数 |
| :--- | :--- | :--- |
| `chromium.launch(opts)` | `spawn(chromePath, args)` + `chrome-remote-interface` | 参数包含 `--headless=new`、`--remote-debugging-port=0`、`--user-data-dir` 等。读取 `DevToolsActivePort` 后连接。 |
| `chromium.connectOverCDP(endpoint)` | `CDP({ endpoint })` | 支持直接连接外部已有的 CDP 实例（如远程无头浏览器）。 |
| `browser.newContext(opts)` | `Target.createBrowserContext()` | 创建独立的浏览器上下文（Cookie/Storage 隔离），返回 `browserContextId`。 |
| `context.newPage()` | `Target.createTarget({ url, browserContextId })` | 在指定的上下文内创建新页面，获得 `targetId`，随后 attach。 |
| `browser.newPage()` | `Target.createTarget({ url: 'about:blank' })` | 默认上下文下新建标签页。 |
| `browser.close()` | `Browser.close()` + 杀进程树 + 删临时目录 | 确保不会产生僵尸 Chrome 进程。 |
| `page.goto(url, { waitUntil, timeout })` | `Page.enable` + `Page.navigate({ url })` | 监听 `Page.loadEventFired` 或 `Page.domContentEventFired`，结合超时控制。 |
| `page.waitForSelector(selector, { state, timeout })` | `Runtime.evaluate` 轮询 | 每隔 100ms 轮询 `document.querySelector(sel)`，支持 `visible` 判定（`getClientRects().length > 0`）。 |
| `page.waitForFunction(fn, arg, { timeout })` | `Runtime.evaluate` 轮询 | 将函数与参数序列化为 IIFE，在页面上下文内轮询计算返回值。 |
| `page.waitForURL(urlOrPredicate, { timeout })` | 轮询 `window.location.href` | 轮询当前页面 URL 直到命中正则或断言函数。 |
| `page.waitForLoadState('networkidle')` | 监听 `Network.requestWillBeSent` / `loadingFinished` | 统计活跃请求数，保持为 0 达到 500ms 时完成。 |
| `page.evaluate(fn, ...args)` | `Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true })` | 序列化函数调用并等待 Promise 解析，返回计算结果。 |
| `page.content()` | `Runtime.evaluate({ expression: 'document.documentElement.outerHTML', returnByValue: true })` | 直接提取当前 DOM 的完整 HTML 字符串。 |
| `page.url()` | `Runtime.evaluate({ expression: 'window.location.href' })` 或缓存 | 获取当前页面的规范 URL。 |
| `page.title()` | `Runtime.evaluate({ expression: 'document.title' })` | 获取页面标题。 |
| `page.click(selector)` / `locator.click()` | `Runtime.evaluate` 调用 `.click()` / `Input.dispatchMouseEvent` | 优先通过 DOM API `.click()`；备用通过 `DOM.getBoxModel` 获取坐标发送鼠标事件。 |
| `page.fill(selector, value)` / `locator.fill()` | `Runtime.evaluate` 赋值并派发事件 | 聚焦目标元素，修改 `value` 属性，并派发 `input` 与 `change` 事件以触发前端框架数据绑定。 |
| `page.keyboard.press('Enter')` | `Input.dispatchKeyEvent` | 发送 `rawKeyDown` 与 `keyUp` 事件，附带 `windowsVirtualKeyCode: 13`。 |
| `page.keyboard.type(text)` | `Input.insertText({ text })` | 直接将文本插入当前光标焦点位置。 |
| `context.cookies(urls)` / `page.cookies()` | `Network.enable` + `Network.getCookies({ urls })` | 返回结构化 Cookie 列表（name, value, domain, path, secure, httpOnly, sameSite）。 |
| `page.setViewportSize({ width, height })` | `Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: false })` | 修改页面视口宽高与缩放比例。 |
| `page.setExtraHTTPHeaders(headers)` | `Network.setExtraHTTPHeaders({ headers })` | 为当前页面后续所有网络请求注入自定义请求头（如 `Accept-Language`）。 |
| `page.addInitScript(script)` | `Page.addScriptToEvaluateOnNewDocument({ source })` | 页面导航前注入 JS 代码，用于模拟 `navigator.webdriver`、修改 WebGL 指纹等反反爬操作。 |
| `page.route(pattern, handler)` / 资源拦截 | `Network.setBlockedURLs({ urls: [...] })` | 拦截不需要的图片、媒体、字体等无用资源，降低带宽和延迟。 |

---

## 3. 代码落位规划

- **驱动抽象接口**：`src/utils/browser/driver.ts`
- **Chrome 启动与进程管理**：`src/utils/browser/chromeLauncher.ts`
- **CDP 驱动实现**：`src/utils/browser/cdpDriver.ts`
- **CDP 页面实现**：`src/utils/browser/cdpPage.ts`
- **兼容与会话门面**：`src/utils/browser/browserFacade.ts`（向后兼容原 `browserSession.ts` / `playwrightClient.ts` 的调用点）
