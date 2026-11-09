import { z } from "zod";

/**
 * Settings for the AI that proposes column mappings. With provider "none" (the default) no AI
 * is called and the rule-based suggestion is used. "openai-compatible" works with any service
 * that offers the /chat/completions API (OpenAI and several others).
 */
export interface AiConfig {
  provider: "none" | "openai-compatible";
  apiKey: string | undefined;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiUnavailableError";
  }
}

export interface AiFieldInput {
  name: string;
  label: string;
  required: boolean;
  kind: string;
}

export interface AiColumnInput {
  header: string;
  samples: string[];
}

export interface AiMappingInput {
  fileType: string;
  fields: AiFieldInput[];
  columns: AiColumnInput[];
}

const responseSchema = z.object({
  mapping: z.array(
    z.object({
      field: z.string(),
      column: z.string().nullable(),
      confidence: z.enum(["high", "medium", "low"]).catch("low"),
    }),
  ),
  notes: z.string().optional(),
});

export type AiMappingEntry = z.infer<typeof responseSchema>["mapping"][number];

const SYSTEM_PROMPT =
  "You match the column headers of a business spreadsheet to a fixed list of standard fields. " +
  "Use only the columns and fields you are given. Use each column at most once. " +
  "If you are not sure about a field, set its column to null instead of guessing. " +
  'Reply with JSON only: {"mapping":[{"field":"<field name>","column":"<column header or null>",' +
  '"confidence":"high|medium|low"}],"notes":"<short remark>"}.';

/** Asks the AI service for a mapping. Throws AiUnavailableError for any problem. */
export async function requestAiMapping(
  config: AiConfig,
  input: AiMappingInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ entries: AiMappingEntry[]; notes: string; model: string }> {
  if (config.provider === "none" || !config.apiKey) {
    throw new AiUnavailableError("No AI service is configured.");
  }

  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(input) },
        ],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch {
    throw new AiUnavailableError("The AI service did not answer in time or could not be reached.");
  }
  if (!response.ok) {
    throw new AiUnavailableError(`The AI service answered with an error (${response.status}).`);
  }

  try {
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("no content");
    const parsed = responseSchema.parse(JSON.parse(content));
    return { entries: parsed.mapping, notes: parsed.notes ?? "", model: config.model };
  } catch {
    throw new AiUnavailableError("The AI service sent an answer that could not be understood.");
  }
}
