import { readFileSync } from "node:fs";
import path from "node:path";
import type { Manifest } from "./write.js";

// Loads a generated sample folder into a running LeakLens API the way a person would: sign in as the
// finance executive, upload the files, approve the suggested column mapping for each new layout,
// wait for the worker to read the files, then ask for the results to be calculated.
// It only uses the public API, so it also checks that the API, worker and database work together.

export interface LoadOptions {
  /** For example http://localhost:4000 */
  baseUrl: string;
  email: string;
  password: string;
  /** A folder made by scripts/generate-sample-data.ts. */
  dir: string;
  log?: (message: string) => void;
  /** How long to wait for the worker, in milliseconds. */
  timeoutMs?: number;
  /** Ask for the results to be calculated at the end. Default true. */
  calculate?: boolean;
}

export interface LoadResult {
  files: number;
  uploaded: number;
  alreadyThere: number;
  refused: { file: string; reason: string }[];
  mappingsApproved: number;
  needsAttention: { file: string; reason: string }[];
  finished: { file: string; status: string; saved: number | null; rejected: number | null }[];
  calculation: { status: string; orderCount: number } | null;
}

// The API replies are read loosely: this is a development tool, and each field is checked where it is used.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const TERMINAL = new Set(["COMPLETED", "COMPLETED_WITH_REJECTS", "FAILED"]);
const MAX_FILES_PER_REQUEST = 5;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface UploadedFileInfo {
  id: string;
  originalName: string;
  status: string;
  rowsAccepted?: number | null;
  rowsRejected?: number | null;
}

