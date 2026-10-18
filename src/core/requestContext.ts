import crypto from 'node:crypto';
import { AppError } from './errors.js';

export interface RequestContextOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    deadlineAt?: number;
    traceId?: string;
    tokenBudget?: number;
}

export interface RequestContext {
    readonly traceId: string;
    readonly signal?: AbortSignal;
    readonly deadlineAt?: number;
    readonly tokenBudget?: number;
    readonly warnings: string[];
    addWarning(warning: string): void;
    isExpired(): boolean;
    remainingMs(): number;
    createChildSignal(timeoutMs?: number): { signal: AbortSignal; cleanup: () => void };
}

export class DefaultRequestContext implements RequestContext {
    public readonly traceId: string;
    public readonly signal?: AbortSignal;
    public readonly deadlineAt?: number;
    public readonly tokenBudget?: number;
    public readonly warnings: string[] = [];

    constructor(options: RequestContextOptions = {}) {
        this.traceId = options.traceId || crypto.randomUUID().slice(0, 8);
        this.signal = options.signal;
        this.tokenBudget = options.tokenBudget;

        if (typeof options.deadlineAt === 'number') {
            this.deadlineAt = options.deadlineAt;
        } else if (typeof options.timeoutMs === 'number') {
            this.deadlineAt = Date.now() + options.timeoutMs;
        }
    }

    public addWarning(warning: string): void {
        const trimmed = warning.trim();
        if (trimmed && !this.warnings.includes(trimmed)) {
            this.warnings.push(trimmed);
        }
    }

    public isExpired(): boolean {
        if (this.signal?.aborted) {
            return true;
        }
        if (this.deadlineAt !== undefined && Date.now() >= this.deadlineAt) {
            return true;
        }
        return false;
    }

    public remainingMs(): number {
        if (this.deadlineAt === undefined) {
            return Infinity;
        }
        return Math.max(0, this.deadlineAt - Date.now());
    }

    public createChildSignal(timeoutMs?: number): { signal: AbortSignal; cleanup: () => void } {
        const controller = new AbortController();
        const effectiveTimeout = timeoutMs !== undefined
            ? Math.min(timeoutMs, this.remainingMs())
            : this.remainingMs();

        let timer: NodeJS.Timeout | undefined;
        if (Number.isFinite(effectiveTimeout) && effectiveTimeout > 0) {
            timer = setTimeout(() => {
                controller.abort(new AppError({
                    code: 'network_timeout',
                    message: `Operation timed out after ${effectiveTimeout}ms [trace: ${this.traceId}]`,
                    retryable: true
                }));
            }, effectiveTimeout);
            if (typeof timer === 'object' && typeof timer.unref === 'function') {
                timer.unref();
            }
        }

        const onParentAbort = () => {
            controller.abort(this.signal?.reason ?? new AppError({
                code: 'aborted',
                message: `Parent request aborted [trace: ${this.traceId}]`,
                retryable: false
            }));
        };

        if (this.signal) {
            if (this.signal.aborted) {
                onParentAbort();
            } else {
                this.signal.addEventListener('abort', onParentAbort, { once: true });
            }
        }

        const cleanup = () => {
            if (timer) {
                clearTimeout(timer);
            }
            if (this.signal) {
                this.signal.removeEventListener('abort', onParentAbort);
            }
        };

        return { signal: controller.signal, cleanup };
    }
}

export function createRequestContext(
    signalOrOptions?: AbortSignal | RequestContextOptions,
    options: Omit<RequestContextOptions, 'signal'> = {}
): RequestContext {
    if (signalOrOptions && (signalOrOptions instanceof AbortSignal || typeof (signalOrOptions as AbortSignal).aborted === 'boolean')) {
        return new DefaultRequestContext({
            ...options,
            signal: signalOrOptions as AbortSignal
        });
    }
    if (signalOrOptions && typeof signalOrOptions === 'object') {
        return new DefaultRequestContext(signalOrOptions as RequestContextOptions);
    }
    return new DefaultRequestContext();
}
