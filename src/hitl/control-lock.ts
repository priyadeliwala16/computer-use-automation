import http from "node:http";
import type { AddressInfo } from "node:net";
import type { InterventionRequest } from "./types.js";

/** How a paused escalation ended. Mirrors `EscalationDecision` in src/agent/loop.ts one level
 *  up: "resumed"/"aborted" map to `{action:"resume"}`/`{action:"abort"}`; "timeout" is really
 *  just an unattended abort, kept distinct so the caller can log *why* it gave up. */
export type ControlLockOutcome =
  | { outcome: "resumed"; notes?: string }
  | { outcome: "aborted"; notes?: string }
  | { outcome: "timeout" };

/**
 * The "pause signal + a tiny CLI/HTTP operator" mechanism (the chosen HITL architecture, §3.6).
 * Opened by the `discover` CLI the moment a run escalates: it starts a small loopback-only HTTP
 * server exposing the current `InterventionRequest` — including the live browser's
 * `cdpEndpoint` — and then blocks until either a human operator process calls `POST /resume` (or
 * `/abort`), or `waitForOperator`'s timeout elapses first.
 *
 * Deliberately plain `node:http`, no framework: this is a two-endpoint, localhost-only,
 * single-consumer control surface for a single paused run — a dependency would buy nothing.
 * Deliberately HTTP rather than e.g. a lock file polled on an interval: a human waiting on the
 * other end benefits from `GET /intervention` being a normal, immediately-inspectable request
 * (curl-able, no polling latency, no partial-write races to guard against).
 */
export class ControlLock {
  private readonly server: http.Server;
  private settleOutcome?: (outcome: ControlLockOutcome) => void;
  private readonly outcomeReady: Promise<ControlLockOutcome>;
  private request: InterventionRequest;

  private constructor(request: InterventionRequest) {
    this.request = request;
    this.outcomeReady = new Promise((resolve) => {
      this.settleOutcome = resolve;
    });
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  /**
   * Starts listening on an OS-assigned loopback port and returns the lock with
   * `intervention.controlPort` already filled in — the one field the caller can't know until
   * the server actually binds a port, so it can't be included in the object the caller passes
   * in up front.
   */
  static async open(request: Omit<InterventionRequest, "controlPort">): Promise<ControlLock> {
    const lock = new ControlLock({ ...request, controlPort: 0 });
    await new Promise<void>((resolve, reject) => {
      lock.server.once("error", reject);
      lock.server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = lock.server.address() as AddressInfo;
    lock.request = { ...lock.request, controlPort: port };
    return lock;
  }

  /** The current `InterventionRequest`, with `controlPort` resolved — this is what the caller
   *  should persist to disk / print for the operator to read. */
  get intervention(): InterventionRequest {
    return this.request;
  }

  /**
   * Blocks until an operator resumes or aborts, or `timeoutMs` elapses first (an unattended
   * escalation must still eventually give up — it can't hang the process forever). Safe to call
   * exactly once per lock.
   */
  async waitForOperator(timeoutMs: number): Promise<ControlLockOutcome> {
    const timer = setTimeout(() => this.settleOutcome?.({ outcome: "timeout" }), timeoutMs);
    try {
      return await this.outcomeReady;
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    // `server.close()` alone only stops accepting new connections — it waits for existing
    // sockets to close on their own first, and a client using keep-alive (e.g. undici's default
    // fetch()) can leave an idle socket open well past when we're done with it, stalling this
    // for the rest of Node's default 5s keepAliveTimeout. closeAllConnections() (Node >=18.2)
    // destroys open sockets immediately so this actually resolves promptly.
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === "GET" && req.url === "/intervention") {
      this.respondJson(res, 200, this.request);
      return;
    }
    if (req.method === "POST" && (req.url === "/resume" || req.url === "/abort")) {
      void this.readJsonBody(req).then((body) => {
        const notes = typeof body?.notes === "string" ? body.notes : undefined;
        const outcome: ControlLockOutcome = req.url === "/resume" ? { outcome: "resumed", notes } : { outcome: "aborted", notes };
        // Idempotent by construction: settleOutcome resolves a promise, so a second call (e.g.
        // a retried request) is a harmless no-op rather than a double-resume.
        this.settleOutcome?.(outcome);
        this.respondJson(res, 200, { ok: true });
      });
      return;
    }
    this.respondJson(res, 404, { error: "not found" });
  }

  private respondJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | undefined> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf-8");
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined; // malformed body is not fatal — we still honor the resume/abort intent
    }
  }
}
