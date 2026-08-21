import type { InternalArtifact } from '@bokahli/catalog';
import type { RuntimeIdentity } from '@bokahli/contracts';

/**
 * Does the runtime's reported file type describe the catalogued quantisation?
 *
 * llama.cpp reports a display string, not the GGUF quant name: `Q4_K_M` comes
 * back as `Q4_K - Medium`, `IQ3_XXS` as `IQ3_XXS - 3.0625 bpw`, and — the case
 * that makes any naive rule wrong — plain `Q2_K` also comes back as
 * `Q2_K - Medium`.
 *
 * The previous check was `ftype.toUpperCase().includes(quantisation)`. It said
 * no to a correctly loaded `Q4_K_M`, because `Q4_K - MEDIUM` does not contain
 * `Q4_K_M`; and it said yes to things it should have caught, because
 * `Q4_K - Small` does contain `Q4_K`, so a small-quant artifact catalogued as
 * a medium one attested clean.
 *
 * Both sides are parsed instead of pattern-matched. The family must match
 * exactly, and where both sides state a size, the sizes must correspond. Where
 * the catalogue states no size — `Q2_K`, `Q6_K`, `IQ3_XXS` — the family alone
 * decides, because there is no finer claim to check.
 */
const FTYPE_SIZE_WORD: Readonly<Record<string, string>> = {
  SMALL: 'S',
  MEDIUM: 'M',
  LARGE: 'L',
  'EXTRA SMALL': 'XS',
};

export function quantisationAgrees(catalogued: string, reportedFtype: string): boolean {
  const reported = reportedFtype.toUpperCase().trim();
  const dash = reported.indexOf(' - ');
  const reportedFamily = (dash === -1 ? reported : reported.slice(0, dash)).trim();
  const qualifier = dash === -1 ? '' : reported.slice(dash + 3).trim();
  // A bits-per-weight qualifier states no size letter; it is descriptive only.
  const reportedSize = /BPW$/.test(qualifier) ? null : (FTYPE_SIZE_WORD[qualifier] ?? null);

  const want = catalogued.toUpperCase().trim();
  const sized = /^(.*)_(XS|S|M|L)$/.exec(want);
  const wantFamily = sized ? sized[1]! : want;
  const wantSize = sized ? sized[2]! : null;

  if (wantFamily !== reportedFamily) return false;
  if (wantSize !== null && reportedSize !== null) return wantSize === reportedSize;
  return true;
}

/** Raw shape of the subset of llama-server /props Bokahli depends on. */
interface BackendProps {
  build_info?: string;
  model_path?: string;
  model_alias?: string;
  model_ftype?: string;
  total_slots?: number;
  default_generation_settings?: { n_ctx?: number; params?: Record<string, unknown> };
  modalities?: { vision?: boolean; audio?: boolean; video?: boolean };
  /** The chat template the runtime holds for this model, verbatim. */
  chat_template?: string;
}

/**
 * `/v1/models` meta, which carries facts `/props` does not.
 *
 * `n_vocab` is the one that matters: comparing it against the token count in
 * the artifact Bokahli verified is what binds a tokenizer identity to the model
 * actually loaded, rather than to a file with a matching name.
 */
interface BackendModelMeta {
  readonly vocabType: number | null;
  readonly vocabSize: number | null;
  readonly contextTrain: number | null;
  readonly paramCount: number | null;
}

/**
 * Live slot parameters — what the runtime says it used, not what we asked for.
 *
 * This is the only channel through which a sampler setting becomes an
 * observation. `/props` reports process defaults; a slot reports the values
 * that were actually in force. On this deployment the two disagree about the
 * chat format and the reasoning format, which is precisely why the requested
 * and effective records are kept apart.
 */
export interface BackendSlotParams {
  readonly seed: number | null;
  readonly temperature: number | null;
  readonly topP: number | null;
  readonly topK: number | null;
  readonly maxTokens: number | null;
  readonly chatFormat: string | null;
  readonly reasoningFormat: string | null;
}

export interface BackendSlot {
  readonly id: number;
  readonly n_ctx: number;
  readonly is_processing: boolean;
  readonly params?: Record<string, unknown>;
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
  /**
   * Added in Phase B2. Both are omitted from the request entirely when
   * undefined, so a caller that sets neither produces byte-identical request
   * bodies to Phase 1 — the defaults below are unchanged and no new key
   * appears.
   */
  readonly topK?: number | undefined;
  readonly seed?: number | undefined;
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
/**
 * Cap on a tokenizer probe response body.
 *
 * A tokenize/detokenize answer for a probe case is tens of bytes; a megabyte is
 * four orders of magnitude of headroom and still a bound.
 */
const MAX_PROBE_BODY_BYTES = 1024 * 1024;

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

  /**
   * Facts `/props` omits, chiefly the loaded vocabulary size.
   *
   * Returns nulls rather than throwing: this is enrichment, and a backend that
   * will not answer must degrade the provenance verdict, not fail the request.
   */
  async modelMeta(alias: string): Promise<BackendModelMeta> {
    const empty: BackendModelMeta = {
      vocabType: null, vocabSize: null, contextTrain: null, paramCount: null,
    };
    try {
      const r = await this.#get('/v1/models', this.#timeoutMs);
      if (!r.ok) return empty;
      const body = (await r.json()) as { data?: { id?: string; meta?: Record<string, unknown> }[] };
      const entries = Array.isArray(body.data) ? body.data : [];
      // Match the alias when the backend serves more than one; fall back to the
      // sole entry rather than guessing between several.
      const hit = entries.find((e) => e.id === alias) ?? (entries.length === 1 ? entries[0] : undefined);
      const m = hit?.meta;
      if (!m) return empty;
      const n = (k: string): number | null => (typeof m[k] === 'number' ? (m[k] as number) : null);
      return {
        vocabType: n('vocab_type'),
        vocabSize: n('n_vocab'),
        contextTrain: n('n_ctx_train'),
        paramCount: n('n_params'),
      };
    } catch {
      return empty;
    }
  }

