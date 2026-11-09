// One real call to the AI service set in apps/api/.env. Prints the result, never the key.
//   cd apps/api; npx tsx scripts/check-ai.ts
export {};
const { createConfiguredSuggester } = await import("../src/modules/mapping/mapping.routes.js");
const { env } = await import("../src/config/env.js");

const headers = [
  "Ref No",
  "Placed On",
  "Amount Payable",
  "Pay Mode",
  "Shipment State",
  "Tracking Code",
  "Customer Mobile",
  "Buyer Name",
];
const sampleRows = [
  ["A-1", "2026-11-03", "1,499.00", "COD", "Delivered", "AWB123456", "9876543210", "Asha Rao"],
  ["A-2", "03/11/2026", "899", "Prepaid", "Returned", "AWB123457", "9123456780", "Ravi Kumar"],
];
console.log("provider:", env.AI_PROVIDER, "| model:", env.AI_MODEL, "| url:", env.AI_BASE_URL);
const started = Date.now();
const result = await createConfiguredSuggester().suggest({
  fileType: "ORDERS",
  headers,
  sampleRows,
});
console.log(
  JSON.stringify(
    {
      ms: Date.now() - started,
      origin: result.origin,
      aiModel: result.aiModel,
      columnMap: result.columnMap,
      fieldInfo: result.fieldInfo,
      ignoredColumns: result.ignoredColumns,
      notes: result.notes,
    },
    null,
    2,
  ),
);
process.exit(0);
