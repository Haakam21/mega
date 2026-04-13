import { describe, test, expect, afterEach } from "bun:test";
import { connectWebSocket, type WebSocketHandle } from "./websocket";

function startServer(): { server: ReturnType<typeof Bun.serve>; port: number } {
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response("Not a WebSocket request", { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "hello" }));
      },
      message(ws, msg) {
        ws.send(msg);
      },
      close() {},
    },
  });
  return { server, port: server.port };
}

let servers: ReturnType<typeof Bun.serve>[] = [];
let handles: WebSocketHandle[] = [];

afterEach(() => {
  for (const h of handles) h.close();
  handles = [];
  for (const s of servers) s.stop(true);
  servers = [];
});

describe("connectWebSocket", () => {
  test("connects and receives messages", async () => {
    const { server, port } = startServer();
    servers.push(server);

    const received: any[] = [];

    await new Promise<void>((resolve) => {
      const handle = connectWebSocket({
        url: `ws://localhost:${port}`,
        label: "test",
        onMessage: (data) => {
          received.push(data);
          if (data.type === "hello") resolve();
        },
      });
      handles.push(handle);
    });

    expect(received.length).toBe(1);
    expect(received[0].type).toBe("hello");
  });

  test("calls onOpen with WebSocket instance", async () => {
    const { server, port } = startServer();
    servers.push(server);

    let openCalled = false;

    await new Promise<void>((resolve) => {
      const handle = connectWebSocket({
        url: `ws://localhost:${port}`,
        label: "test",
        onOpen: (ws) => {
          openCalled = true;
          expect(ws).toBeDefined();
        },
        onMessage: () => resolve(),
      });
      handles.push(handle);
    });

    expect(openCalled).toBe(true);
  });

  test("supports async URL function", async () => {
    const { server, port } = startServer();
    servers.push(server);

    let urlFnCalled = false;

    await new Promise<void>((resolve) => {
      const handle = connectWebSocket({
        url: async () => {
          urlFnCalled = true;
          return `ws://localhost:${port}`;
        },
        label: "test",
        onMessage: () => resolve(),
      });
      handles.push(handle);
    });

    expect(urlFnCalled).toBe(true);
  });

  test("passes WebSocket to onMessage for sending", async () => {
    const { server, port } = startServer();
    servers.push(server);

    const received: any[] = [];

    await new Promise<void>((resolve) => {
      const handle = connectWebSocket({
        url: `ws://localhost:${port}`,
        label: "test",
        onMessage: (data, ws) => {
          received.push(data);
          if (data.type === "hello") {
            ws.send(JSON.stringify({ type: "ping" }));
          }
          if (data.type === "ping") {
            resolve();
          }
        },
      });
      handles.push(handle);
    });

    expect(received).toEqual([{ type: "hello" }, { type: "ping" }]);
  });

  test("reconnects on close", async () => {
    let connectionCount = 0;

    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("Not a WebSocket request", { status: 400 });
      },
      websocket: {
        open(ws) {
          connectionCount++;
          ws.send(JSON.stringify({ type: "hello", count: connectionCount }));
          if (connectionCount === 1) {
            setTimeout(() => ws.close(), 50);
          }
        },
        message() {},
        close() {},
      },
    });
    servers.push(server);

    await new Promise<void>((resolve) => {
      const handle = connectWebSocket({
        url: `ws://localhost:${server.port}`,
        label: "test",
        reconnectMs: 100,
        onMessage: (data) => {
          if (data.count === 2) resolve();
        },
      });
      handles.push(handle);
    });

    expect(connectionCount).toBe(2);
  });

  test("close() stops reconnection", async () => {
    const { server, port } = startServer();
    servers.push(server);

    const handle = await new Promise<WebSocketHandle>((resolve) => {
      const h = connectWebSocket({
        url: `ws://localhost:${port}`,
        label: "test",
        onMessage: () => resolve(h),
      });
      handles.push(h);
    });

    handle.close();
    // If close works, no further reconnect attempts after server stops
  });
});
