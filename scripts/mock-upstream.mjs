// Stands in for api.bankr.bot: echoes which X-API-Key it received, so the
// test can assert the daemon injected the vault's value and not the tool's.
import { createServer } from "node:http";
const port = Number(process.env.PORT ?? 4125);
createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, method: req.method, x_api_key: req.headers["x-api-key"] ?? null, authorization: req.headers.authorization ?? null, body: raw || null }));
  });
}).listen(port, "127.0.0.1", () => console.log(`mock upstream on ${port}`));
