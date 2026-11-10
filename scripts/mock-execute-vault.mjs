// A stand-in for POST /v1/agents/{id}/execute, for the binding-proxy test.
// It records what the proxy forwarded so the test can assert that the
// tool's own credential never left the machine.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4123);
createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    // The proxy exchanges the agent key for a JWT; the execute route only takes the JWT.
    if (req.url === "/v1/auth/agent-token" && req.method === "POST") {
      const ok = JSON.parse(raw).api_key === "ocv_test_key";
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      return res.end(JSON.stringify(ok ? { access_token: "agent_jwt", expires_in: 900 } : { detail: "bad agent key" }));
    }
    const m = req.url?.match(/^\/v1\/agents\/([^/]+)\/execute$/);
    if (!m || req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ detail: "not found" }));
    }
    if (req.headers.authorization !== "Bearer agent_jwt") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ detail: "bad agent token" }));
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
        status: "success", // ExecuteResponse.status (handlers/bindings.rs)
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
