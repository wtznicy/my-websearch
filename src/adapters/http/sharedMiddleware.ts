import express from 'express';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';

/**
 * 两个 HTTP 入口（MCP 传输 `src/index.ts` / 本地 REST daemon `localDaemon.ts`）共享的中间件配置。
 *
 * 之前两处各写一遍：`express.json()` + 从 `OPEN_WEBSEARCH_ALLOWED_HOSTS` 拼允许列表 +
 * `hostHeaderValidation`。两份实现会独立漂移，而这是**安全相关**的白名单——
 * 漂移的后果是其中一个入口悄悄放宽了 DNS rebinding 防护。所以收敛到一处。
 *
 * 中间件顺序不能变：健康检查必须在 host 校验之前注册（容器/K8s 探针的 Host 头
 * 往往不是 localhost），调用方按 `applyJsonBody` → 注册 /health → `applyHostValidation` 的顺序使用。
 */

export const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'] as const;

/**
 * 允许的 Host 头列表：显式配置优先，否则只放行回环；再补上实际绑定地址。
 * 两者共用同一套解析，避免「daemon 放行了绑定地址、MCP 入口没放行」这类不一致。
 */
export function resolveAllowedHostnames(
    extraHosts: Array<string | undefined> = [],
    env: NodeJS.ProcessEnv = process.env
): string[] {
    const configured = (env.OPEN_WEBSEARCH_ALLOWED_HOSTS ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);

    const hostnames = configured.length > 0 ? [...configured] : [...LOOPBACK_HOSTNAMES];
    for (const host of extraHosts) {
        if (host && !hostnames.includes(host)) {
            hostnames.push(host);
        }
    }
    return hostnames;
}

/** JSON body 解析。两个入口都需要，且限额/参数应保持一致。 */
export function applyJsonBody(app: express.Express): void {
    app.use(express.json());
}

/** DNS rebinding 防护。必须在 /health 之后注册。 */
export function applyHostValidation(
    app: express.Express,
    extraHosts: Array<string | undefined> = []
): string[] {
    const allowed = resolveAllowedHostnames(extraHosts);
    app.use(hostHeaderValidation(allowed));
    return allowed;
}
