import type { InternalArtifact } from '@bokahli/catalog';
import type { RuntimeIdentity } from '@bokahli/contracts';

/** Raw shape of the subset of llama-server /props Bokahli depends on. */
interface BackendProps {
  build_info?: string;
  model_path?: string;
  model_alias?: string;
  model_ftype?: string;
  total_slots?: number;
  default_generation_settings?: { n_ctx?: number };
  modalities?: { vision?: boolean; audio?: boolean; video?: boolean };
}

export interface BackendSlot {
  readonly id: number;
  readonly n_ctx: number;
  readonly is_processing: boolean;
}

export interface Attestation {
  readonly attested: boolean;
  /**
   * Whether the backend answered at all.
   *
   * This separates two failures that must never be conflated: a runtime that is
   * *absent* (crashed, restarting, not yet loaded) and a runtime that is
   * *present but serving something else*. The first is a health problem and is
   * transient; the second is an identity problem and is a refusal. Collapsing
   * them would either turn a crash into an accusation of substitution, or turn
   * a substitution into "try again later".
   */
  readonly reachable: boolean;
  readonly reasons: readonly string[];
  readonly build: string | null;
  readonly servedContextTokens: number | null;
  readonly totalSlots: number | null;
  readonly alias: string | null;
}

export class BackendUnavailableError extends Error {}

export interface ChatTurn {
  readonly role: string;
  readonly content: string;
}

export interface ChatParams {
  readonly messages: readonly ChatTurn[];
  readonly maxTokens?: number | undefined;
  readonly temperature?: number | undefined;
  readonly topP?: number | undefined;
}

export interface StreamEvent {
  readonly type: 'delta' | 'done';
  readonly text: string;
  readonly finishReason?: string;
  readonly timings?: BackendTimings;
  readonly usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface BackendTimings {
  readonly prompt_n?: number;
  readonly prompt_ms?: number;
  readonly prompt_per_second?: number;
  readonly predicted_n?: number;
  readonly predicted_ms?: number;
  readonly predicted_per_second?: number;
}

/**
 * Client for one loopback llama-server. Bokahli is the sole client; the backend
 * has no authentication of its own and is unreachable off-host by construction.
 */
export class LlamaBackend {
  readonly #baseUrl: string;
  readonly #pinnedBuild: string;
  readonly #timeoutMs: number;
  readonly #apiKey: string | null;

  constructor(baseUrl: string, pinnedBuild: string, apiKey: string | null = null, timeoutMs = 15000) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#pinnedBuild = pinnedBuild;
    this.#apiKey = apiKey && apiKey.length > 0 ? apiKey : null;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * llama-server sets CORS to '*' and loopback is reachable from any page in a
   * browser on this host. The backend therefore requires a key even over
   * 127.0.0.1; without it, a hostile page could drive inference directly.
   */
  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.#apiKey
      ? { ...extra, authorization: `Bearer ${this.#apiKey}` }
      : { ...extra };
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async live(): Promise<boolean> {
    try {
      const r = await this.#get('/health', 3000);
      return r.ok;
    } catch {
      return false;
    }
  }

  async props(): Promise<BackendProps> {
    const r = await this.#get('/props', this.#timeoutMs);
    if (!r.ok) throw new BackendUnavailableError(`backend /props returned ${r.status}`);
    return (await r.json()) as BackendProps;
  }

  async slots(): Promise<BackendSlot[]> {
    const r = await this.#get('/slots', this.#timeoutMs);
    if (!r.ok) return [];
    const body = (await r.json()) as BackendSlot[];
    return Array.isArray(body) ? body : [];
  }

  async metricsAvailable(): Promise<boolean> {
    try {
      const r = await this.#get('/metrics', 3000);
      return r.ok;
    } catch {
      return false;
    }
  }

  async runtimeIdentity(): Promise<RuntimeIdentity> {
    const p = await this.props();
    return {
      engine: 'llama.cpp',
      build: p.build_info ?? 'unknown',
      executableDigest: null,
      cuda: null,
      driver: null,
    };
  }

