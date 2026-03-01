import { NextFunction, Request, Response } from 'express';
import { logger } from '@deepiri/shared-utils';

const secureLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown): void => {
    const logMethod = (logger as any)[level] ?? logger.info;
    if (meta !== undefined) {
        logMethod(message, meta);
        return;
    }
    logMethod(message);
};

type BodyValidator = (body: Record<string, unknown>) => string | null;
type QueryValidator = (query: Record<string, unknown>) => string | null;
type HeaderValidator = (headers: Record<string, unknown>) => string | null;

interface BodyValidationOptions {
    required?: boolean;
    allowedFields?: string[];
    validators?: BodyValidator[];
    sanitizeBody?: boolean;
}

interface QueryValidationOptions {
    required?: boolean;
    allowedFields?: string[];
    validators?: QueryValidator[];
    sanitizeQuery?: boolean;
}

interface HeaderValidationOptions {
    allowedFields?: string[];
    validators?: HeaderValidator[];
    sanitizeHeaders?: boolean;
}

const APP_HEADER_PREFIX = 'x-';

const getAppHeaders = (headers: Record<string, unknown>): Record<string, unknown> => {
    const appHeaders: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(headers)) {
        const normalized = key.toLowerCase();
        if (normalized === 'authorization' || normalized.startsWith(APP_HEADER_PREFIX)) {
            appHeaders[normalized] = value;
        }
    }

    return appHeaders;
};

const respondValidationError = (
    req: Request,
    res: Response,
    errors: Array<{ field: string; message: string; value?: unknown }>,
    context: string
): void => {
    const requestId = (req.headers['x-request-id'] as string) || 'unknown';

    secureLog('warn', `${context} validation failed`, {
        requestId,
        path: req.path,
        method: req.method,
        errors,
    });

    res.status(400).json({
        success: false,
        message: 'Validation failed',
        requestId,
        timestamp: new Date().toISOString(),
        errors,
    });
};

const sanitizeValue = (value: unknown): unknown => {
    if (typeof value === 'string') {
        return value.trim();
    }

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeValue(item));
    }

    if (value && typeof value === 'object') {
        const sanitizedRecord: Record<string, unknown> = {};
        for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
            sanitizedRecord[key] = sanitizeValue(nestedValue);
        }
        return sanitizedRecord;
    }

    return value;
};

export const validateBody = (options: BodyValidationOptions = {}) => {
    return (req: Request, res: Response, next: NextFunction): void => {
        const requestId = (req.headers['x-request-id'] as string) || 'unknown';
        const errors: Array<{ field: string; message: string; value?: unknown }> = [];

        if (options.required && (req.body === undefined || req.body === null)) {
            errors.push({
                field: 'body',
                message: 'Request body is required',
            });
        }

        if (req.body !== undefined && req.body !== null) {
            if (typeof req.body !== 'object' || Array.isArray(req.body)) {
                errors.push({
                    field: 'body',
                    message: 'Request body must be a JSON object',
                    value: req.body,
                });
            } else {
                if (options.allowedFields) {
                    const unknownFields = Object.keys(req.body).filter(
                        (field) => !options.allowedFields?.includes(field)
                    );

                    if (unknownFields.length > 0) {
                        errors.push({
                            field: 'body',
                            message: `Unknown body fields provided: ${unknownFields.join(', ')}`,
                            value: unknownFields,
                        });
                    }
                }

                if (options.validators) {
                    for (const validator of options.validators) {
                        const message = validator(req.body as Record<string, unknown>);
                        if (message) {
                            errors.push({
                                field: 'body',
                                message,
                            });
                        }
                    }
                }

                if (options.sanitizeBody !== false) {
                    req.body = sanitizeValue(req.body);
                }
            }
        }

        if (errors.length > 0) {
            respondValidationError(req, res, errors, 'Body');
            return;
        }

        next();
    };
};

