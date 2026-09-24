/**
 * A stand-in for Shroud that reflects what it was sent back as JSON, so tests
 * can assert on what the proxy actually forwarded — the Shroud headers it
 * injected and the request body after any rewriting — rather than only on
 * what the proxy returned to the client.
 *
 * PORT env var, default 4599.
 */
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4599);

createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
            JSON.stringify({
                path: req.url,
                method: req.method,
                provider: req.headers["x-shroud-provider"] ?? null,
                model_header: req.headers["x-shroud-model"] ?? null,
                has_agent_key: Boolean(req.headers["x-shroud-agent-key"]),
                body: Buffer.concat(chunks).toString(),
            }),
        );
    });
}).listen(port, "127.0.0.1", () => {
    console.log(`echo upstream on ${port}`);
});
