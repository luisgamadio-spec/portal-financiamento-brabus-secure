// Cliente mínimo de RPC do Supabase (PostgREST) usando o JWT DO USUÁRIO.
// Nunca usa service role: toda autorização continua no banco (auth.uid()).

export class RpcError extends Error {
  constructor(public fn: string, public status: number, public code: string | null, msg: string) {
    super(msg);
  }
  /** Erro de permissão do Postgres (42501) ou HTTP 401/403. */
  get negado(): boolean {
    return this.code === "42501" || this.status === 401 || this.status === 403;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class Rpc {
  constructor(
    private url: string,
    private apikey: string,
    private jwt: string,
    private fetchImpl: FetchLike = fetch,
    private timeoutMs = 8000,
  ) {}

  async call<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.url}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: {
          apikey: this.apikey,
          Authorization: `Bearer ${this.jwt}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(args),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let body: any = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (!res.ok) {
        throw new RpcError(fn, res.status, body?.code ?? null, body?.message ?? `HTTP ${res.status}`);
      }
      return body as T;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      if ((e as Error).name === "AbortError") throw new RpcError(fn, 504, null, "Tempo esgotado ao consultar o Portal.");
      throw new RpcError(fn, 502, null, (e as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Insere numa tabela via PostgREST (sujeito a RLS do usuário). */
  async insert(table: string, row: Record<string, unknown>): Promise<void> {
    const res = await this.fetchImpl(`${this.url}/rest/v1/${table}`, {
      method: "POST", signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        apikey: this.apikey, Authorization: `Bearer ${this.jwt}`,
        "Content-Type": "application/json", Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) throw new RpcError(table, res.status, null, await res.text());
  }

  /** Lê de uma tabela via PostgREST (sujeito a RLS do usuário). */
  async select<T = unknown>(table: string, query: string): Promise<T[]> {
    const res = await this.fetchImpl(`${this.url}/rest/v1/${table}?${query}`, {
      headers: { apikey: this.apikey, Authorization: `Bearer ${this.jwt}`, Accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new RpcError(table, res.status, null, await res.text());
    return await res.json();
  }
}