  /**
   * Sampler and format values the runtime reports for a slot.
   *
   * `/slots` reflects the most recent request a slot handled. That makes it a
   * genuine observation of what was applied and also means it is only
   * meaningful when read close to the request it describes — which is why the
   * caller records `observedAt` alongside, and why nothing here is treated as
   * immutable identity unless it was confirmed.
   */
  async slotParams(): Promise<BackendSlotParams | null> {
    let slots: BackendSlot[];
    try {
      slots = await this.slots();
    } catch {
      return null;
    }
    const params = slots[0]?.params;
    if (!params || typeof params !== 'object') return null;
    const num = (k: string): number | null => {
      const v = params[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    const str = (k: string): string | null => {
      const v = params[k];
      return typeof v === 'string' && v.length > 0 ? v : null;
    };
    return {
      seed: num('seed'),
      temperature: num('temperature'),
      topP: num('top_p'),
      topK: num('top_k'),
      maxTokens: num('max_tokens'),
      chatFormat: str('chat_format'),
      reasoningFormat: str('reasoning_format'),
    };
  }

  /**
   * Tokenize text with the runtime's own tokenizer.
   *
   * Not inference: no decode, no slot, no GPU work. This and `detokenize` are
   * the only channel through which Bokahli can observe the vocabulary the
   * process actually loaded, as opposed to the one its artifact declares.
   */
  async tokenize(
    text: string,
    opts: {
      readonly addSpecial: boolean;
      readonly parseSpecial: boolean;
      /** Refuse any id at or above this. Omitted means only sanity bounds apply. */
      readonly vocabSize?: number;
    } = { addSpecial: false, parseSpecial: true },
  ): Promise<readonly number[]> {
    // Both settings are sent explicitly. llama-server defaults `add_special`
    // to false and `parse_special` to true, and a canary generated under one
    // pair and verified under another fails for a reason that has nothing to do
    // with tokenizer identity — which is the kind of false alarm that gets a
    // check switched off.
    const r = await this.#post('/tokenize', {
      content: text,
      with_pieces: false,
      add_special: opts.addSpecial,
      parse_special: opts.parseSpecial,
    });
    const body = (await this.#json(r)) as { tokens?: unknown };
    if (!Array.isArray(body.tokens)) {
      throw new BackendUnavailableError('backend /tokenize did not return a token array');
    }
    // Filtering was the bug. `[10, null, 11]` and `[10, "JUNK", 11]` were
    // silently reduced to `[10, 11]` and then compared equal to the canary — so
    // a runtime that returned an extra element the JSON layer could not express
    // as an integer passed a check whose whole premise is exact agreement.
    // Every element is now either a real id or the response is not an answer.
    const out: number[] = [];
    for (const v of body.tokens as unknown[]) {
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
        throw new BackendUnavailableError(
          'backend /tokenize returned a value that is not a token id; the response is ' +
            'not comparable and is refused rather than filtered',
        );
      }
      if (opts.vocabSize !== undefined && v >= opts.vocabSize) {
        throw new BackendUnavailableError(
          `backend /tokenize returned id ${v}, outside the ${opts.vocabSize}-entry vocabulary`,
        );
      }
      out.push(v);
    }
    return out;
  }

  /** Text for a list of token ids, from the runtime's loaded vocabulary. */
  async detokenize(ids: readonly number[]): Promise<string> {
    const r = await this.#post('/detokenize', { tokens: [...ids] });
    const body = (await this.#json(r)) as { content?: unknown };
    if (typeof body.content !== 'string') {
      throw new BackendUnavailableError('backend /detokenize did not return text');
    }
    return body.content;
  }

  /**
   * Read a JSON body with a hard size bound.
   *
   * `r.json()` reads whatever arrives. A backend answering /detokenize with 50
   * MB — measured, 192 ms — buys memory in the API process for the price of one
   * probe, and the probe sequence makes ~95 of them. The backend is our own
   * loopback process and "ours would never" is not a bound.
   */
  async #json(r: Response): Promise<unknown> {
    const body = r.body;
    if (body === null) throw new BackendUnavailableError('backend returned an empty body');
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        size += value.byteLength;
        if (size > MAX_PROBE_BODY_BYTES) {
          throw new BackendUnavailableError(
            `backend response exceeded ${MAX_PROBE_BODY_BYTES} bytes`,
          );
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new BackendUnavailableError('backend response was not valid JSON');
    }
  }

  async #post(path: string, payload: unknown): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.#timeoutMs);
    try {
      const r = await fetch(`${this.#baseUrl}${path}`, {
        method: 'POST',
        headers: this.#headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(payload),
        signal: ctrl.signal,
        redirect: 'manual',
      });
      if (!r.ok) throw new BackendUnavailableError(`backend ${path} returned ${r.status}`);
      return r;
    } finally {
      clearTimeout(t);
    }
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
    if (p.model_ftype && !quantisationAgrees(artifact.facts.quantization, p.model_ftype)) {
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
    // Phase 1 defaults, unchanged. top_k and seed are spread in only when
    // requested: adding them unconditionally would alter every existing
    // client's request and silently change its sampling.
    const body = {
      model: alias,
      messages: params.messages,
      max_tokens: params.maxTokens ?? 512,
      temperature: params.temperature ?? 0.7,
      top_p: params.topP ?? 0.95,
      ...(params.topK !== undefined ? { top_k: params.topK } : {}),
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
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
