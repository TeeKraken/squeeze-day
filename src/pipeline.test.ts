/**
 * The load/save/remove orderings from the round 2 review, run against the
 * real pipeline with a fake worker and fake storage whose steps finish when
 * the test says so.
 */
import { describe, expect, it } from "vitest";
import { LoadPipeline, type CalendarFile } from "./pipeline";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A fake worker + IndexedDB. Saves and parses can be held open and finished later. */
function setup() {
  const log: string[] = [];
  const world = {
    stored: "A" as string | null,
    active: null as string | null,
    candidates: new Map<number, string>(),
    holdSave: new Map<string, Deferred<boolean>>(),
    failSave: new Set<string>(),
  };
  const name = (files: CalendarFile[]) => files.map((f) => f.name).join("+");
  const pipeline = new LoadPipeline<string>({
    async parse(loadId, files) {
      log.push(`parse ${name(files)}`);
      if (files.some((f) => f.text === "bad")) return { ok: false, message: "not a calendar" };
      world.candidates.set(loadId, name(files));
      return { ok: true, summary: name(files) };
    },
    discard(loadId) {
      world.candidates.delete(loadId);
    },
    async activate(loadId) {
      world.active = world.candidates.get(loadId) ?? null;
      world.candidates.clear();
      log.push(`activate ${world.active}`);
    },
    async save(files) {
      const n = name(files);
      log.push(`save ${n}`);
      const held = world.holdSave.get(n);
      const ok = held ? await held.promise : !world.failSave.has(n);
      if (ok) world.stored = n;
      log.push(`saved ${n} ${ok}`);
      return ok;
    },
    async removeSaved() {
      log.push("delete");
      world.stored = null;
      return true;
    },
  });
  const file = (n: string, text = "ok") => async () => [{ name: n, text }];
  return { pipeline, world, log, file };
}

