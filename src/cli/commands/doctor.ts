import { SUPPORTED_SEARCH_ENGINES, SupportedSearchEngine, normalizeEngineName } from '../../core/search/searchEngines.js';
import { createErrorEnvelope, createSuccessEnvelope } from '../protocol.js';
import { ErrorCode } from '../../core/errors.js';
import { buildDoctorReport, formatDoctorHumanReadable } from '../doctor.js';
import { CommandContext, isFlag, readServerVersion } from '../shared.js';

export async function handleDoctorCommand(ctx: CommandContext): Promise<number> {
    const { argv: rest, io, runtime } = ctx;
    let json = false;
    let network = false;
    let browser = false;
    let resetHealth = false;
    const rawEngines: string[] = [];
    try {
        for (let index = 0; index < rest.length; index += 1) {
            const arg = rest[index]!;
            if (arg === '--json') {
                json = true;
                continue;
            }
            if (arg === '--network') {
                network = true;
                continue;
            }
            if (arg === '--browser') {
                browser = true;
                continue;
            }
            if (arg === '--reset-health') {
                resetHealth = true;
                continue;
            }
            if (arg === '--engine' || arg === '--engines') {
                const value = rest[index + 1];
                if (!value || isFlag(value)) {
                    throw new Error(`Missing value for ${arg}`);
                }
                rawEngines.push(...value.split(',').map((item) => item.trim()).filter(Boolean));
                index += 1;
                continue;
            }
            if (arg.startsWith('--engine=') || arg.startsWith('--engines=')) {
                const [, value = ''] = arg.split('=', 2);
                const split = value.split(',').map((item) => item.trim()).filter(Boolean);
                if (split.length === 0) {
                    throw new Error(`Missing value for ${arg.split('=', 1)[0]}`);
                }
                rawEngines.push(...split);
                continue;
            }
            throw new Error(isFlag(arg) ? `Unknown argument: ${arg}` : `Unexpected positional argument: ${arg}`);
        }

        const engines = rawEngines.length > 0
            ? Array.from(new Set(rawEngines.map((rawEngine) => {
                const normalized = normalizeEngineName(rawEngine);
                if (!SUPPORTED_SEARCH_ENGINES.includes(normalized as SupportedSearchEngine)) {
                    throw new Error(`Unsupported search engine: ${rawEngine}`);
                }
                return normalized;
            })))
            : undefined;

        const report = await buildDoctorReport(runtime, {
            version: readServerVersion(),
            network: network || Boolean(engines && engines.length > 0),
            browser,
            resetHealth,
            ...(engines ? { engines } : {})
        });
        if (json) {
            io.stdout(JSON.stringify(createSuccessEnvelope(report), null, 2));
        } else {
            io.stdout(formatDoctorHumanReadable(report));
        }
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rest.includes('--json')) {
            io.stdout(JSON.stringify(createErrorEnvelope(
                ErrorCode.INVALID_ARGUMENTS,
                message,
                { hint: 'Use `my-websearch doctor [--network] [--browser] [--engine bing,baidu] [--reset-health] [--json]`.' }
            ), null, 2));
        } else {
            io.stderr(message);
            io.stderr('Usage: my-websearch doctor [--network] [--browser] [--engine bing,baidu] [--reset-health] [--json]');
        }
        return 1;
    }
}
