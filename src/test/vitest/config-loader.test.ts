import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
    parseDotEnv,
    flattenConfigFileToEnv,
    loadApplicationConfigEnv,
    getAppConfigFilePath
} from '../../configLoader.js';

describe('configLoader', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-websearch-test-config-'));
    });

    afterEach(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });

    describe('parseDotEnv', () => {
        it('parses basic key-value pairs', () => {
            const raw = `
# Comment line
CONTEXT7_API_KEY=test_c7_key
EXA_API_KEY="test_exa_key"
GITHUB_TOKEN='test_gh_token'
EMPTY_LINE=

INVALID LINE WITHOUT EQUALS
`;
            const parsed = parseDotEnv(raw);
            expect(parsed.CONTEXT7_API_KEY).toBe('test_c7_key');
            expect(parsed.EXA_API_KEY).toBe('test_exa_key');
            expect(parsed.GITHUB_TOKEN).toBe('test_gh_token');
            expect(parsed.EMPTY_LINE).toBe('');
            expect(parsed['INVALID LINE WITHOUT EQUALS']).toBeUndefined();
        });
    });

    describe('flattenConfigFileToEnv', () => {
        it('correctly maps structured apiKeys and proxy settings', () => {
            const configData = {
                apiKeys: {
                    context7: 'ctx7sk-12345',
                    exa: 'exa-67890',
                    github: 'ghp_abc',
                    brave: 'bsk_xyz'
                },
                proxy: {
                    url: 'http://127.0.0.1:7897',
                    useProxy: true,
                    engines: ['brave', 'duckduckgo'],
                    fakeIpCidrs: ['198.18.0.0/15']
                }
            };

            const flat = flattenConfigFileToEnv(configData);
            expect(flat.CONTEXT7_API_KEY).toBe('ctx7sk-12345');
            expect(flat.EXA_API_KEY).toBe('exa-67890');
            expect(flat.GITHUB_TOKEN).toBe('ghp_abc');
            expect(flat.BRAVE_API_KEY).toBe('bsk_xyz');
            expect(flat.PROXY_URL).toBe('http://127.0.0.1:7897');
            expect(flat.USE_PROXY).toBe('true');
            expect(flat.PROXY_ENGINES).toBe('brave,duckduckgo');
            expect(flat.FAKE_IP_CIDRS).toBe('198.18.0.0/15');
        });
    });

    describe('loadApplicationConfigEnv cascading priority', () => {
        it('preserves existing targetEnv variables and fills missing ones', () => {
            const fakeTargetEnv: NodeJS.ProcessEnv = {
                MYWEBSEARCH_DATA_DIR: tempDir,
                CONTEXT7_API_KEY: 'pre-existing-c7-key'
            };

            // Write app config file
            const appConfigPath = getAppConfigFilePath(fakeTargetEnv);
            fs.writeFileSync(
                appConfigPath,
                JSON.stringify({
                    apiKeys: {
                        context7: 'should-not-override-c7',
                        exa: 'injected-exa-key'
                    }
                }),
                'utf8'
            );

            const injected = loadApplicationConfigEnv(fakeTargetEnv, { cwd: tempDir, quiet: true });

            // CONTEXT7_API_KEY should NOT be overridden
            expect(fakeTargetEnv.CONTEXT7_API_KEY).toBe('pre-existing-c7-key');
            expect(injected.CONTEXT7_API_KEY).toBeUndefined();

            // EXA_API_KEY should be filled
            expect(fakeTargetEnv.EXA_API_KEY).toBe('injected-exa-key');
            expect(injected.EXA_API_KEY).toBe('injected-exa-key');
        });

        it('.env takes precedence over ~/.my-websearch/config.json', () => {
            const fakeTargetEnv: NodeJS.ProcessEnv = {
                MYWEBSEARCH_DATA_DIR: tempDir
            };

            // 1. Write ~/.my-websearch/config.json
            const appConfigPath = getAppConfigFilePath(fakeTargetEnv);
            fs.writeFileSync(
                appConfigPath,
                JSON.stringify({
                    apiKeys: {
                        exa: 'exa-from-config-json'
                    }
                }),
                'utf8'
            );

            // 2. Write project root .env
            fs.writeFileSync(
                path.join(tempDir, '.env'),
                'EXA_API_KEY=exa-from-dot-env\nCONTEXT7_API_KEY=c7-from-dot-env\n',
                'utf8'
            );

            loadApplicationConfigEnv(fakeTargetEnv, { cwd: tempDir, quiet: true });

            // .env value should win over config.json
            expect(fakeTargetEnv.EXA_API_KEY).toBe('exa-from-dot-env');
            expect(fakeTargetEnv.CONTEXT7_API_KEY).toBe('c7-from-dot-env');
        });
    });
});
