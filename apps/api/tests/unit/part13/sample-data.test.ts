import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveColumnMap } from "../../../src/modules/ingestion/fields.js";
import { csvField, toCsv } from "../../../src/tools/sample-data/csv.js";
import { generateDataset, type GeneratedFile } from "../../../src/tools/sample-data/generate.js";
import { createRng } from "../../../src/tools/sample-data/random.js";
import { writeDataset } from "../../../src/tools/sample-data/write.js";
import { makeTempDir } from "../../helpers/part2-fixtures.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

// ---------------------------------------------------------------------------------------------
describe("the random number generator", () => {
  it("gives the same numbers for the same seed, and different numbers for another seed", () => {
    const a = createRng(5);
    const b = createRng(5);
    const c = createRng(6);
    const draw = (rng: ReturnType<typeof createRng>) =>
      Array.from({ length: 20 }, () => rng.next());
    expect(draw(a)).toEqual(draw(b));
    expect(draw(createRng(5))).not.toEqual(draw(c));
  });

  it("stays inside its bounds", () => {
    const rng = createRng(1);
    for (let index = 0; index < 5000; index += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      const whole = rng.int(3, 9);
      expect(whole).toBeGreaterThanOrEqual(3);
      expect(whole).toBeLessThanOrEqual(9);
    }
  });

  it("reaches both ends of an integer range", () => {
    const rng = createRng(2);
    const seen = new Set(Array.from({ length: 500 }, () => rng.int(1, 4)));
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });

  it("shuffles without losing or repeating an item, and leaves the input alone", () => {
    const rng = createRng(3);
    const input = Array.from({ length: 50 }, (_, index) => index);
    const output = rng.shuffle(input);
    expect([...output].sort((x, y) => x - y)).toEqual(input);
    expect(output).not.toEqual(input);
    expect(input[0]).toBe(0);
  });

  it("picks only from the list and refuses an empty one", () => {
    const rng = createRng(4);
    for (let index = 0; index < 100; index += 1) expect(["a", "b"]).toContain(rng.pick(["a", "b"]));
    expect(() => rng.pick([])).toThrow();
  });

  it("makes true about as often as asked", () => {
    const rng = createRng(9);
    const hits = Array.from({ length: 10_000 }, () => rng.chance(0.3)).filter(Boolean).length;
    expect(hits).toBeGreaterThan(2700);
    expect(hits).toBeLessThan(3300);
  });
});

describe("the CSV writer", () => {
  it("quotes only what needs it", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
    expect(csvField(0)).toBe("0");
  });

  it("writes a header, rows, and a final line break", () => {
    expect(
      toCsv(
        ["a", "b"],
        [
          [1, "x,y"],
          [2, null],
        ],
      ),
    ).toBe('a,b\n1,"x,y"\n2,\n');
  });
});

