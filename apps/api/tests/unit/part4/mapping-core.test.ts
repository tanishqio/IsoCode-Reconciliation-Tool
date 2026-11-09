import { describe, expect, it } from "vitest";
import type { AiConfig } from "../../../src/modules/mapping/ai-client.js";
import { buildPreview } from "../../../src/modules/mapping/preview.js";
import { isPersonalHeader } from "../../../src/modules/mapping/personal.js";
import { createSuggester, suggestByRules } from "../../../src/modules/mapping/suggest.js";
import { resolveColumnMap } from "../../../src/modules/ingestion/fields.js";

const HEADERS = [
  "Ref No",
  "Placed On",
  "Amount Payable",
  "Pay Mode",
  "Shipment State",
  "Customer Mobile",
];
const SAMPLE_ROWS = [
  ["A-1", "2026-11-03", "1,499.00", "COD", "Delivered", "9876543210"],
  ["A-2", "2026-11-04", "899", "Prepaid", "Delivered", "9123456780"],
];

const aiConfig: AiConfig = {
  provider: "openai-compatible",
  apiKey: "test-key",
  baseUrl: "http://ai.test/v1",
  model: "test-model",
  timeoutMs: 1000,
};

/** A fake fetch that answers like an OpenAI-compatible service and remembers what it was sent. */
function fakeAi(answer: unknown, status = 200) {
  const sent: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push(String(init.body));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }),
      { status },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

describe("personal data columns", () => {
  it("flags personal-looking headers but not standard ones", () => {
    expect(isPersonalHeader("Customer Mobile", "ORDERS")).toBe(true);
    expect(isPersonalHeader("Shipping Address", "ORDERS")).toBe(true);
    expect(isPersonalHeader("customerPhone", "ORDERS")).toBe(true);
    expect(isPersonalHeader("Courier Name", "ORDERS")).toBe(false); // a standard header
    expect(isPersonalHeader("Capacity", "ORDERS")).toBe(false); // "city" inside a word
    expect(isPersonalHeader("Delivery Status", "ORDERS")).toBe(false);
  });
});

describe("rule-based suggestion", () => {
  it("uses known names first and the closest word overlap second, with different confidence", () => {
    const result = suggestByRules("SETTLEMENT", [
      "Settlement Date",
      "Net Payout Amount",
      "Order ID",
    ]);
    expect(result.columnMap).toMatchObject({
      settledOn: "Settlement Date",
      orderId: "Order ID",
      netReceived: "Net Payout Amount",
    });
    expect(result.fieldInfo["orderId"]?.confidence).toBe("high");
    expect(result.fieldInfo["netReceived"]).toEqual({ source: "rule", confidence: "low" });
  });
});

describe("AI suggestion, including when the AI is wrong or unsure", () => {
  const input = { fileType: "ORDERS", headers: HEADERS, sampleRows: SAMPLE_ROWS } as const;

  it("uses the AI's answer, drops what cannot be right, and says so", async () => {
    const { fetchImpl, sent } = fakeAi({
      mapping: [
        { field: "orderId", column: "Ref No", confidence: "high" },
        { field: "orderDate", column: "Placed On", confidence: "high" },
        { field: "value", column: "Amount Payable", confidence: "medium" },
        { field: "paymentType", column: "Pay Mode", confidence: "high" },
        { field: "deliveryStatus", column: "Shipment State", confidence: "low" },
        { field: "awb", column: "Tracking Code", confidence: "high" }, // not in the file
        { field: "courier", column: "Customer Mobile", confidence: "high" }, // personal data
        { field: "weightGrams", column: null, confidence: "low" }, // the AI is not sure
        { field: "madeUpField", column: "Ref No", confidence: "high" }, // not a standard field
      ],
      notes: "Shipment State looks like the delivery status.",
    });
    const suggestion = await createSuggester(aiConfig, fetchImpl).suggest(input);

    expect(suggestion.origin).toBe("AI");
    expect(suggestion.aiModel).toBe("test-model");
    expect(suggestion.columnMap).toEqual({
      orderId: "Ref No",
      orderDate: "Placed On",
      value: "Amount Payable",
      paymentType: "Pay Mode",
      deliveryStatus: "Shipment State",
    });
    expect(Object.keys(suggestion.columnMap)).toHaveLength(5);
    expect(suggestion.fieldInfo).not.toHaveProperty("awb");
    expect(suggestion.fieldInfo["deliveryStatus"]).toEqual({ source: "ai", confidence: "low" });
    expect(suggestion.notes.join(" ")).toContain("Ignored AI answers that cannot be right");
    expect(suggestion.ignoredColumns).toEqual(["Customer Mobile"]);

    // Personal data never leaves the server: not the column, not its values.
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("Customer Mobile");
    expect(sent[0]).not.toContain("9876543210");
    expect(sent[0]).toContain("1,499.00"); // ordinary sample values are sent
  });

  it("falls back to the rules, and says so, when the AI fails or talks nonsense", async () => {
    const down = await createSuggester(aiConfig, fakeAi({}, 500).fetchImpl).suggest(input);
    expect(down.origin).toBe("FALLBACK");
    expect(down.aiModel).toBeNull();
    expect(down.notes.join(" ")).toContain("fixed rules");

    const nonsense = await createSuggester(aiConfig, fakeAi({ mapping: "nope" }).fetchImpl).suggest(
      input,
    );
    expect(nonsense.origin).toBe("FALLBACK");

    const none = await createSuggester({ ...aiConfig, provider: "none" }).suggest(input);
    expect(none.origin).toBe("FALLBACK");
  });
});

describe("20-row preview", () => {
  it("shows cleaned values and the reason a row would be rejected, and stops at 20 rows", () => {
    const headers = ["Order ID", "Order Date", "Order Value", "Payment Mode", "Status"];
    const rows = Array.from({ length: 30 }, (_, i) => ({
      rowNumber: i + 2,
      cells: [`O-${i}`, i === 3 ? "someday" : "2026-11-03", "₹1,499", "COD", "Delivered"],
    }));
    const mapping = resolveColumnMap("ORDERS", headers);
    const preview = buildPreview("ORDERS", { headers, rows }, mapping.indexes);

    expect(preview.rows).toHaveLength(20);
    expect(preview.rows[0]?.values["value"]).toBe("1499.00");
    expect(preview.rows[3]?.error?.code).toBe("BAD_DATE");
    expect(preview.rowsWithProblems).toBe(1);
  });
});