  /**
   * Verify the live backend is serving the exact artifact the catalog claims.
   *
   * This is what makes EXACT meaningful. Without attestation, Bokahli would be
   * asserting an identity it has not checked — which is indistinguishable from
   * a silent substitution.
   */
  async attest(artifact: InternalArtifact): Promise<Attestation> {
    const reasons: string[] = [];
    let p: BackendProps;
    try {
      p = await this.props();
    } catch (err) {
      return {
        attested: false,
        reachable: false,
        reasons: [`backend unreachable: ${(err as Error).message}`],
        build: null,
        servedContextTokens: null,
        totalSlots: null,
        alias: null,
      };
    }

    const build = p.build_info ?? null;
    if (this.#pinnedBuild && build !== this.#pinnedBuild) {
      reasons.push(`runtime build mismatch: pinned ${this.#pinnedBuild}, serving ${build}`);
    }
    if (p.model_path !== artifact.artifactPath) {
      reasons.push('backend is not serving the catalogued artifact path');
    }
    if (p.model_alias && p.model_alias !== artifact.runtimeAlias) {
      reasons.push(`backend alias mismatch: expected ${artifact.runtimeAlias}, got ${p.model_alias}`);
    }
    if (p.model_ftype && !p.model_ftype.toUpperCase().includes(artifact.facts.quantization)) {
      reasons.push(`quantisation mismatch: expected ${artifact.facts.quantization}, got ${p.model_ftype}`);
    }

    const n_ctx = p.default_generation_settings?.n_ctx ?? null;
    return {
      attested: reasons.length === 0,
      reachable: true,
      reasons,
      build,
      servedContextTokens: n_ctx,
      totalSlots: p.total_slots ?? null,
      alias: p.model_alias ?? null,
    };
  }

  /** Streaming chat completion. Yields deltas, then one terminal event. */
  async *chatStream(
    alias: string,
    params: ChatParams,
    signal: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const body = {
      model: alias,
      messages: params.messages,
      max_tokens: params.maxTokens ?? 512,
      temperature: params.temperature ?? 0.7,
      top_p: params.topP ?? 0.95,
      stream: true,
      stream_options: { include_usage: true },
      timings_per_token: false,
    };

    // Bound the wait for response *headers* only. A backend that has died
    // between attestation and execution leaves an accept()ing socket behind
    // just long enough to hang a caller forever; a backend that is alive but
    // slow must not be cut off mid-generation. Aborting on the header deadline
    // draws that line in the only place it can honestly be drawn.
    const headerCtrl = new AbortController();
    const onOuterAbort = (): void => headerCtrl.abort();
    signal.addEventListener('abort', onOuterAbort, { once: true });
    const headerTimer = setTimeout(() => headerCtrl.abort(), this.#timeoutMs);

    let res: Response;
    try {
      res = await fetch(`${this.#baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.#headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
        signal: headerCtrl.signal,
      });
    } catch (err) {
      if (signal.aborted) throw err; // genuine client disconnect
      throw new BackendUnavailableError(
        `backend did not respond within ${this.#timeoutMs} ms: ${(err as Error).message}`,
      );
    } finally {
      // The timer is done once headers are in; the forwarding listener is not.
      // It must outlive this block so a client disconnect mid-generation still
      // cancels the upstream request rather than orphaning it.
      clearTimeout(headerTimer);
    }

    if (!res.ok || !res.body) {
      signal.removeEventListener('abort', onOuterAbort);
      throw new BackendUnavailableError(`backend chat returned ${res.status}`);
    }

    try {
      yield* readStream(res.body);
    } finally {
      signal.removeEventListener('abort', onOuterAbort);
    }
  }

  async #get(path: string, timeoutMs: number): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(`${this.#baseUrl}${path}`, {
        signal: ctrl.signal,
        headers: this.#headers(),
      });
    } finally {
      clearTimeout(t);
    }
  }
}

/** Parse llama-server's SSE body into Bokahli stream events. */
async function* readStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason = 'stop';
    let timings: BackendTimings | undefined;
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;

        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (chunk['timings']) timings = chunk['timings'] as BackendTimings;
        if (chunk['usage']) usage = chunk['usage'] as typeof usage;
        const choices = chunk['choices'] as
          | { delta?: { content?: string }; finish_reason?: string | null }[]
          | undefined;
        const c = choices?.[0];
        if (c?.finish_reason) finishReason = c.finish_reason;
        const text = c?.delta?.content;
        if (typeof text === 'string' && text.length > 0) {
          yield { type: 'delta', text };
        }
      }
    }
    yield { type: 'done', text: '', finishReason, ...(timings ? { timings } : {}), ...(usage ? { usage } : {}) };
}
