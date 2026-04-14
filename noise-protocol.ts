import type { Viewport } from './types.js';

export interface NoiseRequest {
    id: string;
    type: string;
    payload?: unknown;
    token?: string;
}

export interface NoiseError {
    code: string;
    message: string;
}

export interface NoiseResponse {
    id: string;
    ok: boolean;
    result?: unknown;
    error?: NoiseError;
}

export interface IdPayload {
    id: string;
}

export interface UserPayload {
    user_id?: string;
}

export interface CreateBrowserPayload extends UserPayload {
    user_id: string;
    viewport?: Viewport;
}

export const ok = (id: string, result: unknown): NoiseResponse => ({ id, ok: true, result });

export const err = (id: string, code: string, message: string): NoiseResponse => ({
    id,
    ok: false,
    error: { code, message },
});

export function parsePayload<T>(payload: unknown, guard: (value: unknown) => value is T): T {
    if (!guard(payload)) throw new Error('invalid payload');
    return payload;
}

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isViewport(value: unknown): value is Viewport {
    return isObject(value)
        && typeof value.width === 'number'
        && value.width > 0
        && typeof value.height === 'number'
        && value.height > 0;
}

export function isIdPayload(value: unknown): value is IdPayload {
    return isObject(value) && typeof value.id === 'string' && value.id.length > 0;
}

export function isUserPayload(value: unknown): value is UserPayload {
    return isObject(value) && (value.user_id === undefined || typeof value.user_id === 'string');
}

export function isCreateBrowserPayload(value: unknown): value is CreateBrowserPayload {
    return isObject(value)
        && typeof value.user_id === 'string'
        && value.user_id.length > 0
        && (value.viewport === undefined || isViewport(value.viewport));
}
