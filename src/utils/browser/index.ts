import { getString } from '../../config/env.js';

export * from './driver.js';
export * from './chromeLauncher.js';
export * from './cdpPage.js';
export * from './cdpDriver.js';

export function getBrowserDriverName(): 'cdp' | 'playwright' {
    const env = getString('BROWSER_DRIVER', 'cdp').toLowerCase();
    return env === 'playwright' ? 'playwright' : 'cdp';
}
