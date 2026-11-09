import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ErrorState, LoadingState } from "../../components/feedback";
import { Button, SelectField, TextField } from "../../components/ui";
import { getErrorMessage, getFieldErrors, isApiError } from "../../lib/api-error";
import { listSources, SOURCES_KEY } from "../uploads/uploads-api";
import {
  createRateCard,
  RATE_CARDS_KEY,
  saveNewVersion,
  type RateCard,
  type RuleType,
} from "./rate-cards-api";
import {
  RULE_TYPE_HELP,
  RULE_TYPE_LABELS,
  RULE_TYPES,
  cardTitle,
  draftFromRule,
  emptyDraft,
  hasErrors,
  placeServerErrors,
  toRuleInputs,
  validateDrafts,
  type DraftErrors,
  type DraftField,
  type DraftRule,
} from "./rate-cards-model";

export type FormState = { mode: "create" } | { mode: "edit"; card: RateCard };

const CHANNEL_KINDS = ["WEBSITE", "MARKETPLACE", "QUICK_COMMERCE"];
const RULE_OPTIONS = RULE_TYPES.map((value) => ({ value, label: RULE_TYPE_LABELS[value] }));

export function RateCardFormDialog({
  state,
  onClose,
  onSaved,
}: {
  state: FormState | null;
  onClose: () => void;
  onSaved: (card: RateCard) => void;
}) {
  return (
    <Dialog.Root open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          // Keeps a half-filled form safe from a stray click on the dark area.
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-ui border border-border bg-page p-5 shadow-overlay"
        >
          {/* Mounted only while open, so the form starts fresh every time. */}
          {state ? <CardForm state={state} onClose={onClose} onSaved={onSaved} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CardForm({
  state,
  onClose,
  onSaved,
}: {
  state: FormState;
  onClose: () => void;
  onSaved: (card: RateCard) => void;
}) {
  const queryClient = useQueryClient();
  const editing = state.mode === "edit" ? state.card : null;

  const [channelId, setChannelId] = useState("");
  const [courierId, setCourierId] = useState("");
  const [note, setNote] = useState(editing?.note ?? "");
  const [isSample, setIsSample] = useState(editing?.isSampleData ?? false);
  const [drafts, setDrafts] = useState<DraftRule[]>(
    editing ? editing.rules.map(draftFromRule) : [emptyDraft("FIXED_FEE")],
  );
  const [errors, setErrors] = useState<DraftErrors>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);

  const sources = useQuery({
    queryKey: SOURCES_KEY,
    queryFn: ({ signal }) => listSources(signal),
    enabled: editing === null,
  });

  const mutation = useMutation({
    mutationFn: () => {
      const rules = toRuleInputs(drafts);
      const trimmedNote = note.trim() === "" ? null : note.trim();
      return editing
        ? saveNewVersion(editing.id, { rules, note: trimmedNote, isSampleData: isSample })
        : createRateCard({
            channelSourceId: channelId,
            courierSourceId: courierId === "" ? null : courierId,
            rules,
            note: trimmedNote,
            isSampleData: isSample,
          });
    },
    onSuccess: (card) => {
      void queryClient.invalidateQueries({ queryKey: RATE_CARDS_KEY });
      onSaved(card);
    },
    onError: (error) => {
      const placed = placeServerErrors(drafts, getFieldErrors(error));
      setErrors(placed.rows);
      // A message that is not about one row (no channel, a card that already exists, a lost session).
      setFormErrors(
        placed.other.length > 0
          ? placed.other
          : hasErrors(placed.rows)
            ? []
            : [getErrorMessage(error)],
      );
    },
  });

  function updateDraft(key: string, change: Partial<DraftRule>) {
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)),
    );
    // Editing a row clears that row's messages; they come back on the next save if still wrong.
    setErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const found = validateDrafts(drafts);
    const problems: string[] = [];
    if (!editing && channelId === "") problems.push("Choose the channel this card is for.");
    if (drafts.length === 0) problems.push("Add at least one fee.");
    setErrors(found);
    setFormErrors(problems);
    if (hasErrors(found) || problems.length > 0) return;
    mutation.mutate();
  }

  const sourceList = sources.data ?? [];
  const channelOptions = sourceList
    .filter((source) => CHANNEL_KINDS.includes(source.kind))
    .map((source) => ({ value: source.id, label: source.name }));
  const courierOptions = sourceList
    .filter((source) => source.kind === "COURIER_AGGREGATOR")
    .map((source) => ({ value: source.id, label: source.name }));

  const title = editing ? `Edit ${cardTitle(editing)}` : "New rate card";

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <Dialog.Title className="text-section font-semibold text-ink">{title}</Dialog.Title>
      <p className="mt-1 text-body text-ink-2">
        {editing
          ? `Saving makes version ${editing.versionNo + 1}. Version ${editing.versionNo} is kept, so earlier results still point at the rates they used.`
          : "Choose who the price list is for, then add its fees."}
      </p>

      <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-auto pr-1">
        {!editing ? (
          sources.isPending ? (
            <LoadingState label={"Loading channels\u2026"} rows={2} />
          ) : sources.isError ? (
            <ErrorState
              message={getErrorMessage(sources.error)}
              requestId={isApiError(sources.error) ? sources.error.requestId : undefined}
              onRetry={() => void sources.refetch()}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField
                label="Channel"
                placeholder="Choose a channel"
                options={channelOptions}
                value={channelId}
                onChange={(event) => setChannelId(event.target.value)}
              />
              <SelectField
                label="Courier (optional)"
                placeholder="No courier (channel only)"
                options={courierOptions}
                value={courierId}
                onChange={(event) => setCourierId(event.target.value)}
              />
            </div>
          )
        ) : null}

        <TextField
          label="Note (optional)"
          maxLength={200}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <label className="inline-flex items-center gap-2 text-body text-ink">
          <input
            type="checkbox"
            checked={isSample}
            onChange={(event) => setIsSample(event.target.checked)}
            className="size-4 accent-accent"
          />
          These are sample values, not real rates
        </label>

        <section aria-labelledby="fees-heading" className="flex flex-col gap-3">
          <h3 id="fees-heading" className="text-body font-semibold text-ink">
            Fees
          </h3>
          {drafts.map((draft, index) => (
            <FeeRow
              key={draft.key}
              draft={draft}
              position={index + 1}
              errors={errors[draft.key]}
              onChange={(change) => updateDraft(draft.key, change)}
              onRemove={() =>
                setDrafts((current) => current.filter((item) => item.key !== draft.key))
              }
            />
          ))}
          <div>
            <Button
              variant="secondary"
              onClick={() => setDrafts((current) => [...current, emptyDraft("FREIGHT_SLAB")])}
            >
              <Plus aria-hidden="true" className="size-4" strokeWidth={1.75} />
              Add a fee
            </Button>
          </div>
        </section>
      </div>

      {formErrors.length > 0 ? (
        <ul role="alert" className="mt-3 flex flex-col gap-1 text-cell text-risk">
          {formErrors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={mutation.isPending}>
          {mutation.isPending
            ? "Saving\u2026"
            : editing
              ? `Save as version ${editing.versionNo + 1}`
              : "Save rate card"}
        </Button>
      </div>
    </form>
  );
}

function FeeRow({
  draft,
  position,
  errors,
  onChange,
  onRemove,
}: {
  draft: DraftRule;
  position: number;
  errors: Partial<Record<DraftField, string>> | undefined;
  onChange: (change: Partial<DraftRule>) => void;
  onRemove: () => void;
}) {
  return (
    <fieldset className="rounded-ui border border-border p-3">
      <legend className="sr-only">Fee {position}</legend>
      <div className="flex items-end gap-2">
        <SelectField
          className="flex-1"
          label="Type of fee"
          options={RULE_OPTIONS}
          value={draft.ruleType}
          aria-invalid={errors?.ruleType ? true : undefined}
          onChange={(event) => onChange({ ruleType: event.target.value as RuleType })}
        />
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Remove fee ${position}`}
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </Button>
      </div>
      <p className="mt-1 text-label text-muted">{RULE_TYPE_HELP[draft.ruleType]}</p>
      {errors?.ruleType ? <p className="mt-1 text-label text-risk">{errors.ruleType}</p> : null}

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {draft.ruleType === "COMMISSION" ? (
          <TextField
            label="Percentage (%)"
            inputMode="decimal"
            placeholder="20"
            value={draft.percent}
            error={errors?.percent}
            onChange={(event) => onChange({ percent: event.target.value })}
          />
        ) : (
          <TextField
            label="Amount (₹)"
            inputMode="decimal"
            placeholder="60"
            value={draft.amount}
            error={errors?.amount}
            onChange={(event) => onChange({ amount: event.target.value })}
          />
        )}
        {draft.ruleType === "FREIGHT_SLAB" ? (
          <>
            <TextField
              label="From weight (g)"
              inputMode="numeric"
              placeholder="0"
              value={draft.minWeight}
              error={errors?.minWeight}
              onChange={(event) => onChange({ minWeight: event.target.value })}
            />
            <TextField
              label="Up to weight (g)"
              inputMode="numeric"
              placeholder="No limit"
              value={draft.maxWeight}
              error={errors?.maxWeight}
              onChange={(event) => onChange({ maxWeight: event.target.value })}
            />
          </>
        ) : null}
      </div>
    </fieldset>
  );
}
