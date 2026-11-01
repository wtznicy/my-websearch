export interface DeviceProfile {
    id: string;
    userAgent: string;
    platform: string;
    acceptLanguage: string;
    timezone: string;
    locale: string;
    screen: { width: number; height: number; dpr: number };
}

const PROFILES: DeviceProfile[] = [
    {
        id: 'windows-chrome-8',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        platform: 'Win32',
        acceptLanguage: 'en-US,en;q=0.9',
        timezone: 'America/New_York',
        locale: 'en-US',
        screen: { width: 1920, height: 1080, dpr: 1 }
    },
    {
        id: 'windows-chrome-16',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        platform: 'Win32',
        acceptLanguage: 'en-US,en;q=0.9',
        timezone: 'America/Los_Angeles',
        locale: 'en-US',
        screen: { width: 2560, height: 1440, dpr: 1 }
    },
    {
        id: 'macos-chrome-8',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        platform: 'MacIntel',
        acceptLanguage: 'en-US,en;q=0.9',
        timezone: 'America/Los_Angeles',
        locale: 'en-US',
        screen: { width: 1728, height: 1117, dpr: 2 }
    }
];

export function listDeviceProfiles(): DeviceProfile[] {
    return PROFILES.map((profile) => ({ ...profile, screen: { ...profile.screen } }));
}

export function selectDeviceProfile(selector?: string): DeviceProfile {
    const wanted = (selector ?? process.env.BROWSER_PROFILE ?? 'windows-chrome-8').trim();
    if (wanted === 'random') {
        return listDeviceProfiles()[Math.floor(Math.random() * PROFILES.length)]!;
    }
    return listDeviceProfiles().find((profile) => profile.id === wanted) ?? listDeviceProfiles()[0]!;
}
