/**
 * 查询预处理：
 * 1. 堆栈降噪：剥离报错堆栈中的私有路径与行号。
 * 2. 技术专名与型号引号包裹：给技术专名、库名（Vitest、Next.js）、
 *    型号版本（GLM-4.6V-Flash）与大写技术缩写（MCP）自动加引号，避免搜索引擎拆词漂移。
 */

const MODEL_LIKE_TERM = /(?<![\w.-])(?=[A-Za-z0-9.-]*\d)[A-Za-z][A-Za-z0-9.-]*[-.][A-Za-z0-9][A-Za-z0-9.-]*(?![\w.-])/g;

const TECH_TERMS_WHITELIST = new Set([
    'vitest', 'vite', 'next.js', 'nuxt.js', 'node.js', 'vue.js', 'react.js',
    'express.js', 'mcp', 'typescript', 'javascript', 'playwright', 'puppeteer',
    'tailwind', 'tailwindcss', 'postcss', 'webpack', 'rollup', 'esbuild',
    'prisma', 'drizzle', 'zustand', 'redux', 'fastapi', 'django', 'flask',
    'spring', 'springboot', 'kubernetes', 'docker', 'graphql', 'grpc',
    'redis', 'mongodb', 'postgresql', 'mysql', 'sqlite', 'elasticsearch',
    'cheerio', 'axios', 'zod', 'langchain', 'llamaindex', 'huggingface',
    'pytorch', 'tensorflow', 'turborepo', 'turbopack', 'selenium', 'cypress'
]);

const ENGLISH_COMMON_CAPS = new Set([
    'THE', 'AND', 'FOR', 'NOT', 'YOU', 'ALL', 'CAN', 'HER', 'WAS', 'ONE',
    'OUR', 'OUT', 'DAY', 'GET', 'HAS', 'HIM', 'HIS', 'HOW', 'MAN', 'NEW',
    'NOW', 'OLD', 'SEE', 'TWO', 'WAY', 'WHO', 'BOY', 'DID', 'ITS', 'LET',
    'PUT', 'SAY', 'SHE', 'TOO', 'USE', 'YES', 'WHY', 'TOP', 'MAX', 'MIN',
    'ADD', 'SET', 'RUN', 'END', 'ASK', 'BIG', 'KEY', 'TRY', 'FIX', 'DOC',
    'TXT', 'APP', 'WEB', 'NET', 'DEV'
]);

/**
 * 报错堆栈查询自动降噪：
 * 当 query 长度超过 80 字符或包含明显错误堆栈特征时，
 * 自动剥离本机私有路径（如 D:\Desktop\...）、文件行列号（:142:18）、十六进制内存地址与时间戳，
 * 保留纯粹的报错异常特征文本去检索，避免因私有路径导致 0 结果。
 */
export function cleanStackTraceNoise(query: string): string {
    const isLikelyTrace = query.length > 80
        || /[A-Za-z]:\\/.test(query)
        || /\b0x[0-9a-fA-F]{6,}\b/.test(query)
        || /\b(?:\w*Error|\w*Exception):/i.test(query)
        || /\bat\s+[A-Za-z0-9_$.<>]+\s*\([^)]+\)/.test(query);

    if (!isLikelyTrace) {
        return query;
    }

    let cleaned = query
        // 1. 移除 Windows 本机绝对路径（含可能附带的行列号）
        .replace(/[A-Za-z]:\\[^\s:()\[\]<>"']+(?::\d+(?::\d+)?)?/g, '')
        // 2. 移除 Unix 常见绝对/相对源码路径
        .replace(/(?:^|(?<=[\s(]))\/(?:Users|home|root|var|tmp|node_modules|src|dist|packages|app)\/[^\s:()\[\]<>"']+(?::\d+(?::\d+)?)?/g, '')
        // 3. 移除残留的独立行列号（如 :142:18 或 :142）
        .replace(/:\d+:\d+\b|:\d+\b(?=[\s)\]]|$)/g, '')
        // 4. 移除十六进制内存地址（如 0x7fff5fbff8a0）
        .replace(/\b0x[0-9a-fA-F]{6,16}\b/g, '')
        // 5. 移除 ISO 8601 时间戳
        .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '')
        // 6. 移除剥离路径后残留的空括号
        .replace(/\(\s*\)|\[\s*\]/g, ' ')
        // 7. 整理多余空白
        .replace(/\s{2,}/g, ' ')
        .trim();

    // 防御：若清洗后被完全擦除（如整句就只是一个路径），保底退回原 query
    return cleaned.length >= 5 ? cleaned : query;
}

export function quoteModelLikeTerms(query: string): string {
    if (query.includes('"')) {
        return query;
    }
    return query.replace(MODEL_LIKE_TERM, '"$&"');
}

/**
 * 技术专名加引号：
 * 自动识别技术专名、库名、CamelCase 与特定技术大写缩写并加引号，
 * 避免搜索引擎将专名拆散或模糊音近漂移（如 Vitest -> Ping 测速 / Windows 蓝牙）。
 */
export function quoteTechnicalTerms(query: string): string {
    if (query.includes('"')) {
        return query;
    }
    let result = query.replace(/(?<![\w.-])([A-Za-z][A-Za-z0-9]*\.(?:js|ts|org|io|dev|com))(?![\w.-])/gi, '"$1"');
    result = result.replace(MODEL_LIKE_TERM, '"$&"');
    result = result.replace(/(?<!["\w])([A-Za-z][A-Za-z0-9+]*)(?!["\w])/g, (token) => {
        const lower = token.toLowerCase();
        if (TECH_TERMS_WHITELIST.has(lower)) {
            return `"${token}"`;
        }
        if (/^[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*$/.test(token)) {
            return `"${token}"`;
        }
        if (/^[A-Z]{2,6}$/.test(token) && !ENGLISH_COMMON_CAPS.has(token)) {
            return `"${token}"`;
        }
        return token;
    });
    return result;
}

/** 统一查询预处理管道：堆栈降噪 -> 技术专名与型号引号包裹 */
export function preprocessSearchQuery(query: string): string {
    const denoised = cleanStackTraceNoise(query);
    return quoteTechnicalTerms(denoised);
}
