// src/config.ts
export interface AppConfig {
    // Search engine configuration
    defaultSearchEngine: 'bing' | 'duckduckgo' | 'exa' | 'brave';
    // Proxy configuration
    proxyUrl?: string;
    useProxy: boolean;
    // CORS configuration
    enableCors: boolean;
    corsOrigin: string;
}

// Read from environment variables or use defaults
export const config: AppConfig = {
    // Search engine configuration
    defaultSearchEngine: (process.env.DEFAULT_SEARCH_ENGINE as AppConfig['defaultSearchEngine']) || 'bing',
    // Proxy configuration
    proxyUrl: process.env.PROXY_URL || 'http://127.0.0.1:10809',
    useProxy: process.env.USE_PROXY === 'true',
    // CORS configuration
    enableCors: process.env.ENABLE_CORS === 'true',
    corsOrigin: process.env.CORS_ORIGIN || '*'

};

// Validate config
if (!['bing', 'duckduckgo'].includes(config.defaultSearchEngine)) {
    console.warn(`Invalid DEFAULT_SEARCH_ENGINE: "${config.defaultSearchEngine}", falling back to "bing"`);
    config.defaultSearchEngine = 'bing';
}

// Log configuration
console.log(`🔍 Using default search engine: ${config.defaultSearchEngine}`);
if (config.useProxy) {
    console.log(`🌐 Using proxy: ${config.proxyUrl}`);
} else {
    console.log(`🌐 No proxy configured (set USE_PROXY=true to enable)`);
}
if (config.enableCors) {
    console.log(`🔒 CORS enabled with origin: ${config.corsOrigin}`);
} else {
    console.log(`🔒 CORS disabled (set ENABLE_CORS=true to enable)`);
}


/**
 * Helper function to get the proxy URL if proxy is enabled
 */
export function getProxyUrl(): string | undefined {
    return config.useProxy ? encodeURI(<string>config.proxyUrl) : undefined;
}