// ---------------------------------------------------------------------------------------------
describe("the generated data", () => {
  const data = generateDataset({ orders: 400, seed: 2026 });
  const file = (name: string): GeneratedFile => {
    const found = data.files.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no file ${name}`);
    return found;
  };
  const parse = (content: string) =>
    content
      .trim()
      .split("\n")
      .map((line) => line.split(","));
  const dataRows = (name: string) => parse(file(name).content).slice(1);

  it("is the same every time for the same seed, and different for another", () => {
    const again = generateDataset({ orders: 400, seed: 2026 });
    expect(again.files.map((f) => f.content)).toEqual(data.files.map((f) => f.content));
    expect(again.truth).toEqual(data.truth);
    const other = generateDataset({ orders: 400, seed: 2027 });
    expect(other.files.map((f) => f.content)).not.toEqual(data.files.map((f) => f.content));
  });

  it("makes a file for each source and report type, and nothing empty", () => {
    expect(data.files.map((f) => f.name).sort()).toEqual(
      [
        "cod-remittance-aggregator-1.csv",
        "cod-remittance-aggregator-2.csv",
        "freight-invoice-aggregator-1.csv",
        "freight-invoice-aggregator-2.csv",
        "orders-marketplace-1.csv",
        "orders-marketplace-2.csv",
        "orders-marketplace-3.csv",
        "orders-quick-commerce-1.csv",
        "orders-quick-commerce-2.csv",
        "orders-website.csv",
        "return-scans-warehouse.csv",
        "settlement-marketplace-1.csv",
        "settlement-marketplace-2.csv",
        "settlement-marketplace-3.csv",
        "settlement-quick-commerce-1.csv",
        "settlement-quick-commerce-2.csv",
      ].sort(),
    );
    for (const f of data.files) expect(f.rows).toBeGreaterThan(0);
  });

  it("only sends each source the file types it may send (the seed's source list)", () => {
    const allowed: Record<string, string[]> = {
      Website: ["ORDERS"],
      "Marketplace 1": ["ORDERS", "SETTLEMENT"],
      "Marketplace 2": ["ORDERS", "SETTLEMENT"],
      "Marketplace 3": ["ORDERS", "SETTLEMENT"],
      "Quick Commerce 1": ["ORDERS", "SETTLEMENT"],
      "Quick Commerce 2": ["ORDERS", "SETTLEMENT"],
      "Aggregator 1": ["COD_REMITTANCE", "FREIGHT_INVOICE"],
      "Aggregator 2": ["COD_REMITTANCE", "FREIGHT_INVOICE"],
      Warehouse: ["RETURN_SCAN"],
    };
    for (const f of data.files) expect(allowed[f.source], f.name).toContain(f.fileType);
  });

  it("uses column names the upload step can map by name, with every required field found", () => {
    for (const f of data.files) {
      const headers = (f.content.split("\n")[0] ?? "").split(",");
      const resolution = resolveColumnMap(f.fileType, headers);
      expect(resolution.missing, f.name).toEqual([]);
    }
  });

  it("has exactly the number of orders asked for, each with a unique ID", () => {
    const ids = data.files
      .filter((f) => f.fileType === "ORDERS")
      .flatMap((f) =>
        parse(f.content)
          .slice(1)
          .map((row) => `${f.source}|${row[0]}`),
      );
    expect(ids).toHaveLength(400);
    expect(new Set(ids).size).toBe(400);
    expect(data.truth).toHaveLength(400);
    expect(new Set(data.truth.map((order) => `${order.channel}|${order.orderId}`)).size).toBe(400);
  });

  it("contains the three sample rows of the assignment, with the assignment's numbers", () => {
    const byId = new Map(data.truth.map((order) => [order.orderId, order]));
    expect(byId.get("ORD-W-204118")).toMatchObject({
      status: "UNPAID_PAST_DUE",
      expected: "1409.00",
      received: "0.00",
      difference: "-1409.00",
    });
    expect(byId.get("ORD-M-88120")).toMatchObject({
      status: "SHORT_PAID",
      expected: "899.00",
      received: "862.00",
      difference: "-37.00",
    });
    expect(byId.get("ORD-W-204377")).toMatchObject({
      status: "FREIGHT_OVERCHARGED",
      expected: "-96.00",
      received: "-142.00",
      difference: "-46.00",
    });
    const website = dataRows("orders-website.csv");
    const row = website.find((cells) => cells[0] === "ORD-W-204118");
    expect(row?.slice(2, 5)).toEqual(["1499.00", "COD", "Delivered"]);
  });

  it("includes every kind of finding, so every screen has something to show", () => {
    for (const status of [
      "SETTLED",
      "SHORT_PAID",
      "UNPAID_PAST_DUE",
      "FREIGHT_OVERCHARGED",
      "RETURN_NOT_RECEIVED",
      "NOT_TRACKED",
      "PENDING",
    ]) {
      expect(data.summary.byStatus[status], status).toBeGreaterThan(0);
    }
    for (const scenario of ["ORPHAN_PAYMENT", "DUPLICATE_ROW", "AWB_ONLY", "RETURN_NO_SCAN"]) {
      expect(data.summary.byScenario[scenario], scenario).toBeGreaterThan(0);
    }
    expect(data.summary.orphanLines).toBeGreaterThan(0);
    expect(data.summary.duplicateRows).toBeGreaterThan(0);
  });

  it("refers only to orders that exist, except the payment lines planted without an ID", () => {
    const known = new Set(data.truth.map((order) => order.orderId));
    const check = (name: string, column: number, blankAllowed: boolean) => {
      for (const cells of dataRows(name)) {
        const id = cells[column] ?? "";
        if (id === "") {
          expect(blankAllowed, `${name} has a blank order ID`).toBe(true);
        } else {
          expect(known.has(id), `${name}: unknown order ${id}`).toBe(true);
        }
      }
    };
    for (const f of data.files) {
      if (f.fileType === "SETTLEMENT") check(f.name, 1, true);
      if (f.fileType === "COD_REMITTANCE") check(f.name, 2, true);
      if (f.fileType === "FREIGHT_INVOICE") check(f.name, 2, true);
      if (f.fileType === "RETURN_SCAN") check(f.name, 1, true);
    }
  });

  it("gives every blank-ID payment line no AWB either, so it truly cannot be matched", () => {
    let blank = 0;
    for (const f of data.files.filter((candidate) => candidate.fileType === "COD_REMITTANCE")) {
      for (const cells of parse(f.content).slice(1)) {
        if ((cells[2] ?? "") === "" && (cells[1] ?? "") === "") blank += 1;
      }
    }
    for (const f of data.files.filter((candidate) => candidate.fileType === "SETTLEMENT")) {
      for (const cells of parse(f.content).slice(1)) if ((cells[1] ?? "") === "") blank += 1;
    }
    expect(blank).toBe(data.summary.orphanLines);
  });

  it("uses unique settlement references and unique AWBs", () => {
    for (const f of data.files.filter((candidate) => candidate.fileType === "SETTLEMENT")) {
      const refs = parse(f.content)
        .slice(1)
        .map((cells) => cells[0]);
      const unique = new Set(refs);
      // The planted duplicate rows repeat a reference on purpose.
      expect(refs.length - unique.size, f.name).toBeLessThanOrEqual(data.summary.duplicateRows);
    }
    const awbs = dataRows("orders-website.csv").map((cells) => cells[5]);
    expect(new Set(awbs).size).toBe(awbs.length);
  });

  it("writes every money value as rupees with two decimals", () => {
    const columns: Record<string, number[]> = {
      ORDERS: [2],
      SETTLEMENT: [4, 5, 6],
      COD_REMITTANCE: [4],
      FREIGHT_INVOICE: [5],
    };
    for (const f of data.files) {
      for (const column of columns[f.fileType] ?? []) {
        for (const cells of parse(f.content).slice(1)) {
          expect(cells[column], `${f.name} column ${column}`).toMatch(/^-?\d+\.\d{2}$/);
        }
      }
    }
  });

  it("has no personal-data column and no e-mail or phone-like value", () => {
    for (const f of data.files) {
      const header = f.content.split("\n")[0] ?? "";
      expect(header, f.name).not.toMatch(/name|phone|mobile|address|e-?mail|pin ?code|customer/i);
      expect(f.content, f.name).not.toMatch(/\S+@\S+\.\S+/);
      expect(f.content, f.name).not.toMatch(/\b\d{10}\b/);
    }
  });

  it("dates its data so that the newest date anywhere is the stated asOf", () => {
    let newest = 0;
    for (const f of data.files) {
      for (const match of f.content.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
        newest = Math.max(newest, Date.parse(`${match[1]}T00:00:00Z`));
      }
    }
    expect(new Date(newest).toISOString()).toBe(data.asOf);
  });

  it("keeps the truth consistent: difference = received - expected, and risk follows the status", () => {
    const cents = (text: string) => Math.round(Number(text) * 100);
    for (const order of data.truth) {
      if (order.expected !== null && order.received !== null && order.difference !== null) {
        expect(cents(order.difference), order.orderId).toBe(
          cents(order.received) - cents(order.expected),
        );
      }
      expect(cents(order.cashAtRisk), order.orderId).toBeGreaterThanOrEqual(0);
      if (order.problem === null) {
        expect(order.cashAtRisk).toBe("0.00");
        expect(order.returnValue).toBe("0.00");
        expect(order.riskPartner).toBeNull();
        expect(order.ageBand).toBeNull();
      }
      if (order.problem === "RETURN_NOT_RECEIVED") {
        expect(cents(order.returnValue), order.orderId).toBeGreaterThan(0);
        expect(order.cashAtRisk).toBe("0.00");
      } else {
        expect(order.returnValue).toBe("0.00");
      }
      if (order.problem && order.problem !== "RETURN_NOT_RECEIVED") {
        expect(cents(order.cashAtRisk), order.orderId).toBeGreaterThan(0);
        expect(order.ageBand).toBeGreaterThanOrEqual(0);
        expect(order.ageBand).toBeLessThanOrEqual(3);
      }
    }
  });

  it("works out the TCS and TDS truth from the lines that will be saved (a repeated row counts once)", () => {
    const cents = (text: string) => Math.round(Number(text) * 100);
    const expected = new Map<string, { lines: number; tcs: number; tds: number }>();
    for (const f of data.files.filter((candidate) => candidate.fileType === "SETTLEMENT")) {
      const seen = new Set<string>();
      for (const line of f.content.trim().split("\n").slice(1)) {
        if (seen.has(line)) continue;
        seen.add(line);
        const cells = line.split(",");
        const key = `${f.source}|${(cells[2] ?? "").slice(0, 7)}`;
        const total = expected.get(key) ?? { lines: 0, tcs: 0, tds: 0 };
        total.lines += 1;
        total.tcs += cents(cells[5] ?? "0");
        total.tds += cents(cells[6] ?? "0");
        expected.set(key, total);
      }
    }
    const actual = new Map(
      data.summary.tax.map((entry) => [
        `${entry.partner}|${entry.month}`,
        { lines: entry.lines, tcs: cents(entry.tcs), tds: cents(entry.tds) },
      ]),
    );
    expect(actual).toEqual(expected);
  });

  it("makes net received, TCS and TDS add up to the expected payout for an ordinary marketplace order", () => {
    const cents = (text: string) => Math.round(Number(text) * 100);
    const truthById = new Map(data.truth.map((order) => [order.orderId, order]));
    let checked = 0;
    for (const f of data.files.filter((candidate) => candidate.fileType === "SETTLEMENT")) {
      for (const cells of parse(f.content).slice(1)) {
        const order = truthById.get(cells[1] ?? "");
        if (order?.status !== "SETTLED" || order.expected === null) continue;
        expect(cents(cells[4] ?? "0") + cents(cells[5] ?? "0") + cents(cells[6] ?? "0")).toBe(
          cents(order.expected),
        );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("is quick enough to build a large data set", () => {
    const started = performance.now();
    const big = generateDataset({ orders: 5000, seed: 1 });
    expect(big.truth).toHaveLength(5000);
    expect(performance.now() - started).toBeLessThan(20_000);
  });

  it("makes a smaller set for a small request, and still works for one order", () => {
    expect(generateDataset({ orders: 1, seed: 1 }).truth).toHaveLength(1);
    expect(generateDataset({ orders: 25, seed: 1 }).truth).toHaveLength(25);
  });
});

describe("writing the files", () => {
  it("writes the CSVs, a manifest and the truth to a folder", () => {
    const data = generateDataset({ orders: 120, seed: 3 });
    const dir = makeTempDir("sample-write");
    const manifest = writeDataset(data, dir);
    expect(manifest.files).toHaveLength(data.files.length);
    for (const f of manifest.files) expect(existsSync(path.join(dir, f.name))).toBe(true);
    const saved = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
    expect(saved.options).toMatchObject({ orders: 120, seed: 3 });
    expect(saved.note).toContain("Synthetic");
    const truth = JSON.parse(readFileSync(path.join(dir, "truth.json"), "utf8"));
    expect(truth.orders).toHaveLength(120);
  });
});

describe("the demo set in the repository", () => {
  const demo = path.join(repoRoot, "sample-data", "demo");

  it("exists and is exactly what the generator makes for 400 orders with seed 2026", () => {
    expect(
      existsSync(demo),
      "run: npm run sample:generate -- --orders 400 --seed 2026 --out ../../sample-data/demo",
    ).toBe(true);
    const data = generateDataset({ orders: 400, seed: 2026 });
    for (const f of data.files) {
      expect(readFileSync(path.join(demo, f.name), "utf8").replaceAll("\r\n", "\n"), f.name).toBe(
        f.content,
      );
    }
    const manifest = JSON.parse(readFileSync(path.join(demo, "manifest.json"), "utf8"));
    expect(manifest.files.map((f: { name: string }) => f.name)).toEqual(
      data.files.map((f) => f.name),
    );
    expect(manifest.asOf).toBe(data.asOf);
  });
});
