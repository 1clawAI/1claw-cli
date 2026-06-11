import { getApiUrl, getToken } from "./config.js";
import { isDPoPEnabled, generateDPoPProof, getPublicJwk } from "./auth/dpop.js";

export class ApiError extends Error {
    constructor(
        public status: number,
        public detail: string,
        public code?: string,
    ) {
        super(`${status}: ${detail}`);
        this.name = "ApiError";
    }
}

async function parseErrorBody(
    res: Response,
): Promise<{ detail: string; code?: string }> {
    try {
        const body = (await res.json()) as Record<string, string>;
        return {
            detail: body.detail ?? body.message ?? body.error ?? res.statusText,
            code: body.code,
        };
    } catch {
        return { detail: res.statusText };
    }
}

export async function api<T = unknown>(
    path: string,
    options: {
        method?: string;
        body?: unknown;
        token?: string;
        query?: Record<string, string | number | boolean | undefined>;
        headers?: Record<string, string>;
    } = {},
): Promise<T> {
    const baseUrl = getApiUrl();
    const token = options.token ?? getToken();
    const url = new URL(`/v1${path}`, baseUrl);

    if (options.query) {
        for (const [k, v] of Object.entries(options.query)) {
            if (v !== undefined) url.searchParams.set(k, String(v));
        }
    }

    const method = options.method ?? "GET";
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "@1claw/cli",
        ...options.headers,
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    if (isDPoPEnabled()) {
        headers["DPoP"] = await generateDPoPProof(method, url.toString());
    }

    const res = await fetch(url.toString(), {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
        const err = await parseErrorBody(res);
        throw new ApiError(res.status, err.detail, err.code);
    }

    if (res.status === 204) return undefined as T;

    return res.json() as Promise<T>;
}

export async function apiNoAuth<T = unknown>(
    path: string,
    options: {
        method?: string;
        body?: unknown;
        query?: Record<string, string | number | boolean | undefined>;
    } = {},
): Promise<T> {
    return api<T>(path, { ...options, token: "" });
}
