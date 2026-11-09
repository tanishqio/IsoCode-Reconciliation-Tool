import type { PrismaClient } from "../../../generated/prisma/client.js";
import { computeExpected, linesToAmounts, type CalcRule } from "../rate-cards/expected-amount.js";
import { decimalToPaise, paiseToAmount } from "../rate-cards/money.js";
import { isReturned } from "../reconciliation/settle.js";

// The proof behind each claimed order: how the expected amount was worked out, what counted as
// received, and every matched line with its source file and row number. Built from the stored
// results and lines. It holds no customer data (none is ever stored).

export interface EvidenceLine {
  kind: "Settlement" | "COD remittance" | "Freight invoice" | "Return scan";
  partner: string | null;
  date: string | null;
  reference: string | null;
  amount: string | null;
  file: string;
  row: number;
}

export interface Evidence {
  order: {
    orderId: string;
    channel: string;
    courier: string | null;
    awb: string | null;
    orderDate: string;
    deliveredAt: string | null;
    returnedAt: string | null;
    value: string;
    paymentType: string;
    deliveryStatus: string;
    weightGrams: number | null;
  };
  result: {
    status: string;
    expected: string | null;
    received: string | null;
    difference: string | null;
    freightExpected: string | null;
    freightBilled: string;
    dueDate: string | null;
    asOf: string;
    computedAt: string;
    rateCardVersion: number | null;
    rateCardIsSample: boolean | null;
  };
  working: { label: string; amount: string }[];
  received: { label: string; amount: string }[];
  lines: EvidenceLine[];
}

const CHUNK = 500;
const iso = (date: Date | null) => (date ? date.toISOString() : null);

