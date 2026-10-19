import { createErrorEnvelope, createSuccessEnvelope } from '../protocol.js';
import { ErrorCode } from '../../core/errors.js';
import {
    CommandContext,
    DaemonTransportArgs,
    extractDaemonTransportArgs,
    getDaemonCliErrorCode,
    getDaemonCliErrorHint,
    getDaemonCliErrorLabel,
    isSuccessEnvelope,
    tryDaemonRequest
} from '../shared.js';

export async function handleCacheClearCommand(ctx: CommandContext): Promise<number> {
    const { argv: rest, io, runtime, options } = ctx;
    const json = rest.includes('--json');
    let transport: DaemonTransportArgs;
    try {
        transport = extractDaemonTransportArgs(rest);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (json) {
            io.stdout(JSON.stringify(createErrorEnvelope(
                ErrorCode.INVALID_ARGUMENTS,
                message,
                { hint: 'Use `my-websearch cache-clear [--daemon-url URL] [--spawn] [--json]`.' }
            ), null, 2));
        } else {
            io.stderr(message);
            io.stderr('Usage: my-websearch cache-clear [--daemon-url URL] [--spawn] [--json]');
        }
        return 1;
    }

    try {
        const daemonResult = await tryDaemonRequest<{ cleared: boolean; cacheSize: number }>(
            transport,
            '/cache/clear',
            {},
            options
        );
        if (daemonResult) {
            if (json) {
                io.stdout(JSON.stringify(daemonResult, null, 2));
            } else if (isSuccessEnvelope(daemonResult)) {
                io.stdout(`Search cache cleared (${daemonResult.data?.cacheSize ?? 0} entries remaining).`);
            } else {
                io.stderr(`Failed to clear search cache: ${daemonResult.error?.message ?? 'Unknown error'}`);
                if (daemonResult.hint) {
                    io.stderr(daemonResult.hint);
                }
            }
            return daemonResult.status === 'ok' ? 0 : 1;
        }

        runtime.services.search.clearCache();
        if (json) {
            io.stdout(JSON.stringify(createSuccessEnvelope({
                cleared: true,
                cacheSize: runtime.services.search.cacheSize
            }), null, 2));
        } else {
            io.stdout('Search cache cleared.');
        }
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (json) {
            io.stdout(JSON.stringify(createErrorEnvelope(
                getDaemonCliErrorCode(error),
                message,
                { hint: getDaemonCliErrorHint(error) }
            ), null, 2));
        } else {
            io.stderr(`${getDaemonCliErrorLabel(error, 'Failed to clear search cache')}: ${message}`);
        }
        return 1;
    }
}
