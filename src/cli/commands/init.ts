import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createErrorEnvelope, createSuccessEnvelope } from '../protocol.js';
import { ErrorCode } from '../../core/errors.js';
import { CommandContext, isFlag, requireFlagValue } from '../shared.js';
import {
    buildLaunchCommand,
    buildServerEntry,
    CLIENT_TARGETS,
    type ClientId,
    type InitHost,
    parseClientIds
} from '../init/clientTargets.js';
import { applyPatch, formatEntryDiff, planPatch, type PatchAction } from '../init/patcher.js';

export type ParsedInitArgs = {
    /** 空数组表示自动探测 */
    clients: ClientId[];
    clientsExplicit: boolean;
    dryRun: boolean;
    force: boolean;
    json: boolean;
    home: string | null;
};

const INIT_USAGE = 'my-websearch init [--client claude-desktop,cursor,vscode|all] [--dry-run] [--force] [--json] [--home DIR]';

export function parseInitArgs(argv: string[]): ParsedInitArgs {
    const parsed: ParsedInitArgs = {
        clients: [],
        clientsExplicit: false,
        dryRun: false,
        force: false,
        json: false,
        home: null
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === undefined) {
            continue;
        }

        if (arg === '--json') {
            parsed.json = true;
            continue;
        }
        if (arg === '--dry-run') {
            parsed.dryRun = true;
            continue;
        }
        if (arg === '--force') {
            parsed.force = true;
            continue;
        }

        const inline = /^--([a-z-]+)=(.*)$/.exec(arg);
        const flagName = inline ? `--${inline[1] ?? ''}` : arg;

        if (flagName === '--client') {
            const rawValue = inline ? (inline[2] ?? '') : requireFlagValue(argv, index, '--client');
            if (!inline) {
                index += 1;
            }
            parsed.clients = parseClientIds(rawValue);
            parsed.clientsExplicit = true;
            continue;
        }

        if (flagName === '--home') {
            const rawValue = inline ? (inline[2] ?? '') : requireFlagValue(argv, index, '--home');
            if (!inline) {
                index += 1;
            }
            if (!rawValue) {
                throw new Error('Missing value for --home');
            }
            parsed.home = path.resolve(rawValue);
            continue;
        }

        if (isFlag(arg)) {
            throw new Error(`Unknown flag for init: ${arg}`);
        }

        throw new Error(`Unexpected argument for init: ${arg}`);
    }

    return parsed;
}

type TargetStatus = PatchAction | 'not-detected' | 'unsupported' | 'error';

type TargetReport = {
    id: ClientId;
    label: string;
    configPath: string | null;
    status: TargetStatus;
    serverKey?: string;
    previousEntry?: unknown;
    nextEntry?: Record<string, unknown>;
    backupPath?: string | null;
    error?: string;
    /** 供人读的 diff 行 */
    diffLines?: string[];
};

const statusLabel = (status: TargetStatus): string => {
    switch (status) {
        case 'create':
            return 'created';
        case 'update':
            return 'updated';
        case 'unchanged':
            return 'already up to date';
        case 'conflict':
            return 'existing entry differs';
        default:
            return status.replace('-', ' ');
    }
};

/**
 * 故意只用 ASCII 标记：Windows 旧控制台（GBK 936）下 ✔/⚠ 这类符号会渲染成 `?`，
 * 而这个命令的输出经常要被用户截图贴进 issue。
 */
const statusMarker = (status: TargetStatus): string => {
    switch (status) {
        case 'create':
        case 'update':
            return '[+]';
        case 'unchanged':
            return '[=]';
        case 'conflict':
            return '[!]';
        case 'error':
            return '[x]';
        default:
            return '[-]';
    }
};

const resolveHost = (args: ParsedInitArgs): InitHost => ({
    home: args.home ?? os.homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    env: process.env
});

const fsExists = (targetPath: string): boolean => fs.existsSync(targetPath);

const isTargetDetected = (configPath: string): boolean => (
    fsExists(configPath) || fsExists(path.dirname(configPath))
);