/** Evidence for many orders, a few queries per chunk of orders (not per order). */
export async function buildEvidence(
  prisma: PrismaClient,
  orderPks: readonly string[],
): Promise<Map<string, Evidence>> {
  const out = new Map<string, Evidence>();
  const cards = await prisma.rateCard.findMany({
    include: { rules: { orderBy: { sortOrder: "asc" } } },
  });
  const rulesOf = new Map<string, CalcRule[]>(
    cards.map((card) => [
      card.id,
      card.rules.map((rule) => ({
        ruleType: rule.ruleType,
        minWeightGrams: rule.minWeightGrams,
        maxWeightGrams: rule.maxWeightGrams,
        basisPoints: rule.basisPoints,
        amountPaise: rule.amount === null ? null : decimalToPaise(rule.amount),
      })),
    ]),
  );
  const cardById = new Map(cards.map((card) => [card.id, card]));

  for (let from = 0; from < orderPks.length; from += CHUNK) {
    const pks = orderPks.slice(from, from + CHUNK);
    const [results, settlement, cod, freight, scans] = await Promise.all([
      prisma.orderResult.findMany({
        where: { orderPk: { in: pks } },
        include: {
          order: {
            include: { channel: { select: { name: true } }, courier: { select: { name: true } } },
          },
        },
      }),
      prisma.settlementLine.findMany({
        where: { orderPk: { in: pks } },
        include: {
          sourceFile: { select: { originalName: true } },
          source: { select: { name: true } },
        },
      }),
      prisma.codRemittanceLine.findMany({
        where: { orderPk: { in: pks } },
        include: {
          sourceFile: { select: { originalName: true } },
          aggregator: { select: { name: true } },
        },
      }),
      prisma.freightLine.findMany({
        where: { orderPk: { in: pks } },
        include: {
          sourceFile: { select: { originalName: true } },
          aggregator: { select: { name: true } },
        },
      }),
      prisma.returnScan.findMany({
        where: { orderPk: { in: pks } },
        include: { sourceFile: { select: { originalName: true } } },
      }),
    ]);

    const linesOf = new Map<string, EvidenceLine[]>();
    const push = (orderPk: string | null, line: EvidenceLine) => {
      if (!orderPk) return;
      const list = linesOf.get(orderPk) ?? [];
      list.push(line);
      linesOf.set(orderPk, list);
    };
    for (const line of settlement) {
      push(line.orderPk, {
        kind: "Settlement",
        partner: line.source.name,
        date: iso(line.settledOn),
        reference: line.lineRef,
        amount: line.netReceived.toFixed(2),
        file: line.sourceFile.originalName,
        row: line.sourceRowNumber,
      });
    }
    for (const line of cod) {
      push(line.orderPk, {
        kind: "COD remittance",
        partner: line.aggregator.name,
        date: iso(line.remittedOn),
        reference: line.remittanceRef,
        amount: line.remittedAmount.toFixed(2),
        file: line.sourceFile.originalName,
        row: line.sourceRowNumber,
      });
    }
    for (const line of freight) {
      push(line.orderPk, {
        kind: "Freight invoice",
        partner: line.aggregator.name,
        date: iso(line.chargedOn),
        reference: `${line.invoiceNo} (${line.chargeType.toLowerCase().replace("_", " ")})`,
        amount: line.billedAmount.toFixed(2),
        file: line.sourceFile.originalName,
        row: line.sourceRowNumber,
      });
    }
    for (const line of scans) {
      push(line.orderPk, {
        kind: "Return scan",
        partner: null,
        date: iso(line.scannedAt),
        reference: null,
        amount: null,
        file: line.sourceFile.originalName,
        row: line.sourceRowNumber,
      });
    }

    for (const row of results) {
      const order = row.order;
      let working: { label: string; amount: string }[] = [];
      const rules = row.rateCardId ? rulesOf.get(row.rateCardId) : undefined;
      if (rules) {
        const calc = computeExpected(rules, {
          orderValuePaise: decimalToPaise(order.value),
          paymentType: order.paymentType,
          weightGrams: order.weightGrams,
          isReturn: isReturned(order),
        });
        if (calc.ok) working = linesToAmounts(calc.lines);
      }
      const received: { label: string; amount: string }[] = [];
      const part = (label: string, value: { toFixed(digits: number): string }, negate = false) => {
        const paise = decimalToPaise(value);
        if (paise !== 0n) received.push({ label, amount: paiseToAmount(negate ? -paise : paise) });
      };
      part("Settlement payout (net)", row.settlementNet);
      part("GST TCS withheld (added back)", row.tcs);
      part("Income tax TDS withheld (added back)", row.tds);
      part("COD remittance", row.codRemitted);
      if (isReturned(order)) part("Return freight billed (deducted)", row.returnFreight, true);

      const card = row.rateCardId ? cardById.get(row.rateCardId) : undefined;
      out.set(row.orderPk, {
        order: {
          orderId: order.orderId,
          channel: order.channel.name,
          courier: order.courier?.name ?? null,
          awb: order.awb,
          orderDate: order.orderDate.toISOString(),
          deliveredAt: iso(order.deliveredAt),
          returnedAt: iso(order.returnedAt),
          value: order.value.toFixed(2),
          paymentType: order.paymentType,
          deliveryStatus: order.deliveryStatus,
          weightGrams: order.weightGrams,
        },
        result: {
          status: row.status,
          expected: row.expected?.toFixed(2) ?? null,
          received: row.received?.toFixed(2) ?? null,
          difference: row.difference?.toFixed(2) ?? null,
          freightExpected: row.freightExpected?.toFixed(2) ?? null,
          freightBilled: row.freightBilled.toFixed(2),
          dueDate: iso(row.dueDate),
          asOf: row.asOf.toISOString(),
          computedAt: row.computedAt.toISOString(),
          rateCardVersion: card?.versionNo ?? null,
          rateCardIsSample: card ? card.isSampleData : null,
        },
        working,
        received,
        lines: (linesOf.get(row.orderPk) ?? []).sort((a, b) =>
          (a.date ?? "").localeCompare(b.date ?? ""),
        ),
      });
    }
  }
  return out;
}
