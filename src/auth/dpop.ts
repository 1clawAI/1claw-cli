import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const configDir =
    process.env.ONECLAW_CONFIG_DIR || join(homedir(), ".config", "1claw");
const DPOP_KEY_PATH = join(configDir, "dpop-key.json");

interface StoredKeyPair {
    private: JsonWebKey;
    public: JsonWebKey;
}

let cachedKeyPair: CryptoKeyPair | null = null;
let cachedPublicJwk: JsonWebKey | null = null;

export async function getOrCreateDPoPKey(): Promise<CryptoKeyPair> {
    if (cachedKeyPair) return cachedKeyPair;

    try {
        const stored: StoredKeyPair = JSON.parse(
            readFileSync(DPOP_KEY_PATH, "utf8"),
        );
        const privateKey = await crypto.subtle.importKey(
            "jwk",
            stored.private,
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["sign"],
        );
        const publicKey = await crypto.subtle.importKey(
            "jwk",
            stored.public,
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["verify"],
        );
        cachedKeyPair = { privateKey, publicKey };
        cachedPublicJwk = stored.public;
        return cachedKeyPair;
    } catch {
        // Generate new keypair
        const keyPair = await crypto.subtle.generateKey(
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["sign", "verify"],
        );
        const privateJwk = await crypto.subtle.exportKey(
            "jwk",
            keyPair.privateKey,
        );
        const publicJwk = await crypto.subtle.exportKey(
            "jwk",
            keyPair.publicKey,
        );
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
            DPOP_KEY_PATH,
            JSON.stringify({ private: privateJwk, public: publicJwk }),
            { mode: 0o600 },
        );
        cachedKeyPair = keyPair;
        cachedPublicJwk = publicJwk;
        return keyPair;
    }
}

export async function getPublicJwk(): Promise<JsonWebKey> {
    if (cachedPublicJwk) return cachedPublicJwk;
    const kp = await getOrCreateDPoPKey();
    cachedPublicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    return cachedPublicJwk;
}

export async function generateDPoPProof(
    method: string,
    url: string,
): Promise<string> {
    const keyPair = await getOrCreateDPoPKey();
    const publicJwk = await getPublicJwk();

    const header = {
        typ: "dpop+jwt",
        alg: "ES256",
        jwk: {
            kty: publicJwk.kty,
            crv: publicJwk.crv,
            x: publicJwk.x,
            y: publicJwk.y,
        },
    };

    const payload = {
        jti: crypto.randomUUID(),
        htm: method.toUpperCase(),
        htu: stripQuery(url),
        iat: Math.floor(Date.now() / 1000),
    };

    const headerB64 = base64url(JSON.stringify(header));
    const payloadB64 = base64url(JSON.stringify(payload));
    const signingInput = `${headerB64}.${payloadB64}`;

    const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keyPair.privateKey,
        new TextEncoder().encode(signingInput),
    );

    return `${signingInput}.${base64urlFromBuffer(signature)}`;
}

export function isDPoPEnabled(): boolean {
    return process.env.ONECLAW_DPOP === "true";
}

function stripQuery(url: string): string {
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
        return url.split("?")[0];
    }
}

function base64url(str: string): string {
    return Buffer.from(str, "utf8").toString("base64url");
}

function base64urlFromBuffer(buf: ArrayBuffer): string {
    return Buffer.from(new Uint8Array(buf)).toString("base64url");
}