export async function handleInitCommand(ctx: CommandContext): Promise<number> {
    const { argv: rest, io } = ctx;

    let args: ParsedInitArgs;
    try {
        args = parseInitArgs(rest);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rest.includes('--json')) {
            io.stdout(JSON.stringify(createErrorEnvelope(
                ErrorCode.INVALID_ARGUMENTS,
                message,
                { hint: `Usage: ${INIT_USAGE}` }
            ), null, 2));
        } else {
            io.stderr(message);
            io.stderr(`Usage: ${INIT_USAGE}`);
        }
        return 1;
    }

    const host = resolveHost(args);
    const launch = buildLaunchCommand(host, process.execPath);
    const entry = buildServerEntry(launch);

    const selectedTargets = args.clientsExplicit
        ? CLIENT_TARGETS.filter((target) => args.clients.includes(target.id))
        : [...CLIENT_TARGETS];

    const reports: TargetReport[] = [];

    for (const target of selectedTargets) {
        const configPath = target.configPath(host);

        if (!configPath) {
            reports.push({
                id: target.id,
                label: target.label,
                configPath: null,
                status: 'unsupported'
            });
            continue;
        }

        if (!args.clientsExplicit && !isTargetDetected(configPath)) {
            reports.push({
                id: target.id,
                label: target.label,
                configPath,
                status: 'not-detected'
            });
            continue;
        }

        try {
            const plan = planPatch({
                configPath,
                shape: target.shape,
                entry,
                force: args.force
            });

            let backupPath: string | null = null;
            const status: TargetStatus = plan.action;
            if (!args.dryRun) {
                const applied = applyPatch(plan);
                backupPath = applied.backupPath;
            }

            reports.push({
                id: target.id,
                label: target.label,
                configPath,
                status,
                serverKey: plan.serverKey,
                previousEntry: plan.previousEntry,
                nextEntry: plan.nextEntry,
                backupPath,
                diffLines: plan.action === 'unchanged' ? [] : formatEntryDiff(plan)
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            reports.push({
                id: target.id,
                label: target.label,
                configPath,
                status: 'error',
                error: message
            });
        }
    }

    const written = reports.filter((report) => report.status === 'create' || report.status === 'update').length;
    const conflicts = reports.filter((report) => report.status === 'conflict').length;
    const unchanged = reports.filter((report) => report.status === 'unchanged').length;
    const failed = reports.filter((report) => report.status === 'error').length;
    const notDetected = reports.filter((report) => report.status === 'not-detected').length;

    if (args.json) {
        io.stdout(JSON.stringify(
            failed > 0
                ? createErrorEnvelope(
                    ErrorCode.INVALID_ARGUMENTS,
                    `init failed for ${failed} target(s).`,
                    {
                        details: { dryRun: args.dryRun, launch, targets: reports },
                        hint: `Usage: ${INIT_USAGE}`
                    }
                )
                : createSuccessEnvelope({
                    dryRun: args.dryRun,
                    launch,
                    targets: reports,
                    summary: { written, unchanged, conflicts, failed, notDetected }
                }),
            null,
            2
        ));
        return failed > 0 ? 1 : 0;
    }

    const lines: string[] = ['my-websearch init', ''];
    for (const report of reports) {
        lines.push(`${statusMarker(report.status)} ${report.label} — ${statusLabel(report.status)}`);
        if (report.configPath) {
            lines.push(`    ${report.configPath}`);
        }
        for (const diffLine of report.diffLines ?? []) {
            lines.push(diffLine);
        }
        if (report.backupPath) {
            lines.push(`    backup: ${path.basename(report.backupPath)}`);
        }
        if (report.error) {
            lines.push(`    ${report.error}`);
        }
        lines.push('');
    }

    if (launch.warning) {
        lines.push(`[!] ${launch.warning}`, '');
    }

    if (notDetected === reports.length) {
        lines.push('No supported client was detected on this machine.');
        lines.push('Pass --client to configure one explicitly, or paste the block below yourself:', '');
        for (const target of CLIENT_TARGETS) {
            const configPath = target.configPath(host);
            if (!configPath) {
                continue;
            }
            lines.push(`  ${target.label}: ${configPath}`);
            const snippet = target.shape === 'mcpServers'
                ? { mcpServers: { 'my-websearch': entry } }
                : { servers: { 'my-websearch': entry } };
            lines.push(`    ${JSON.stringify(snippet)}`, '');
        }
    } else {
        lines.push(`Summary: ${written} written, ${unchanged} already correct, ${conflicts} conflict(s), ${notDetected} not detected.`);
        if (conflicts > 0) {
            lines.push('Existing entries were left untouched. Re-run with --force to overwrite them (a .bak backup is kept).');
        }
        if (args.dryRun) {
            lines.push('Dry run: nothing was written. Re-run without --dry-run to apply these changes.');
        } else if (written > 0) {
            lines.push('Restart the affected client(s), then verify with: my-websearch doctor');
        }
    }

    io.stdout(lines.join('\n'));
    return failed > 0 ? 1 : 0;
}
