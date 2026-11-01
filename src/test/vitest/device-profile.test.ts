import { describe, expect, it } from 'vitest';
import { listDeviceProfiles, selectDeviceProfile } from '../../utils/browser/deviceProfile.js';

describe('CDP device profiles', () => {
    it('selects a named profile and falls back to a coherent default', () => {
        expect(selectDeviceProfile('windows-chrome-8').id).toBe('windows-chrome-8');
        expect(selectDeviceProfile('does-not-exist').id).toBe('windows-chrome-8');
    });

    it('keeps UA, platform and screen settings internally coherent', () => {
        for (const profile of listDeviceProfiles()) {
            expect(profile.userAgent).toContain('Chrome/');
            expect(profile.screen.width).toBeGreaterThanOrEqual(1280);
            expect(profile.screen.height).toBeGreaterThanOrEqual(720);
            expect(profile.locale).toBeTruthy();
            expect(profile.timezone).toBeTruthy();
        }
        const mac = selectDeviceProfile('macos-chrome-8');
        expect(mac.userAgent).toContain('Macintosh');
        expect(mac.platform).toBe('MacIntel');
    });
});
