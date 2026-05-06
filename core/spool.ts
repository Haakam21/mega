/**
 * Tiny TypeScript Spool client. Mirrors the surface of the Rust
 * `spool-client` crate: header-trusted `X-Client-Id`, typed wrappers
 * over `fetch`, cursor lifecycle, SSE tail.
 *
 * Bun's built-in `fetch` is enough — we don't pull `EventSource` (which
 * is browser-only and wouldn't let us set the client-id header anyway).
 * The SSE parser is intentionally minimal: data: lines until \n\n.
 */

/** Wire format mirrors `spool_types::Event`. `event_type` is the field
 *  name we use in TS; it's `type` on the wire (Rust `#[serde(rename)]`). */
export interface SpoolEvent {
  seq: number;
  ns: string;
  /** `type` on the wire. */
  type: string;
  source: string;
  id?: string | null;
  time: string;
  data: any;
  origin_host?: string | null;
}

export interface EventInput {
  ns: string;
  /** `type` on the wire. */
  type: string;
  source: string;
  id?: string;
  time?: string;
  data: any;
}

export interface Cursor {
  id: string;
  client_id: string;
  thread: string;
  name: string;
  filter_ns: string | null;
  filter_type: string | null;
  cursor_seq: number;
  created_at: string;
}

export interface CursorRead {
  events: SpoolEvent[];
  next_seq: number;
}

export interface CreateCursorRequest {
  name: string;
  filter_ns?: string;
  filter_type?: string;
}

export class SpoolClient {
  constructor(
    public readonly baseUrl: string,
    public readonly clientId: string
  ) {}

  /** Idempotent: 409 thread_already_exists is treated as success. */
  async createThread(name: string, parent?: string): Promise<void> {
    const res = await this.req("POST", "/threads", {
      body: JSON.stringify({ name, parent: parent ?? null }),
    });
    if (res.status === 409) return;
    if (!res.ok) throw await spoolError(res);
  }

  async publish(thread: string, events: EventInput[]): Promise<{ start_seq: number; end_seq: number }> {
    const path = `/threads/${encodeURIComponent(thread)}/events`;
    const res = await this.req("POST", path, {
      body: JSON.stringify({ events }),
    });
    if (!res.ok) throw await spoolError(res);
    return res.json();
  }

  /**
   * Get-or-create a cursor on `(client_id, thread, name)`. Idempotent —
   * repeat calls preserve the cursor's persisted position. Filters are
   * locked at first creation; later calls don't change them.
   */
  async createCursor(thread: string, req: CreateCursorRequest): Promise<Cursor> {
    const path = `/threads/${encodeURIComponent(thread)}/cursors`;
    const res = await this.req("POST", path, { body: JSON.stringify(req) });
    if (!res.ok) throw await spoolError(res);
    return res.json();
  }

  async ackCursor(cursorId: string, seq: number): Promise<Cursor> {
    const path = `/cursors/${encodeURIComponent(cursorId)}/ack`;
    const res = await this.req("POST", path, { body: JSON.stringify({ seq }) });
    if (!res.ok) throw await spoolError(res);
    return res.json();
  }

  /**
   * SSE tail: backfill from the cursor's persisted position then emit
   * live events. Yields events as they arrive; never auto-acks. Caller
   * decides ack semantics. Bails on AbortSignal or HTTP error.
   */
  async *tailCursor(
    cursorId: string,
    signal?: AbortSignal
  ): AsyncGenerator<SpoolEvent, void, void> {
    const path = `/cursors/${encodeURIComponent(cursorId)}/events/stream`;
    const res = await this.req("GET", path, {
      headers: { Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) throw await spoolError(res);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are terminated by a blank line; data lines start with `data:`.
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trimStart();
            if (!payload) continue;
            try {
              yield JSON.parse(payload) as SpoolEvent;
            } catch {
              // Bad frame — skip and keep going. The stream isn't framed
              // by event id, so a parse error doesn't desync subsequent
              // reads.
            }
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {}
    }
  }

  private req(
    method: string,
    path: string,
    init: { body?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "X-Client-Id": this.clientId,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    };
    return fetch(this.baseUrl + path, {
      method,
      headers,
      body: init.body,
      signal: init.signal,
    });
  }
}

async function spoolError(res: Response): Promise<Error> {
  const body = await res.text().catch(() => "");
  return new Error(`spool ${res.status}: ${body || res.statusText}`);
}
