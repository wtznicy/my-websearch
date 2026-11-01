export interface DeviceProfile {
    id: string;
    userAgent: string;
    platform: string;
    acceptLanguage: string;
    timezone: string;
    locale: string;
    hardwareConcurrency: number;
    deviceMemory: number;
    screen: { width: number; height: number; dpr: number };
    webgl: { vendor: string; renderer: string };
}

const PROFILES: DeviceProfile[] = [
    {
        id: 'windows-chrome-8',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        platform: 'Win32',
        acceptLanguage: 'en-US,en;q=0.9',
        timezone: 'America/New_York',
        locale: 'en-US',
        hardwareConcurrency: 8,
        deviceMemory: 8,
        screen: { width: 1920, height: 1080, dpr: 1 },
        webgl: {
            vendor: 'Google Inc. (NVIDIA)',
            renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'
        }
    },
    {
        id: 'windows-chrome-16',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        platform: 'Win32',
        acceptLanguage: 'en-US,en;q=0.9',
        timezone: 'America/Los_Angeles',
        locale: 'en-US',
        hardwareConcurrency: 16,
        deviceMemory: 8,
        screen: { width: 2560, height: 1440, dpr: 1 },
        webgl: {
            vendor: 'Google Inc. (NVIDIA)',
            renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)'
        }
    },
    {
        id: 'macos-chrome-8',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        platform: 'MacIntel',
        acceptLanguage: 'en-US,en;q=0.9',
        timezone: 'America/Los_Angeles',
        locale: 'en-US',
        hardwareConcurrency: 8,
        deviceMemory: 8,
        screen: { width: 1728, height: 1117, dpr: 2 },
        webgl: {
            vendor: 'Google Inc. (Apple)',
            renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'
        }
    }
];

export function listDeviceProfiles(): DeviceProfile[] {
    return PROFILES.map((profile) => ({ ...profile, screen: { ...profile.screen }, webgl: { ...profile.webgl } }));
}

export function selectDeviceProfile(selector?: string): DeviceProfile {
    const wanted = (selector ?? process.env.BROWSER_PROFILE ?? 'windows-chrome-8').trim();
    if (wanted === 'random') {
        return listDeviceProfiles()[Math.floor(Math.random() * PROFILES.length)]!;
    }
    return listDeviceProfiles().find((profile) => profile.id === wanted) ?? listDeviceProfiles()[0]!;
}

/**
 * JavaScript fallback for fields Chromium/CDP has no native override for.
 * hardwareConcurrency/deviceMemory are patched here; screen/UA/timezone/locale
 * must be applied through Emulation, not this script.
 */
export function buildDeviceProfileScript(profile: DeviceProfile): string {
    return `(() => {
  const define = (target, key, value) => {
    try { Object.defineProperty(target, key, { configurable: true, get: () => value }); } catch {}
  };
  define(Navigator.prototype, 'hardwareConcurrency', ${profile.hardwareConcurrency});
  define(Navigator.prototype, 'deviceMemory', ${profile.deviceMemory});
  define(Navigator.prototype, 'webdriver', false);

  const patchWebGL = (proto) => {
    if (!proto || !proto.getParameter) return;
    const original = proto.getParameter;
    proto.getParameter = function (parameter) {
      if (parameter === 37445) return ${JSON.stringify(profile.webgl.vendor)};
      if (parameter === 37446) return ${JSON.stringify(profile.webgl.renderer)};
      return original.call(this, parameter);
    };
  };
  patchWebGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  patchWebGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
})();`;
}
