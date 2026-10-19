import { startLocalDaemon } from '../../adapters/http/localDaemon.js';
import { createErrorEnvelope } from '../protocol.js';
import { ErrorCode } from '../../core/errors.js';
import {
    CommandContext,
    isFlag,
    ParsedServeArgs,
    readServerVersion,
    requireFlagValue
} from '../shared.js';

export type { ParsedServeArgs };

export function parseServeArgs(argv: string[]): ParsedServeArgs {
    let host = process.env.OPEN_WEBSEARCH_DAEMON_HOST || '127.0.0.1';
    let port = Number(process.env.OPEN_WEBSEARCH_DAEMON_PORT || '3210');
    let json = false;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (!arg) {
            continue;
        }

        if (arg === '--host') {
            host = requireFlagValue(argv, index, '--host');
            index += 1;
            continue;
        }

        if (arg === '--json') {
            json = true;
            continue;
        }

        if (arg === '--port') {
            port = Number(requireFlagValue(argv, index, '--port'));
            index += 1;
            continue;
        }

        if (isFlag(arg)) {
            throw new Error(`Unknown argument: ${arg}`);
        }

        throw new Error(`Unexpected positional argument: ${arg}`);
    }

    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('Port must be an integer between 0 and 65535');
    }

    return {
        host,
        port,
        json
    };
}

export async function handleServeCommand(ctx: CommandContext): Promise<number> {
    const { argv: rest, io, runtime, options } = ctx;
    let parsed: ParsedServeArgs;
    try {
        parsed = parseServeArgs(rest);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rest.includes('--json')) {
            io.stdout(JSON.stringify(createErrorEnvelope(
                ErrorCode.INVALID_ARGUMENTS,
                message,
                { hint: 'Usage: my-websearch serve [--host HOST] [--port PORT] [--json]' }
            ), null, 2));
        } else {
            io.stderr(message);
            io.stderr('Usage: my-websearch serve [--host HOST] [--port PORT]');
        }
        return 1;
    }

    try {
        const daemon = await startLocalDaemon(runtime, {
            host: parsed.host,
            port: parsed.port,
            // 注入真实版本号，避免 daemon status 显示 'unknown'
            version: readServerVersion()
        });

        io.stdout(`Local my-websearch daemon running at ${daemon.baseUrl}`);
        const signalSource = options.signalSource ?? process;

        return await new Promise<number>((resolve) => {
            let closing = false;

            const cleanup = () => {
                signalSource.removeListener('SIGINT', shutdown);
                signalSource.removeListener('SIGTERM', shutdown);
            };

            const shutdown = () => {
                if (closing) {
                    return;
                }
                closing = true;
                void daemon.close()
                    .catch((closeError) => {
                        io.stderr(`Failed to close local daemon cleanly: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
                    })
                    .finally(() => {
                        cleanup();
                        resolve(0);
                    });
            };

            signalSource.once('SIGINT', shutdown);
            signalSource.once('SIGTERM', shutdown);
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        io.stderr(`Failed to start local daemon: ${message}`);
        return 1;
    }
}
