import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_BODY_BYTES = 12 * 1024 * 1024;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function errorStatus(error) {
  if (error?.code === "SESSION_WRITE_CONFLICT") return 409;
  if (error?.code === "MODEL_UNAVAILABLE") return 400;
  if (/token|撤销|配对码/.test(error?.message || "")) return 401;
  if (/不存在|无效/.test(error?.message || "")) return 404;
  return 400;
}

async function readJson(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new Error("请求体过大");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch {
    const error = new Error("JSON 格式无效");
    error.status = 400;
    throw error;
  }
}

function originAllowed(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function bearer(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function staticType(file) {
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
  return "text/html; charset=utf-8";
}

export function createMobileControlServer({
  host = "127.0.0.1",
  port = 17889,
  store,
  registry,
  publicDir
} = {}) {
  if (!store || !registry) throw new Error("mobile control server 参数不完整");
  let server = null;
  let boundPort = null;
  const eventClients = new Set();
  const publicRoot = publicDir ? path.resolve(publicDir) : "";

  const sendSse = (res, event) => {
    if (res.writableEnded || res.destroyed) return;
    try { res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); } catch {}
  };
  const unsubscribeEvents = registry.subscribeEvents?.((event) => {
    for (const client of eventClients) sendSse(client.res, event);
  });

  const authenticate = (req) => store.authenticate(bearer(req));

  const serveStatic = (pathname, res) => {
    const names = {
      "/": "index.html",
      "/index.html": "index.html",
      "/app.js": "app.js",
      "/styles.css": "styles.css",
      "/manifest.webmanifest": "manifest.webmanifest",
      "/sw.js": "sw.js"
    };
    const name = names[pathname];
    if (!name || !publicRoot) return false;
    const file = path.join(publicRoot, name);
    if (!fs.existsSync(file)) return false;
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      "content-type": staticType(file),
      "content-length": body.length,
      "cache-control": "no-store"
    });
    res.end(body);
    return true;
  };

  const handle = async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = url.pathname;
    if (req.method === "GET" && serveStatic(pathname, res)) return;

    try {
      if (req.method === "POST" && pathname === "/mobile/pair/complete") {
        const body = await readJson(req);
        return json(res, 201, store.completePairing({
          challenge: body.challenge,
          name: body.name
        }));
      }
      if (!pathname.startsWith("/mobile/v1/")) return json(res, 404, { error: "not_found" });
      if (!originAllowed(req)) return json(res, 403, { error: "origin_not_allowed" });
      const device = authenticate(req);

      if (req.method === "GET" && pathname === "/mobile/v1/agents") {
        return json(res, 200, registry.agents());
      }
      if (req.method === "GET" && pathname === "/mobile/v1/models") {
        return json(res, 200, registry.availableModels(url.searchParams.get("agent") || ""));
      }
      if (req.method === "GET" && pathname === "/mobile/v1/workspaces") {
        return json(res, 200, await registry.recentWorkspaces());
      }
      if (req.method === "GET" && pathname === "/mobile/v1/workspaces/browse") {
        return json(res, 200, await registry.browseWorkspaces(url.searchParams.get("path") || ""));
      }
      if (req.method === "DELETE" && pathname === "/mobile/v1/workspaces/directories") {
        return json(res, 200, await registry.deleteWorkspaceDirectory(url.searchParams.get("path") || "", {
          force: url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true"
        }));
      }
      if (req.method === "POST" && pathname === "/mobile/v1/workspaces/directories/rename") {
        const body = await readJson(req);
        return json(res, 200, await registry.renameWorkspaceDirectory(body.path, body.name));
      }
      if (req.method === "POST" && pathname === "/mobile/v1/workspaces/directories") {
        const body = await readJson(req);
        return json(res, 201, await registry.createWorkspaceDirectory(body.parent, body.name));
      }
      if (req.method === "GET" && pathname === "/mobile/v1/sessions") {
        return json(res, 200, await registry.listSessions({
          agent: url.searchParams.get("agent") || "",
          archived: url.searchParams.get("archived") === "true"
        }));
      }
      if (req.method === "POST" && pathname === "/mobile/v1/sessions") {
        const body = await readJson(req);
        const created = await registry.createSession(body.agent, body, device.id);
        if (String(body.prompt || "").trim()) {
          // Session creation is synchronous because we need its id. The first prompt is
          // deliberately queued so a slow Agent connection cannot leave the phone waiting.
          void registry.perform(created.sessionId, "sendMessage", {
            text: body.prompt,
            messageId: body.messageId || randomUUID()
          }, device.id).catch(() => {});
        }
        return json(res, 201, created);
      }
      if (req.method === "GET" && pathname === "/mobile/v1/events") {
        const events = registry.listEvents({
          after: url.searchParams.get("after") || 0,
          sessionId: url.searchParams.get("session_id") || ""
        });
        if (String(req.headers.accept || "").includes("text/event-stream")) {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive"
          });
          for (const event of events) {
            sendSse(res, event);
          }
          if (url.searchParams.get("once") === "1") return res.end();
          const client = { res };
          eventClients.add(client);
          // Flush headers and establish the subscription before the client starts
          // waiting; otherwise a just-produced first token can race the SSE setup.
          res.write(": connected\n\n");
          const timer = setInterval(() => res.write(": keepalive\n\n"), 15_000);
          req.on("close", () => { clearInterval(timer); eventClients.delete(client); });
          return;
        }
        return json(res, 200, events);
      }
      if (req.method === "GET" && pathname === "/mobile/v1/approvals") {
        return json(res, 200, registry.listApprovals?.() || []);
      }
      const approvalMatch = pathname.match(/^\/mobile\/v1\/approvals\/([^/]+)\/resolve$/);
      if (req.method === "POST" && approvalMatch) {
        const body = await readJson(req);
        return json(res, 200, await registry.resolveApproval(
          decodeURIComponent(approvalMatch[1]),
          body.decision,
          device.id
        ));
      }
      if (req.method === "POST" && pathname === "/mobile/v1/devices/self/revoke") {
        return json(res, 200, store.revokeDevice(device.id));
      }

      const match = pathname.match(/^\/mobile\/v1\/sessions\/([^/]+)(?:\/([^/]+))?$/);
      if (!match) return json(res, 404, { error: "not_found" });
      const sessionId = decodeURIComponent(match[1]);
      const action = match[2] || "";
      if (req.method === "GET" && !action) {
        return json(res, 200, await registry.readSession(sessionId));
      }
      if (req.method === "DELETE" && !action) {
        return json(res, 200, await registry.perform(sessionId, "delete", {}, device.id));
      }
      if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
      const body = await readJson(req);
      if (action === "messages") {
        return json(res, 202, await registry.perform(sessionId, "sendMessage", {
          text: body.text,
          attachments: body.attachments,
          messageId: body.messageId
        }, device.id));
      }
      if (action === "model") {
        return json(res, 200, await registry.setSessionModel(
          sessionId,
          body.model,
          body.effort,
          device.id
        ));
      }
      if (action === "settings") {
        return json(res, 200, await registry.setSessionSettings(sessionId, {
          effort: body.effort,
          permissionMode: body.permissionMode
        }, device.id));
      }
      const allowed = new Set(["cancel", "rename", "archive", "unarchive", "fork", "compact", "pin"]);
      if (!allowed.has(action)) return json(res, 404, { error: "not_found" });
      return json(res, 200, await registry.perform(sessionId, action, body, device.id));
    } catch (error) {
      return json(res, error.status || errorStatus(error), {
        error: error.code || "mobile_control_error",
        message: error.message || String(error)
      });
    }
  };

  return {
    async start() {
      if (server) return this.status();
      server = http.createServer((req, res) => {
        handle(req, res).catch((error) => json(res, 500, {
          error: "internal_error",
          message: error?.message || String(error)
        }));
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      boundPort = server.address()?.port || port;
      return this.status();
    },
    async stop() {
      if (!server) return;
      const current = server;
      server = null;
      boundPort = null;
      for (const client of eventClients) client.res.end();
      eventClients.clear();
      unsubscribeEvents?.();
      await new Promise((resolve) => current.close(() => resolve()));
    },
    status() {
      return {
        running: Boolean(server),
        host,
        port: boundPort,
        url: boundPort ? `http://${host}:${boundPort}` : null
      };
    }
  };
}
