import type { RequestTelemetry, RouteOutcomeKind } from '@bokahli/contracts';

/**
 * Telemetry and structured logging.
 *
 * Bokahli is the authority for telemetry, so records are kept here rather than
 * scraped from the backend. Prompt and completion text NEVER enters a log line
 * unless logPrompts is explicitly enabled; token counts and timings do.
 */
export interface LogFields {
  readonly [k: string]: string | number | boolean | null | undefined;
}

export class Telemetry {
  readonly #logPrompts: boolean;
  readonly #recent: RequestTelemetry[] = [];
  readonly #maxRecent = 200;
  readonly #counters: Record<RouteOutcomeKind, number> = {
    ROUTED: 0,
    ESCALATE: 0,
    REFUSED: 0,
    CAPACITY_UNAVAILABLE: 0,
  };
  #totalRequests = 0;
  #totalPromptTokens = 0;
  #totalCompletionTokens = 0;
  #totalCompletionMs = 0;
  #authFailures = 0;
  readonly #startedAt = new Date().toISOString();

  constructor(logPrompts: boolean) {
    this.#logPrompts = logPrompts;
  }

  get logPromptsEnabled(): boolean {
    return this.#logPrompts;
  }

  log(level: 'info' | 'warn' | 'error', event: string, fields: LogFields = {}): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      svc: 'bokahli',
      event,
      ...fields,
    });
    if (level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  /** Only ever called when logPrompts is enabled. Kept in one place, deliberately. */
  logPromptBody(requestId: string, body: unknown): void {
    if (!this.#logPrompts) return;
    this.log('info', 'request.body', { requestId, body: JSON.stringify(body).slice(0, 8192) });
  }

  recordAuthFailure(path: string, remote: string): void {
    this.#authFailures++;
    this.log('warn', 'auth.failed', { path, remote });
  }

  record(t: RequestTelemetry, outcome: RouteOutcomeKind): void {
    this.#totalRequests++;
    this.#counters[outcome]++;
    if (t.promptTokens) this.#totalPromptTokens += t.promptTokens;
    if (t.completionTokens) this.#totalCompletionTokens += t.completionTokens;
    if (t.completionTokens && t.completionTokensPerSecond) {
      this.#totalCompletionMs += (t.completionTokens / t.completionTokensPerSecond) * 1000;
    }
    this.#recent.push(t);
    if (this.#recent.length > this.#maxRecent) this.#recent.shift();

    this.log('info', 'request.completed', {
      requestId: t.requestId,
      outcome,
      queueWaitMs: t.queueWaitMs,
      queueDepthAtAdmission: t.queueDepthAtAdmission,
      routeMs: t.routeMs,
      ttftMs: t.timeToFirstTokenMs,
      totalMs: t.totalMs,
      promptTokens: t.promptTokens,
      completionTokens: t.completionTokens,
      promptTps: round(t.promptTokensPerSecond),
      completionTps: round(t.completionTokensPerSecond),
      servedContextTokens: t.servedContextTokens,
      contextUtilisation: round(t.contextUtilisation),
      runtimeBuild: t.runtimeBuild,
      gpuUsedMiB: t.gpu?.usedMiB ?? null,
      gpuUtilPct: t.gpu?.utilisationPct ?? null,
      gpuTempC: t.gpu?.temperatureC ?? null,
    });
  }

  summary(): Record<string, unknown> {
    const completions = this.#recent.filter((r) => r.completionTokens != null);
    return {
      startedAt: this.#startedAt,
      totalRequests: this.#totalRequests,
      outcomes: { ...this.#counters },
      authFailures: this.#authFailures,
      tokens: {
        totalPromptTokens: this.#totalPromptTokens,
        totalCompletionTokens: this.#totalCompletionTokens,
        meanCompletionTokensPerSecond:
          this.#totalCompletionMs > 0
            ? round((this.#totalCompletionTokens / this.#totalCompletionMs) * 1000)
            : null,
      },
      latency: {
        samples: completions.length,
        p50TtftMs: percentile(completions.map((r) => r.timeToFirstTokenMs), 0.5),
        p95TtftMs: percentile(completions.map((r) => r.timeToFirstTokenMs), 0.95),
        p50TotalMs: percentile(completions.map((r) => r.totalMs), 0.5),
        p95TotalMs: percentile(completions.map((r) => r.totalMs), 0.95),
        maxQueueWaitMs: completions.reduce((m, r) => Math.max(m, r.queueWaitMs), 0),
      },
      logPrompts: this.#logPrompts,
    };
  }

  recent(limit: number): readonly RequestTelemetry[] {
    return this.#recent.slice(-limit);
  }
}

function round(n: number | null | undefined): number | null {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
}

function percentile(values: (number | null)[], p: number): number | null {
  const xs = values.filter((v): v is number => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1));
  return round(xs[idx]);
}

/**
 * Deliberately coarse token estimate, used only for pre-flight context checks
 * in the router. Real counts always come from the backend's own tokeniser and
 * overwrite this value in the telemetry record.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}
