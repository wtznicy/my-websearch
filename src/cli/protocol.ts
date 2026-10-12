export type CliEnvelopeError = {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
};

export type CliEnvelope<T> = {
    status: 'ok' | 'error';
    data: T | null;
    error: CliEnvelopeError | null;
    hint: string | null;
};

export function createSuccessEnvelope<T>(data: T): CliEnvelope<T> {
    return {
        status: 'ok',
        data,
        error: null,
        hint: null
    };
}

export function createErrorEnvelope<T = null>(
    code: string,
    message: string,
    options: {
        retryable?: boolean;
        details?: Record<string, unknown>;
        hint?: string | null;
        data?: T | null;
    } = {}
): CliEnvelope<T> {
    return {
        status: 'error',
        data: options.data ?? null,
        error: {
            code,
            message,
            retryable: options.retryable ?? false,
            details: options.details
        },
        hint: options.hint ?? null
    };
}