describe("load pipeline", () => {
  it("review #1: a failed save finishing late can't delete a newer calendar that saved", async () => {
    const { pipeline, world, file } = setup();
    const holdA = deferred<boolean>();
    world.holdSave.set("A2", holdA);
    const a = pipeline.load(file("A2"), true, () => true);
    await tick();
    const b = pipeline.load(file("B"), true, () => true);
    await tick();
    holdA.resolve(false); // A's save fails after B was chosen
    expect((await a).status).toBe("loaded");
    const rb = await b;
    expect(rb.status).toBe("loaded");
    expect(world.stored).toBe("B");
    expect(world.active).toBe("B");
  });

  it("review #3: an invalid file chosen while a save is pending leaves worker, page and storage agreeing", async () => {
    const { pipeline, world, file } = setup();
    const holdB = deferred<boolean>();
    world.holdSave.set("B", holdB);
    const b = pipeline.load(file("B"), true, () => true);
    await tick();
    const c = pipeline.load(file("C", "bad"), true, () => true);
    await tick();
    holdB.resolve(true);
    const rb = await b;
    const rc = await c;
    expect(rb).toMatchObject({ status: "loaded", summary: "B" });
    expect(rc).toEqual({ status: "error", message: "not a calendar" });
    // What the page shows (B's result) is what the worker has and what is saved.
    expect(world.active).toBe("B");
    expect(world.stored).toBe("B");
  });

  it("a failed load leaves the current calendar active and saved", async () => {
    const { pipeline, world, file } = setup();
    await pipeline.load(file("A"), true, () => false);
    const r = await pipeline.load(file("X", "bad"), true, () => true);
    expect(r.status).toBe("error");
    expect(world.active).toBe("A");
    expect(world.stored).toBe("A");
  });

  it("remove during a pending save: removal wins, nothing is activated", async () => {
    const { pipeline, world, file } = setup();
    const hold = deferred<boolean>();
    world.holdSave.set("B", hold);
    world.active = "A";
    const b = pipeline.load(file("B"), true, () => true);
    await tick();
    const removed = pipeline.remove(true);
    hold.resolve(true);
    expect((await b).status).toBe("cancelled");
    expect(await removed).toBe(true);
    expect(world.stored).toBe(null);
    expect(world.active).toBe("A"); // the page cleared the worker itself; B never became active
  });

  it("remove while a file is still being read: no parse, no save", async () => {
    const { pipeline, world, log } = setup();
    const read = deferred<CalendarFile[]>();
    const b = pipeline.load(() => read.promise, true, () => true);
    await tick();
    const removed = pipeline.remove(true);
    read.resolve([{ name: "B", text: "ok" }]);
    expect((await b).status).toBe("cancelled");
    await removed;
    expect(log).toEqual(["delete"]);
    expect(world.stored).toBe(null);
  });

  it("closing the sample leaves a saved calendar alone", async () => {
    const { pipeline, world, file } = setup();
    await pipeline.load(file("sample"), false, () => false);
    expect(await pipeline.remove(false)).toBe(null);
    expect(world.stored).toBe("A");
  });

  it("closing the sample while a newer copy is being saved clears that save", async () => {
    const { pipeline, world, file } = setup();
    world.stored = null;
    const hold = deferred<boolean>();
    world.holdSave.set("B", hold);
    const b = pipeline.load(file("B"), true, () => false);
    await tick();
    const removed = pipeline.remove(false);
    hold.resolve(true);
    expect((await b).status).toBe("cancelled");
    expect(await removed).toBe(true);
    expect(world.stored).toBe(null);
  });

  it("a failed save clears the older copy and says so; if that fails too, says the older copy remains", async () => {
    const { pipeline, world, file } = setup();
    world.failSave.add("B");
    const r = await pipeline.load(file("B"), true, () => true);
    expect(r).toMatchObject({ status: "loaded", kept: "no" });
    expect(world.stored).toBe(null);
  });

  it("loads after a removal work normally", async () => {
    const { pipeline, world, file } = setup();
    await pipeline.remove(true);
    const r = await pipeline.load(file("C"), true, () => false);
    expect(r).toMatchObject({ status: "loaded", kept: "yes" });
    expect(world.stored).toBe("C");
    expect(world.active).toBe("C");
  });

  it("review r3 #2: cancelled while activating, a save it made is cleared even when closing the sample", async () => {
    const { pipeline, world, file } = setup();
    world.stored = null;
    const holdActivate = deferred<void>();
    const realActivate = (pipeline as unknown as { deps: { activate(id: number): Promise<void> } }).deps.activate;
    (pipeline as unknown as { deps: { activate(id: number): Promise<void> } }).deps.activate = async (id) => {
      await holdActivate.promise;
      return realActivate(id);
    };
    const b = pipeline.load(file("B"), true, () => false);
    await tick();
    await tick();
    expect(world.stored).toBe("B"); // saved, now waiting on activation
    const removed = pipeline.remove(false);
    holdActivate.resolve();
    expect((await b).status).toBe("cancelled");
    expect(await removed).toBe(true);
    expect(world.stored).toBe(null);
  });

  it("control: closing an ordinary sample still keeps the earlier saved calendar", async () => {
    const { pipeline, world, file } = setup();
    await pipeline.load(file("sample"), false, () => true);
    await pipeline.remove(false);
    expect(world.stored).toBe("A");
  });

  it("review r3 #3: a cancelled failed save leaves the older saved calendar alone", async () => {
    const { pipeline, world, file, log } = setup();
    const hold = deferred<boolean>();
    world.holdSave.set("B", hold);
    const b = pipeline.load(file("B"), true, () => true);
    await tick();
    const removed = pipeline.remove(false); // closing the sample while B's write is pending
    hold.resolve(false); // ...and that write fails
    expect((await b).status).toBe("cancelled");
    expect(await removed).toBe(null);
    expect(world.stored).toBe("A");
    expect(log).not.toContain("delete");
  });

  it("review r3 #3: an explicit Remove during a failed save still clears storage", async () => {
    const { pipeline, world, file } = setup();
    const hold = deferred<boolean>();
    world.holdSave.set("B", hold);
    const b = pipeline.load(file("B"), true, () => true);
    await tick();
    const removed = pipeline.remove(true);
    hold.resolve(false);
    expect((await b).status).toBe("cancelled");
    expect(await removed).toBe(true);
    expect(world.stored).toBe(null);
  });
});
