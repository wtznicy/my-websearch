/**
 * 请求头 `Accept-Language` 的默认值：跟随系统区域，而不是硬编码 zh-CN。
 *
 * 背景：这个工具在中国以外也会被使用（README 有英文版、工具描述全英文），
 * 但抓取路径一直发 `zh-CN,zh;q=0.9,en;q=0.8`，外国用户会拿到中文优先的页面。
 * 中文站点（baidu/sogou/csdn/掘金）仍然保持 zh-CN —— 那是目标站点的语言，不是用户偏好。
 *
 * 覆盖方式：环境变量 `ACCEPT_LANGUAGE`（优先级最高）。
 */
export function isChineseLocale(env: NodeJS.ProcessEnv = process.env): boolean {
    try {
        return /^zh\b/i.test(Intl.DateTimeFormat().resolvedOptions().locale || '');
    } catch {
        return Boolean(env.LANG?.toLowerCase().startsWith('zh'));
    }
}

export function resolveAcceptLanguage(env: NodeJS.ProcessEnv = process.env): string {
    const explicit = env.ACCEPT_LANGUAGE?.trim();
    if (explicit) {
        return explicit;
    }

    let locale = 'en-US';
    try {
        locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
    } catch {
        // 极简运行时可能没有 Intl，退回 en-US
    }

    const primary = locale.split('-')[0] ?? 'en';
    if (primary.toLowerCase() === 'zh') {
        return 'zh-CN,zh;q=0.9,en;q=0.8';
    }
    return `${locale},${primary};q=0.9,en;q=0.8`;
}
