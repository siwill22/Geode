/**
 * Main-thread side of SH synthesis: a small worker pool, an LRU cache of
 * finished maps, and per-slot request coalescing.
 *
 * A "slot" is whatever one on-screen layer is (a Multi-Globe tile, a
 * difference layer, a swipe half). While a slider is dragged each slot asks
 * for a new map many times a second; only the latest request per slot is kept
 * waiting, earlier queued ones resolve to null at once. A request that is
 * already running is allowed to finish -- its result still goes into the
 * cache -- but resolves to null if its slot has moved on, so a stale map never
 * lands on screen after a newer one.
 *
 * Cached Float32Arrays are shared between callers: read them, never write.
 */
import type { FieldResult, FieldSpec, ShCoeffs } from './shSynthesis';

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  terminate?(): void;
}

export interface ShSynthesisClientOptions {
  /** Pool size. Default: cores - 1, between 1 and 4. */
  workers?: number;
  /** Maps kept in the cache. A 1440 x 721 map is ~4 MB. Default 16. */
  cacheEntries?: number;
  /** Injectable for tests; defaults to the Vite module worker. */
  createWorker?: () => WorkerLike;
}

interface Pending {
  slot: string;
  spec: FieldSpec;
  key: string;
  /** Registration generation the job was issued under. */
  gen: number;
  resolve: (r: FieldResult | null) => void;
  reject: (e: Error) => void;
}

export function fieldSpecKey(spec: FieldSpec): string {
  const m = typeof spec.model === 'string' ? spec.model : `${spec.model[0]}-minus-${spec.model[1]}`;
  return [m, spec.component, spec.r, spec.window.lmin, spec.window.lmax, spec.grid.nlon, spec.grid.nlat].join('|');
}

const defaultWorker = (): WorkerLike =>
  new Worker(new URL('./shSynthesis.worker.ts', import.meta.url), { type: 'module' });

export class ShSynthesisClient {
  private readonly pool: WorkerLike[] = [];
  private readonly idle: WorkerLike[] = [];
  private readonly queue: Pending[] = [];
  private readonly running = new Map<number, Pending>();
  /** Latest request key per slot; anything else for that slot is stale. */
  private readonly latest = new Map<string, string>();
  private readonly cache = new Map<string, FieldResult>();
  private readonly cacheEntries: number;
  private nextId = 1;
  /** Bumped by register/setMainField: a map computed before the bump was made
   *  from coefficients that no longer apply, so it is neither cached nor
   *  delivered. */
  private gen = 0;

  constructor(opts: ShSynthesisClientOptions = {}) {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    const n = opts.workers ?? Math.max(1, Math.min(4, cores - 1));
    this.cacheEntries = opts.cacheEntries ?? 16;
    const make = opts.createWorker ?? defaultWorker;
    for (let i = 0; i < n; i++) {
      const w = make();
      w.onmessage = (ev) => this.onMessage(w, ev.data);
      this.pool.push(w);
      this.idle.push(w);
    }
  }

  /** Send a model's coefficients to every worker. Re-registering an id
   *  replaces it and empties the cache. */
  register(id: string, coeffs: ShCoeffs): void {
    for (const w of this.pool) w.postMessage({ type: 'register', id, coeffs });
    this.invalidate();
  }

  /** Which registered model is the main field for the total-field anomaly. */
  setMainField(id: string): void {
    for (const w of this.pool) w.postMessage({ type: 'main', id });
    this.invalidate();
  }

  /** A finished map, if cached. */
  cached(spec: FieldSpec): FieldResult | undefined {
    return this.cache.get(fieldSpecKey(spec));
  }

  /** The map for `spec`, or null if `slot` asked for something newer first. */
  request(slot: string, spec: FieldSpec): Promise<FieldResult | null> {
    const key = fieldSpecKey(spec);
    this.latest.set(slot, key);
    const hit = this.cache.get(key);
    if (hit) {
      this.touch(key, hit);
      this.dropQueued(slot);
      return Promise.resolve(hit);
    }
    this.dropQueued(slot);
    return new Promise((resolve, reject) => {
      this.queue.push({ slot, spec, key, gen: this.gen, resolve, reject });
      this.pump();
    });
  }

  dispose(): void {
    for (const w of this.pool) w.terminate?.();
    for (const p of this.queue) p.resolve(null);
    this.queue.length = 0;
  }

  private invalidate(): void {
    this.gen++;
    this.cache.clear();
    // Queued jobs have not been sent yet, so they will run on the new
    // coefficients (messages to a worker are handled in order).
    for (const p of this.queue) p.gen = this.gen;
  }

  private dropQueued(slot: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].slot === slot) {
        this.queue[i].resolve(null);
        this.queue.splice(i, 1);
      }
    }
  }

  private pump(): void {
    while (this.idle.length && this.queue.length) {
      const job = this.queue.shift()!;
      const hit = this.cache.get(job.key);
      if (hit) {
        job.resolve(this.latest.get(job.slot) === job.key ? hit : null);
        continue;
      }
      const w = this.idle.pop()!;
      const reqId = this.nextId++;
      this.running.set(reqId, job);
      w.postMessage({ type: 'synth', reqId, spec: job.spec });
    }
  }

  private onMessage(w: WorkerLike, data: { type: string; reqId: number; result?: FieldResult; message?: string }): void {
    const job = this.running.get(data.reqId);
    this.running.delete(data.reqId);
    this.idle.push(w);
    if (job) {
      if (data.type === 'done' && data.result) {
        const current = job.gen === this.gen;
        if (current) this.touch(job.key, data.result);
        job.resolve(current && this.latest.get(job.slot) === job.key ? data.result : null);
      } else {
        job.reject(new Error(data.message ?? 'SH synthesis failed'));
      }
    }
    this.pump();
  }

  private touch(key: string, result: FieldResult): void {
    this.cache.delete(key);
    this.cache.set(key, result);
    while (this.cache.size > this.cacheEntries) {
      this.cache.delete(this.cache.keys().next().value!);
    }
  }
}
