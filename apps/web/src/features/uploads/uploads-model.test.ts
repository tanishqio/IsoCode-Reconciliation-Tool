import { describe, expect, it } from "vitest";
import type { FileResult, Source } from "./uploads-api";
import {
  MAX_FILES,
  addFiles,
  allowedFileTypes,
  canUpload,
  formatBytes,
  hasAcceptedExtension,
  rowsAfterUpload,
  setRowSource,
  type DraftRow,
} from "./uploads-model";

const sources: Source[] = [
  { id: "web", name: "Website", kind: "WEBSITE", fileTypes: ["ORDERS"] },
  { id: "m1", name: "Marketplace 1", kind: "MARKETPLACE", fileTypes: ["ORDERS", "SETTLEMENT"] },
];

const file = (name: string, size = 10) => new File([new Uint8Array(size)], name);
const row = (partial: Partial<DraftRow> = {}): DraftRow => ({
  key: "k",
  file: file("a.csv"),
  sourceId: "",
  fileType: "",
  ...partial,
});

describe("choosing files", () => {
  it("accepts .csv, .xls and .xlsx in any letter case, and nothing else", () => {
    for (const ok of ["a.csv", "A.CSV", "b.xls", "c.xlsx", "report.final.XLSX"]) {
      expect(hasAcceptedExtension(ok), ok).toBe(true);
    }
    for (const bad of ["a.pdf", "a.xlsm", "a.csv.exe", "csv", "a.txt", ""]) {
      expect(hasAcceptedExtension(bad), bad).toBe(false);
    }
  });

  it("adds accepted files and reports the others by name", () => {
    const result = addFiles([], [file("a.csv"), file("b.pdf"), file("c.xlsx")]);
    expect(result.rows.map((r) => r.file.name)).toEqual(["a.csv", "c.xlsx"]);
    expect(result.wrongType).toEqual(["b.pdf"]);
    expect(result.overflow).toBe(0);
  });

  it("stops at five files in total and says how many were left out", () => {
    const first = addFiles(
      [],
      Array.from({ length: 4 }, (_, i) => file(`f${i}.csv`)),
    );
    const second = addFiles(first.rows, [file("x.csv"), file("y.csv"), file("z.csv")]);
    expect(second.rows).toHaveLength(MAX_FILES);
    expect(second.overflow).toBe(2);
  });

  it("gives every row its own key and starts with no source or file type", () => {
    const { rows } = addFiles([], [file("a.csv"), file("b.csv")]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
    expect(rows.every((r) => r.sourceId === "" && r.fileType === "")).toBe(true);
  });
});

describe("source and file type", () => {
  it("offers only the file types the chosen source sends", () => {
    expect(allowedFileTypes(sources, "web")).toEqual(["ORDERS"]);
    expect(allowedFileTypes(sources, "m1")).toEqual(["ORDERS", "SETTLEMENT"]);
    expect(allowedFileTypes(sources, "unknown")).toEqual([]);
  });

  it("chooses the file type for the person when the source sends only one kind", () => {
    expect(setRowSource(row(), sources, "web")).toMatchObject({
      sourceId: "web",
      fileType: "ORDERS",
    });
  });

  it("leaves the file type empty when the source sends several kinds", () => {
    expect(setRowSource(row(), sources, "m1")).toMatchObject({ sourceId: "m1", fileType: "" });
  });

  it("keeps a file type that the new source can also send, and clears one it cannot", () => {
    expect(setRowSource(row({ sourceId: "m1", fileType: "ORDERS" }), sources, "web").fileType).toBe(
      "ORDERS",
    );
    expect(
      setRowSource(row({ sourceId: "m1", fileType: "SETTLEMENT" }), sources, "web").fileType,
    ).toBe("ORDERS");
    expect(setRowSource(row({ sourceId: "web", fileType: "ORDERS" }), sources, "m1").fileType).toBe(
      "ORDERS",
    );
  });
});

describe("canUpload", () => {
  const ready = row({ sourceId: "m1", fileType: "SETTLEMENT" });

  it("needs at least one file, and a valid source and type for every file", () => {
    expect(canUpload([], sources)).toBe(false);
    expect(canUpload([ready], sources)).toBe(true);
    expect(canUpload([ready, row()], sources)).toBe(false);
    expect(canUpload([ready, row({ sourceId: "web" })], sources)).toBe(false);
  });

  it("refuses a file type the source does not send, even if it is set", () => {
    expect(canUpload([row({ sourceId: "web", fileType: "SETTLEMENT" })], sources)).toBe(false);
  });

  it("refuses more than five files", () => {
    expect(
      canUpload(
        Array.from({ length: 6 }, () => ready),
        sources,
      ),
    ).toBe(false);
  });
});

describe("after an upload", () => {
  const results: FileResult[] = [
    {
      index: 0,
      fileName: "a.csv",
      status: "REJECTED",
      reason: "EMPTY_FILE",
      message: "The file is empty.",
    },
    {
      index: 1,
      fileName: "b.csv",
      status: "DUPLICATE",
      existing: { id: "x", originalName: "b0.csv", uploadedAt: "2026-11-09T10:00:00Z" },
    },
  ];

  it("keeps only the rejected files in the list, so they can be fixed and sent again", () => {
    const rows = [row({ key: "1" }), row({ key: "2" })];
    expect(rowsAfterUpload(rows, results).map((r) => r.key)).toEqual(["1"]);
  });
});

describe("formatBytes", () => {
  it("uses B, KB and MB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
