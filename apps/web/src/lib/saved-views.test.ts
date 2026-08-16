import assert from "node:assert/strict";
import test from "node:test";
import {
  SAVED_VIEWS_STORAGE_KEY,
  deleteView,
  readSavedViews,
  saveView,
  type SavedView,
} from "./saved-views";

// run with: node --conditions=react-server --test src/lib/saved-views.test.ts

/** A `localStorage` stand-in whose contents the test can inspect and clear. */
function makeStorage(options: { failWrites?: boolean } = {}) {
  const entries = new Map<string, string>();
  const store: Storage = {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      if (options.failWrites) throw new DOMException("quota", "QuotaExceededError");
      entries.set(key, value);
    },
  };
  return { store, entries };
}

/**
 * Installs a `localStorage` global for one test and removes it afterwards.
 * Node has none by default, which is also what the server render sees.
 */
function withLocalStorage(descriptor: PropertyDescriptor | null, run: () => void): void {
  if (descriptor) {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, ...descriptor });
  }
  try {
    run();
  } finally {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}

const deniedStorage: PropertyDescriptor = {
  get() {
    throw new DOMException("denied", "SecurityError");
  },
};

function seed(entries: Map<string, string>, views: Partial<Record<"traces" | "logs", SavedView[]>>) {
  entries.set(
    SAVED_VIEWS_STORAGE_KEY,
    JSON.stringify({ version: 1, traces: views.traces ?? [], logs: views.logs ?? [] }),
  );
}

test("a saved view round-trips through storage under the one key", () => {
  const { store, entries } = makeStorage();
  withLocalStorage({ value: store }, () => {
    saveView("traces", "Errors only", { status: "error", range: "6h" });

    assert.deepEqual(readSavedViews("traces"), [
      { name: "Errors only", filters: { status: "error", range: "6h" } },
    ]);
    // the persisted shape M3 inherits or discards knowingly (D30 M3-GATE)
    assert.deepEqual([...entries.keys()], ["obstack.saved-views"]);
    assert.deepEqual(JSON.parse(entries.get(SAVED_VIEWS_STORAGE_KEY) as string), {
      version: 1,
      traces: [{ name: "Errors only", filters: { status: "error", range: "6h" } }],
      logs: [],
    });
  });
});

test("clearing storage between the write and the read loses the views", () => {
  const { store, entries } = makeStorage();
  withLocalStorage({ value: store }, () => {
    saveView("traces", "Errors only", { status: "error" });
    assert.equal(readSavedViews("traces").length, 1);

    entries.clear();

    // the read observes the browser, not a value the module remembered
    assert.deepEqual(readSavedViews("traces"), []);
  });
});

test("each surface keeps its own views under the same name", () => {
  const { store } = makeStorage();
  withLocalStorage({ value: store }, () => {
    saveView("traces", "Errors only", { status: "error" });
    saveView("logs", "Errors only", { minSev: "error" });

    assert.deepEqual(readSavedViews("traces"), [
      { name: "Errors only", filters: { status: "error" } },
    ]);
    assert.deepEqual(readSavedViews("logs"), [
      { name: "Errors only", filters: { minSev: "error" } },
    ]);
  });
});

test("saving an existing name replaces that view where it sits", () => {
  const { store } = makeStorage();
  withLocalStorage({ value: store }, () => {
    saveView("traces", "Errors only", { status: "error" });
    saveView("traces", "Slow", { minMs: "5000" });
    const views = saveView("traces", "Errors only", { status: "error", minCost: "0.02" });

    assert.deepEqual(views, [
      { name: "Errors only", filters: { status: "error", minCost: "0.02" } },
      { name: "Slow", filters: { minMs: "5000" } },
    ]);
    assert.deepEqual(readSavedViews("traces"), views);
  });
});

test("a view keeps the whole filter set including the time range but never the page", () => {
  const { store } = makeStorage();
  withLocalStorage({ value: store }, () => {
    const views = saveView("traces", "Costly", {
      q: "checkout",
      status: "error",
      minMs: "1000",
      minCost: "0.02",
      range: "24h",
      page: "3",
    });

    assert.deepEqual(views[0].filters, {
      q: "checkout",
      status: "error",
      minMs: "1000",
      minCost: "0.02",
      range: "24h",
    });
    assert.deepEqual(readSavedViews("traces")[0].filters, views[0].filters);
  });
});

