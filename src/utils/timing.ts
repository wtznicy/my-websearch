/** 通用等待工具：各引擎/服务共享，避免重复定义 sleep */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
