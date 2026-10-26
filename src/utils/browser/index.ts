export * from './driver.js';
export * from './chromeLauncher.js';
export * from './cdpPage.js';
export * from './cdpDriver.js';

export function getBrowserDriverName(): 'cdp' | 'playwright' {
    const env = (process.env.BROWSER_DRIVER || 'cdp').trim().toLowerCase();
    return env === 'playwright' ? 'playwright' : 'cdp';
}