test("a blank name saves nothing", () => {
  const { store, entries } = makeStorage();
  withLocalStorage({ value: store }, () => {
    assert.deepEqual(saveView("traces", "   ", { status: "error" }), []);
    assert.equal(entries.size, 0);
  });
});

test("delete drops one view and leaves the rest", () => {
  const { store } = makeStorage();
  withLocalStorage({ value: store }, () => {
    saveView("traces", "Errors only", { status: "error" });
    saveView("traces", "Slow", { minMs: "5000" });

    assert.deepEqual(deleteView("traces", "Errors only"), [
      { name: "Slow", filters: { minMs: "5000" } },
    ]);
    assert.deepEqual(readSavedViews("traces"), [{ name: "Slow", filters: { minMs: "5000" } }]);
  });
});

test("absent storage degrades to no saved views", () => {
  withLocalStorage(null, () => {
    assert.equal(typeof (globalThis as { localStorage?: Storage }).localStorage, "undefined");
    assert.deepEqual(readSavedViews("traces"), []);
    assert.deepEqual(saveView("traces", "Errors only", { status: "error" }), []);
    assert.deepEqual(deleteView("traces", "Errors only"), []);
  });
});

test("storage the browser denies degrades to no saved views", () => {
  withLocalStorage(deniedStorage, () => {
    assert.deepEqual(readSavedViews("logs"), []);
    assert.deepEqual(saveView("logs", "Errors only", { minSev: "error" }), []);
    assert.deepEqual(deleteView("logs", "Errors only"), []);
  });
});

test("a corrupt blob reads as absent and the next save recovers", () => {
  const { store, entries } = makeStorage();
  withLocalStorage({ value: store }, () => {
    entries.set(SAVED_VIEWS_STORAGE_KEY, "{not json");
    assert.deepEqual(readSavedViews("traces"), []);

    assert.deepEqual(saveView("traces", "Errors only", { status: "error" }), [
      { name: "Errors only", filters: { status: "error" } },
    ]);
  });
});

test("an unknown envelope version reads as absent", () => {
  const { store, entries } = makeStorage();
  withLocalStorage({ value: store }, () => {
    entries.set(
      SAVED_VIEWS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        traces: [{ name: "Errors only", filters: { status: "error" } }],
        logs: [],
      }),
    );

    assert.deepEqual(readSavedViews("traces"), []);
  });
});

test("a wrongly shaped blob reads as absent", () => {
  const { store, entries } = makeStorage();
  withLocalStorage({ value: store }, () => {
    for (const blob of [
      { version: 1, traces: [{ name: "Errors only" }], logs: [] },
      { version: 1, traces: [{ name: "Errors only", filters: { minMs: 5000 } }], logs: [] },
      { version: 1, traces: [{ name: "", filters: {} }], logs: [] },
      { version: 1, traces: "Errors only", logs: [] },
      { version: 1, traces: [] },
      [{ name: "Errors only", filters: {} }],
    ]) {
      entries.set(SAVED_VIEWS_STORAGE_KEY, JSON.stringify(blob));
      assert.deepEqual(readSavedViews("traces"), [], JSON.stringify(blob));
    }
  });
});

test("a write the browser refuses leaves the persisted views untouched", () => {
  const { store, entries } = makeStorage({ failWrites: true });
  withLocalStorage({ value: store }, () => {
    seed(entries, { traces: [{ name: "Errors only", filters: { status: "error" } }] });
    const persisted = [{ name: "Errors only", filters: { status: "error" } }];

    // reports what the browser kept, not what the caller asked for
    assert.deepEqual(saveView("traces", "Slow", { minMs: "5000" }), persisted);
    assert.deepEqual(deleteView("traces", "Errors only"), persisted);
    assert.deepEqual(readSavedViews("traces"), persisted);
  });
});