export const validateQuery = (options: QueryValidationOptions = {}) => {
    return (req: Request, res: Response, next: NextFunction): void => {
        const errors: Array<{ field: string; message: string; value?: unknown }> = [];
        const queryAsObject = req.query as unknown as Record<string, unknown>;
        const queryKeys = Object.keys(queryAsObject);

        if (options.required && queryKeys.length === 0) {
            errors.push({
                field: 'query',
                message: 'Query parameters are required',
            });
        }

        if (queryKeys.length > 0) {
            if (options.allowedFields) {
                const unknownFields = queryKeys.filter((field) => !options.allowedFields?.includes(field));
                if (unknownFields.length > 0) {
                    errors.push({
                        field: 'query',
                        message: `Unknown query fields provided: ${unknownFields.join(', ')}`,
                        value: unknownFields,
                    });
                }
            }

            if (options.validators) {
                for (const validator of options.validators) {
                    const message = validator(queryAsObject);
                    if (message) {
                        errors.push({
                            field: 'query',
                            message,
                        });
                    }
                }
            }

            if (options.sanitizeQuery !== false) {
                req.query = sanitizeValue(queryAsObject) as Request['query'];
            }
        }

        if (errors.length > 0) {
            respondValidationError(req, res, errors, 'Query');
            return;
        }

        next();
    };
};

export const validateHeaders = (options: HeaderValidationOptions = {}) => {
    return (req: Request, res: Response, next: NextFunction): void => {
        const errors: Array<{ field: string; message: string; value?: unknown }> = [];
        const appHeaders = getAppHeaders(req.headers as unknown as Record<string, unknown>);

        if (options.allowedFields) {
            const unknownFields = Object.keys(appHeaders).filter((field) => !options.allowedFields?.includes(field));
            if (unknownFields.length > 0) {
                errors.push({
                    field: 'headers',
                    message: `Unknown headers provided: ${unknownFields.join(', ')}`,
                    value: unknownFields,
                });
            }
        }

        if (options.validators) {
            for (const validator of options.validators) {
                const message = validator(appHeaders);
                if (message) {
                    errors.push({
                        field: 'headers',
                        message,
                    });
                }
            }
        }

        if (options.sanitizeHeaders !== false) {
            for (const [key, value] of Object.entries(appHeaders)) {
                (req.headers as Record<string, unknown>)[key] = sanitizeValue(value);
            }
        }

        if (errors.length > 0) {
            respondValidationError(req, res, errors, 'Header');
            return;
        }

        next();
    };
};

export const validateRedisDirectBody: BodyValidator = (body: Record<string, unknown>): string | null => {
    if (!body.key || typeof body.key !== 'string' || body.key.trim().length === 0) {
        return 'key is required and must be a non-empty string';
    }

    if (body.value !== undefined && typeof body.value !== 'string') {
        return 'value must be a string when provided';
    }

    if (body.iterations !== undefined) {
        const iterations = Number(body.iterations);
        if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1000) {
            return 'iterations must be an integer between 1 and 1000';
        }

        body.iterations = iterations;
    }

    body.key = (body.key as string).trim();
    return null;
};

export const validateDbQueryParams: QueryValidator = (query: Record<string, unknown>): string | null => {
    if (query.cache !== undefined) {
        const cache = String(query.cache).trim().toLowerCase();
        if (cache !== 'true' && cache !== 'false') {
            return 'cache must be true or false when provided';
        }
        query.cache = cache;
    }

    if (query.iterations !== undefined) {
        const iterations = Number(query.iterations);
        if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1000) {
            return 'iterations must be an integer between 1 and 1000';
        }
        query.iterations = iterations;
    }

    return null;
};

export const validateDbComparisonQueryParams: QueryValidator = (query: Record<string, unknown>): string | null => {
    if (query.iterations !== undefined) {
        const iterations = Number(query.iterations);
        if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1000) {
            return 'iterations must be an integer between 1 and 1000';
        }
        query.iterations = iterations;
    }

    return null;
};
