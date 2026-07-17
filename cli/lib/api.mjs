/**
 * HTTP client for the Atelier factory API — the same routes the web UI uses.
 * Supports the optional ACCESS_PASSWORD gate (unlocks via /api/access and
 * carries the atelier_access cookie) and the x-atelier-user presence header.
 */

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export class Api {
  constructor({ baseUrl = "http://localhost:7777", user = "cli", password = "" } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.user = user;
    this.password = password;
    this.cookie = "";
  }

  async req(method, path, body, retried = false) {
    const headers = { "x-atelier-user": this.user };
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(`cannot reach ${this.baseUrl} — is the factory running? (${e.cause?.code || e.message})`);
    }
    if (res.status === 401 && this.password && !retried) {
      await this.unlock();
      return this.req(method, path, body, true);
    }
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("application/json") ? await res.json().catch(() => null) : await res.text();
    if (!res.ok) throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status);
    return data;
  }

  async unlock() {
    const res = await fetch(this.baseUrl + "/api/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: this.password }),
    });
    if (!res.ok) throw new ApiError("wrong access password", 401);
    const setCookie = res.headers.get("set-cookie") || "";
    this.cookie = setCookie.split(";")[0];
  }

  // ---- board / runs
  runs(archived = false) { return this.req("GET", `/api/runs${archived ? "?archived=1" : ""}`); }
  run(id, since) { return this.req("GET", `/api/runs/${id}${since ? `?since=${encodeURIComponent(since)}` : ""}`); }
  createRun(payload) { return this.req("POST", "/api/runs", payload); }
  /** All lifecycle/gate/routing verbs go through the one multiplexer. */
  act(id, action, extra = {}) { return this.req("POST", `/api/runs/${id}/approve`, { action, ...extra }); }
  archive(id, archived = true) { return this.req("POST", `/api/runs/${id}/archive`, { archived }); }
  testDrive(id) { return this.req("POST", `/api/runs/${id}/test-drive`); }
  stopTestDrive(id) { return this.req("DELETE", `/api/runs/${id}/test-drive`); }
  reap() { return this.req("POST", "/api/reap"); }
  fileUrl(runId, p) { return `${this.baseUrl}/api/runs/${runId}/file?p=${encodeURIComponent(p)}`; }

  // ---- conductor
  conductor(id) { return this.req("GET", `/api/runs/${id}/conductor`); }
  conduct(id, action, extra = {}) { return this.req("POST", `/api/runs/${id}/conductor`, { action, ...extra }); }

  // ---- comments
  comments(id) { return this.req("GET", `/api/runs/${id}/comments`); }
  addComment(id, payload) { return this.req("POST", `/api/runs/${id}/comments`, { author: this.user, ...payload }); }
  deleteComment(id, commentId) { return this.req("DELETE", `/api/runs/${id}/comments?commentId=${encodeURIComponent(commentId)}`); }

  // ---- machines (loops)
  machines() { return this.req("GET", "/api/machines"); }
  machine(id) { return this.req("GET", `/api/machines/${id}`); }
  createMachine(payload = {}) { return this.req("POST", "/api/machines", payload); }
  saveMachine(id, payload) { return this.req("PUT", `/api/machines/${id}`, payload); }
  patchMachine(id, settings) { return this.req("PATCH", `/api/machines/${id}`, { settings }); }
  duplicateMachine(id) { return this.req("POST", `/api/machines/${id}/duplicate`); }
  generateMachine(description) { return this.req("POST", "/api/machines/generate", { description }); }
  chatMachine(id, message) { return this.req("POST", `/api/machines/${id}/chat`, { message }); }

  // ---- projects
  projects() { return this.req("GET", "/api/projects"); }
  addProject(repoPath, extra = {}) { return this.req("POST", "/api/projects", { repoPath, ...extra }); }
}

/** Model choices, mirrored from the web UI (app/lib/engine/models.ts + board). */
export const PRIMARY_MODELS = [
  { value: "ollama:glm-5.2:cloud", label: "GLM 5.2 — coding/design (text-only)" },
  { value: "ollama:qwen3-coder:480b", label: "Qwen3-Coder 480B — coding (text-only)" },
  { value: "ollama:deepseek-v3.2", label: "DeepSeek v3.2 — coding (text-only)" },
  { value: "ollama:kimi-k2.6", label: "Kimi K2.6 (multimodal)" },
  { value: "ollama:kimi-k2.7-code:cloud", label: "Kimi K2.7 Code — cloud (multimodal)" },
  { value: "claude:opus", label: "Claude Opus — solo end-to-end (multimodal)" },
  { value: "claude:sonnet", label: "Claude Sonnet 5 (multimodal)" },
];

export const VISION_MODELS = [
  { value: "ollama:kimi-k2.6", label: "Kimi K2.6 — vision/QA helper" },
  { value: "ollama:kimi-k2.7-code:cloud", label: "Kimi K2.7 Code — cloud, vision/QA" },
  { value: "ollama:gemma3:27b", label: "Gemma 3 27B — vision" },
  { value: "claude:sonnet", label: "Claude Sonnet 5 — vision" },
  { value: "claude:opus", label: "Claude Opus — vision" },
];

export const GATE_MODES = [
  { value: "all", label: "All — pause at every phase" },
  { value: "machine", label: "Loop — pause where the loop says" },
  { value: "none", label: "Auto — never pause" },
];

export const gateLabel = (m) => ({ all: "All", machine: "Loop", none: "Auto" }[m] || m || "Loop");
