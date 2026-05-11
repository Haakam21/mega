/**
 * Shared Bun HTTP server for inbound webhook channels.
 *
 * exe.dev only forwards one public port per VM, so all webhook receivers
 * (Linear, AgentMail, Slack) share port 8000 and route by path. Each
 * channel module exports a `routes()` function that returns a
 * `{ [path]: handler }` map; `startHttpServer` composes them and runs
 * a single `Bun.serve`.
 *
 * Path matching is exact. `/health` is built in. Anything else returns
 * 404. The handler gets the raw `Request` so Svix-style verification
 * (which needs the unparsed body) just works.
 */

import { parsePositiveInt } from "./env";

export type RouteHandler = (req: Request) => Promise<Response>;

const DEFAULT_PORT = 8000;

export function startHttpServer(
  routes: Record<string, RouteHandler>
): void {
  const port = parsePositiveInt("MEGA_HTTP_PORT", DEFAULT_PORT);

  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/health") {
        return new Response("ok", { status: 200 });
      }

      const handler = routes[url.pathname];
      if (!handler) {
        return new Response("Not Found", { status: 404 });
      }

      try {
        return await handler(req);
      } catch (e) {
        console.error(`[http] ${url.pathname} handler threw:`, e);
        return new Response("Internal Error", { status: 500 });
      }
    },
  });

  const paths = Object.keys(routes).sort().join(", ");
  console.log(`[http] listening on port ${port}; routes: /health, ${paths}`);
}
