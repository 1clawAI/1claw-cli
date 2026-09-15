// A stand-in for POST /v1/agents/{id}/execute, for the binding-proxy test.
// It records what the proxy forwarded so the test can assert that the
// tool's own credential never left the machine.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4123);
createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const m = req.url?.match(/^\/v1\/agents\/([^/]+)\/execute$/);
    if (!m || req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ detail: "not found" }));
    }
    if (req.headers.authorization !== "Bearer ocv_test_key") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ detail: "bad agent key" }));
    }
    const body = JSON.parse(raw);
    const p = body.params ?? {};
    const forwardedHeaders = Object.keys(p.headers ?? {}).map((h) => h.toLowerCase());
    if (p.path === "/agent/denied") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ execution_id: "e2", status: "denied", error: "path not in allowlist" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        execution_id: "e1",
        status: "completed",
        result: {
          status: 200,
          headers: { "content-type": "application/json" },
          body: {
            echoed: { binding: body.binding, method: p.method, path: p.path, body: p.body ?? null },
            forwarded_headers: forwardedHeaders,
            leaked_credential: forwardedHeaders.includes("x-api-key") || forwardedHeaders.includes("authorization"),
          },
        },
      }),
    );
  });
}).listen(port, "127.0.0.1", () => console.log(`mock vault on ${port}`));
