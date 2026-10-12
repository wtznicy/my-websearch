import type { CorsOptions } from 'cors';
import type { AppConfig } from '../../config.js';

/**
 * 解析 CORS_ORIGIN 配置：
 * - 空值或 "*" 返回 "*"
 * - 逗号分隔的多个来源（如 "http://localhost:3000,http://127.0.0.1:5173"）返回来源白名单数组
 * - 单个来源返回修剪后的字符串
 */
export function resolveCorsOrigin(corsOrigin?: string): '*' | string | string[] {
    const raw = (corsOrigin ?? '').trim();
    if (!raw || raw === '*') {
        return '*';
    }
    if (raw.includes(',')) {
        const list = raw
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
        if (list.length === 0 || list.includes('*')) {
            return '*';
        }
        return list.length === 1 ? list[0]! : list;
    }
    return raw;
}

/**
 * 根据配置生成 MCP HTTP 服务的 CORS 选项。
 * 默认收紧跨站调用范围（enableCors=false 时返回 null，不挂载全局 CORS 中间件）。
 */
export function buildMcpCorsOptions(
    cfg: Pick<AppConfig, 'enableCors' | 'corsOrigin'>
): CorsOptions | null {
    if (!cfg.enableCors) {
        return null;
    }
    return {
        origin: resolveCorsOrigin(cfg.corsOrigin),
        methods: ['GET', 'POST', 'DELETE'],
        allowedHeaders: ['Content-Type', 'Mcp-Session-Id'],
        exposedHeaders: ['Mcp-Session-Id']
    };
}

export interface SessionSlotReservation {
    /**
     * 当会话已正式写入活跃表（transports.streamable 或 transports.sse）时调用，
     * 将预占名额平滑移交至活跃计数，避免重复计数或名额空窗。
     */
    promoteToActive(): void;
    /**
     * 当初始化失败或连接在写入活跃表前中止时调用，幂等释放预占名额。
     */
    release(): void;
}

export interface SessionCapacityManager {
    readonly maxSessions: number;
    getInitializingCount(): number;
    getActiveCount(): number;
    getOccupiedCount(): number;
    tryReserve(): SessionSlotReservation | null;
}

/**
 * 统一管理 MCP（/mcp Streamable HTTP 与 /sse）的“初始化中 + 活跃”会话配额。
 */
export function createSessionCapacityManager(
    maxSessions: number,
    getActiveCount: () => number
): SessionCapacityManager {
    let initializingCount = 0;

    const getOccupiedCount = (): number => {
        return initializingCount + getActiveCount();
    };

    return {
        maxSessions,
        getInitializingCount: () => initializingCount,
        getActiveCount,
        getOccupiedCount,
        tryReserve(): SessionSlotReservation | null {
            if (getOccupiedCount() >= maxSessions) {
                return null;
            }
            initializingCount += 1;
            let settled = false;

            const settle = () => {
                if (settled) {
                    return;
                }
                settled = true;
                initializingCount = Math.max(0, initializingCount - 1);
            };

            return {
                promoteToActive: settle,
                release: settle
            };
        }
    };
}
