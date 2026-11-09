import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, Money, SelectField, TextField } from "../../components/ui";
import { getErrorMessage } from "../../lib/api-error";
import { calculateExpected, type PaymentType, type RateCard } from "./rate-cards-api";
import { AMOUNT_PATTERN } from "./rate-cards-model";

const PAYMENT_OPTIONS = [
  { value: "COD", label: "Cash on delivery" },
  { value: "PREPAID", label: "Prepaid" },
];

/**
 * "What would this card expect for an order like this?" It asks the server, which uses the same
 * calculation the matching step will use, so what is shown here is what will be compared later.
 */
export function ExpectedAmountCheck({ card }: { card: RateCard }) {
  const [orderValue, setOrderValue] = useState("");
  const [payment, setPayment] = useState<PaymentType>("COD");
  const [weight, setWeight] = useState("");
  const [isReturn, setIsReturn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const mutation = useMutation({ mutationFn: calculateExpected });

  const dependsOnWeight = card.rules.some((rule) => rule.ruleType === "FREIGHT_SLAB");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!AMOUNT_PATTERN.test(orderValue.trim())) {
      setProblem("Enter the order value in rupees, like 1499 or 1499.50.");
      return;
    }
    if (weight.trim() !== "" && !/^\d{1,7}$/.test(weight.trim())) {
      setProblem("Enter the weight in whole grams, like 450.");
      return;
    }
    setProblem(null);
    mutation.mutate({
      rateCardId: card.id,
      paymentType: payment,
      orderValue: orderValue.trim(),
      weightGrams: weight.trim() === "" ? null : Number(weight),
      isReturn,
    });
  }

  const result = mutation.data;

  return (
    <section aria-labelledby={`check-${card.id}`} className="border-t border-border pt-4">
      <h3 id={`check-${card.id}`} className="text-body font-semibold text-ink">
        Check an amount
      </h3>
      <p className="mt-0.5 text-body text-muted">
        Try an order to see the amount this version of the card would expect.
      </p>

      <form onSubmit={submit} className="mt-3 flex flex-col gap-3" noValidate>
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField
            label="Order value (₹)"
            inputMode="decimal"
            placeholder="1499"
            value={orderValue}
            onChange={(event) => setOrderValue(event.target.value)}
          />
          <SelectField
            label="Payment"
            options={PAYMENT_OPTIONS}
            value={payment}
            onChange={(event) => setPayment(event.target.value as PaymentType)}
          />
          <TextField
            label="Weight (g)"
            inputMode="numeric"
            placeholder={dependsOnWeight ? "450" : "Not needed"}
            value={weight}
            onChange={(event) => setWeight(event.target.value)}
          />
        </div>
        <label className="inline-flex items-center gap-2 text-body text-ink">
          <input
            type="checkbox"
            checked={isReturn}
            onChange={(event) => setIsReturn(event.target.checked)}
            className="size-4 accent-accent"
          />
          The order was returned
        </label>
        <div>
          <Button type="submit" variant="secondary" disabled={mutation.isPending}>
            {mutation.isPending ? "Working it out\u2026" : "Work out the amount"}
          </Button>
        </div>
      </form>

      <div aria-live="polite" className="mt-3">
        {problem ? <p className="text-cell text-risk">{problem}</p> : null}
        {!problem && mutation.isError ? (
          <p className="text-cell text-risk">{getErrorMessage(mutation.error)}</p>
        ) : null}
        {!problem && result && !result.ok ? (
          <p className="rounded-ui border border-border bg-surface px-3 py-2 text-body text-ink-2">
            {result.message}
          </p>
        ) : null}
        {!problem && result?.ok ? (
          <dl className="rounded-ui border border-border">
            {result.lines.map((line) => (
              <div
                key={line.label}
                className="flex items-baseline justify-between gap-4 border-b border-border px-3 py-2 text-cell"
              >
                <dt className="text-ink-2">{line.label}</dt>
                <dd>
                  <Money amount={line.amount} />
                </dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-4 bg-surface px-3 py-2 text-body font-semibold">
              <dt>Expected amount</dt>
              <dd>
                <Money amount={result.expected} />
              </dd>
            </div>
          </dl>
        ) : null}
      </div>
    </section>
  );
}
