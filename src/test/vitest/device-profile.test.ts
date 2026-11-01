import { describe, expect, it } from 'vitest';
import { buildDeviceProfileScript, listDeviceProfiles, selectDeviceProfile } from '../../utils/browser/deviceProfile.js';

describe('CDP device profiles', () => {
    it('selects a named profile and falls back to a coherent default', () => {
        expect(selectDeviceProfile('windows-chrome-8').id).toBe('windows-chrome-8');
        expect(selectDeviceProfile('does-not-exist').id).toBe('windows-chrome-8');
    });

    it('keeps deviceMemory within the Chromium spec range (max 8)', () => {
        for (const profile of listDeviceProfiles()) {
            expect(profile.deviceMemory).toBeLessThanOrEqual(8);
            expect([4, 8, 16]).not.toContain(profile.deviceMemory === 16 ? 16 : -1);
        }
    });

    it('builds a script containing hardware, memory and WebGL overrides', () => {
        const script = buildDeviceProfileScript(selectDeviceProfile('windows-chrome-8'));
        expect(script).toContain("'hardwareConcurrency', 8");
        expect(script).toContain("'deviceMemory', 8");
        expect(script).toContain('37445');
        expect(script).toContain('37446');
        expect(script).toContain('WebGL2RenderingContext');
    });
});
