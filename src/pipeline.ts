/**
 * Loading and removing calendars, one step at a time.
 *
 * Every load runs as one queued operation: read the files, parse them into a
 * candidate (in the worker), keep it on this device if asked, then activate
 * it. Operations never overlap, so a later load can't be undone by an earlier
 * one finishing late, and the worker's calendar and the page always agree.
 *
 * A removal takes effect at once: it makes every load already asked for out
 * of date, and out-of-date loads never activate or delete anything. Its own
 * storage clean-up is queued behind whatever is running, so it also wins over
 * a save that was already under way.
 */

export interface CalendarFile {
  name: string;
  text: string;
}

export type Kept = "yes" | "no" | "old-copy-remains" | "not-asked";

export interface PipelineDeps<Summary> {
  /** Parses files into a candidate calendar held under `loadId`, without showing it. */
  parse(loadId: number, files: CalendarFile[]): Promise<{ ok: true; summary: Summary } | { ok: false; message: string }>;
  discard(loadId: number): void;
  /** Makes the candidate the calendar days are read from. */
  activate(loadId: number): Promise<void>;
  save(files: CalendarFile[]): Promise<boolean>;
  removeSaved(): Promise<boolean>;
}

export type LoadResult<Summary> =
  | { status: "loaded"; loadId: number; summary: Summary; files: CalendarFile[]; kept: Kept }
  | { status: "error"; message: string }
  | { status: "cancelled" };

export class LoadPipeline<Summary> {
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private nextLoadId = 1;
  /** Saves that finished after a removal made their load out of date. */
  private orphanSaves = 0;

  constructor(private deps: PipelineDeps<Summary>) {}

  private inTurn<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** The current generation; a result from an older one must be ignored. */
  get current(): number {
    return this.generation;
  }

  /**
   * Queues a load. `read` runs inside the queue (so a slow read can't overtake
   * an earlier load); `hadSaved` says whether a calendar was kept before this one.
   */
  load(read: () => Promise<CalendarFile[]>, keep: boolean, hadSaved: () => boolean): Promise<LoadResult<Summary>> {
    const g = this.generation;
    const stale = () => g !== this.generation;
    return this.inTurn(async (): Promise<LoadResult<Summary>> => {
      if (stale()) return { status: "cancelled" };
      let files: CalendarFile[];
      try {
        files = await read();
      } catch (err) {
        if (stale()) return { status: "cancelled" };
        throw err;
      }
      if (stale()) return { status: "cancelled" };
      const loadId = this.nextLoadId++;
      const parsed = await this.deps.parse(loadId, files);
      if (stale() || !parsed.ok) {
        this.deps.discard(loadId);
        return stale() || parsed.ok ? { status: "cancelled" } : { status: "error", message: parsed.message };
      }
      let kept: Kept = "not-asked";
      if (keep) {
        const before = hadSaved();
        const ok = await this.deps.save(files);
        if (stale()) {
          // Cancelled while saving. A save that went through must not survive
          // (the queued removal clears it); a failed one changed nothing, so the
          // older saved copy is left exactly as it was.
          if (ok) this.orphanSaves++;
          this.deps.discard(loadId);
          return { status: "cancelled" };
        }
        if (ok) kept = "yes";
        // Don't let an older saved copy quietly come back next time. Nothing
        // else can touch storage meanwhile, so this only ever clears the older copy.
        else kept = (await this.deps.removeSaved()) ? "no" : before ? "old-copy-remains" : "no";
      }
      await this.deps.activate(loadId);
      if (stale()) {
        // Cancelled while activating: the page ignores it, and a save it made is cleared.
        if (kept === "yes") this.orphanSaves++;
        return { status: "cancelled" };
      }
      return { status: "loaded", loadId, summary: parsed.summary, files, kept };
    });
  }

  /**
   * Removes the calendar: every load asked for so far is cancelled now, and
   * storage is cleared once whatever is running has finished. `clearStorage`
   * is false when closing the sample, which is never saved; a save that
   * slipped through while it was being closed is still cleared.
   */
  remove(clearStorage: boolean): Promise<boolean | null> {
    this.generation++;
    return this.inTurn(async () => {
      if (!clearStorage && this.orphanSaves === 0) return null;
      this.orphanSaves = 0;
      return this.deps.removeSaved();
    });
  }
}
