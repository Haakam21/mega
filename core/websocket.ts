export interface WebSocketOptions {
  url: string | (() => Promise<string>);
  label: string;
  onOpen?: (ws: WebSocket) => void;
  onMessage: (data: any, ws: WebSocket) => void;
  reconnectMs?: number;
}

export interface WebSocketHandle {
  close: () => void;
}

export function connectWebSocket(options: WebSocketOptions): WebSocketHandle {
  const { label, onOpen, onMessage, reconnectMs = 5000 } = options;
  let stopped = false;
  let currentWs: WebSocket | null = null;

  async function connect() {
    if (stopped) return;
    const url =
      typeof options.url === "function" ? await options.url() : options.url;
    if (stopped) return;
    const ws = new WebSocket(url);
    currentWs = ws;

    ws.addEventListener("open", () => {
      if (onOpen) onOpen(ws);
    });

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data as string);
        onMessage(data, ws);
      } catch (err) {
        console.error(`[${label}] Error handling event:`, err);
      }
    });

    ws.addEventListener("close", () => {
      if (stopped) return;
      console.log(`[${label}] WebSocket closed. Reconnecting in ${reconnectMs / 1000}s...`);
      setTimeout(connect, reconnectMs);
    });

    ws.addEventListener("error", (err) => {
      if (stopped) return;
      console.error(`[${label}] WebSocket error:`, err);
    });
  }

  connect();

  return {
    close: () => {
      stopped = true;
      currentWs?.close();
    },
  };
}