export async function loadDemoData(options: LoadOptions): Promise<LoadResult> {
  const log = options.log ?? (() => undefined);
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const manifest = JSON.parse(
    readFileSync(path.join(options.dir, "manifest.json"), "utf8"),
  ) as Manifest;

  let cookie = "";
  let csrf = "";

  async function request(
    method: string,
    route: string,
    body?: { json?: unknown; form?: FormData },
  ): Promise<{ status: number; data: Loose }> {
    const headers: Record<string, string> = {};
    if (cookie) headers["cookie"] = cookie;
    if (method !== "GET" && csrf) headers["x-csrf-token"] = csrf;
    let payload: BodyInit | undefined;
    if (body?.json !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body.json);
    } else if (body?.form) {
      payload = body.form;
    }
    const response = await fetch(`${options.baseUrl}${route}`, { method, headers, body: payload });
    const text = await response.text();
    let data: Loose;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: response.status, data };
  }

  const fail = (what: string, result: { status: number; data: Loose }): never => {
    const message = result.data?.error?.message ?? String(result.data).slice(0, 120);
    throw new Error(`${what} failed (${result.status}): ${message}`);
  };

  // 1. Sign in ------------------------------------------------------------------------------------
  const login = await fetch(`${options.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: options.email, password: options.password }),
  });
  const loginBody = (await login.json().catch(() => null)) as { csrfToken?: string } | null;
  const sid = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0] ?? "")
    .find((pair) => pair.startsWith("sid="));
  if (!login.ok || !sid || !loginBody?.csrfToken) {
    throw new Error(`Sign-in failed (${login.status}). Check the email and password.`);
  }
  cookie = sid;
  csrf = loginBody.csrfToken;
  log("Signed in as the finance executive.");

  // 2. Sources ------------------------------------------------------------------------------------
  const sources = await request("GET", "/api/sources");
  if (sources.status !== 200) fail("Reading the partner list", sources);
  const sourceIdByName = new Map<string, string>(
    (sources.data.items as { id: string; name: string }[]).map((source) => [
      source.name,
      source.id,
    ]),
  );

  // 3. Upload, five files at a time -------------------------------------------------------------------
  const result: LoadResult = {
    files: manifest.files.length,
    uploaded: 0,
    alreadyThere: 0,
    refused: [],
    mappingsApproved: 0,
    needsAttention: [],
    finished: [],
    calculation: null,
  };
  const uploaded: UploadedFileInfo[] = [];

  for (let from = 0; from < manifest.files.length; from += MAX_FILES_PER_REQUEST) {
    const batch = manifest.files.slice(from, from + MAX_FILES_PER_REQUEST);
    const form = new FormData();
    form.append(
      "items",
      JSON.stringify(
        batch.map((file) => {
          const sourceId = sourceIdByName.get(file.source);
          if (!sourceId)
            throw new Error(`The API has no partner called "${file.source}". Run the seed first.`);
          return { sourceId, fileType: file.fileType };
        }),
      ),
    );
    for (const file of batch) {
      const bytes = readFileSync(path.join(options.dir, file.name));
      form.append("files", new Blob([new Uint8Array(bytes)]), file.name);
    }
    const response = await request("POST", "/api/uploads", { form });
    if (![201, 409, 422].includes(response.status)) fail("Uploading files", response);
    for (const entry of response.data.results as Loose[]) {
      if (entry.status === "ACCEPTED") {
        result.uploaded += 1;
        uploaded.push(entry.file as UploadedFileInfo);
      } else if (entry.status === "DUPLICATE") {
        result.alreadyThere += 1;
      } else {
        result.refused.push({ file: entry.fileName, reason: entry.message ?? entry.reason });
      }
    }
    log(
      `Uploaded ${Math.min(from + MAX_FILES_PER_REQUEST, manifest.files.length)} of ${manifest.files.length} files.`,
    );
  }

  // 4. Approve the suggested mapping for every layout that is new ---------------------------------------
  for (const file of uploaded) {
    const current = await request("GET", `/api/uploads/${file.id}`);
    if (current.status !== 200 || current.data.status !== "NEEDS_MAPPING") continue;
    const suggestion = await request("POST", `/api/uploads/${file.id}/mapping/suggest`, {
      json: {},
    });
    if (suggestion.status !== 200)
      fail(`Suggesting a mapping for ${file.originalName}`, suggestion);
    if ((suggestion.data.missing as string[]).length > 0) {
      result.needsAttention.push({
        file: file.originalName,
        reason: `needs a person: no column found for ${(suggestion.data.missing as string[]).join(", ")}`,
      });
      continue;
    }
    const approval = await request("POST", `/api/uploads/${file.id}/mapping/approve`, {
      json: { proposalId: suggestion.data.proposalId, columnMap: suggestion.data.columnMap },
    });
    if (approval.status !== 200) fail(`Approving the mapping for ${file.originalName}`, approval);
    result.mappingsApproved += 1;
    log(`Approved the column mapping for ${file.originalName}.`);
  }

  // 5. Wait for the worker to read every file ----------------------------------------------------------
  const ours = new Set(uploaded.map((file) => file.id));
  const deadline = Date.now() + timeoutMs;
  const waitingOnPerson = new Set(result.needsAttention.map((entry) => entry.file));
  for (;;) {
    const list = await request("GET", "/api/uploads?limit=100");
    if (list.status !== 200) fail("Reading the file list", list);
    const mine = (list.data.items as (UploadedFileInfo & { status: string })[]).filter((file) =>
      ours.has(file.id),
    );
    const open = mine.filter(
      (file) => !TERMINAL.has(file.status) && !waitingOnPerson.has(file.originalName),
    );
    if (open.length === 0) {
      result.finished = mine.map((file) => ({
        file: file.originalName,
        status: file.status,
        saved: file.rowsAccepted ?? null,
        rejected: file.rowsRejected ?? null,
      }));
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Gave up waiting: ${open.length} file(s) are still being read. Is the worker running (npm run dev starts it)?`,
      );
    }
    await sleep(500);
  }
  log(`The worker read ${result.finished.length} files.`);

  // 6. Calculate the results ---------------------------------------------------------------------------
  if (options.calculate !== false) {
    const run = await request("POST", "/api/reconciliation/run", { json: {} });
    if (run.status !== 202) fail("Starting the calculation", run);
    for (;;) {
      const status = await request("GET", "/api/reconciliation/status");
      if (status.status !== 200) fail("Reading the calculation status", status);
      const job = status.data.job as { status: string; errorMessage: string | null } | null;
      if (job && (job.status === "SUCCEEDED" || job.status === "FAILED")) {
        if (job.status === "FAILED")
          throw new Error(`The calculation failed: ${job.errorMessage ?? "no reason given"}`);
        result.calculation = { status: job.status, orderCount: status.data.orderCount };
        break;
      }
      if (Date.now() > deadline) throw new Error("Gave up waiting for the calculation to finish.");
      await sleep(500);
    }
    log(`Calculated results for ${result.calculation.orderCount} orders.`);
  }

  return result;
}
