import type { FileType } from "../../../generated/prisma/enums.js";
import { FIELD_SPECS } from "../ingestion/fields.js";
import { normaliseHeader } from "../../lib/header-signature.js";

// Customer name, phone and address are personal data (DPDP Act 2023). A column that looks like
// one of them is never offered as a mapping target, never read, and never sent to the AI.
const PERSONAL_WORDS = new Set([
  "name",
  "names",
  "phone",
  "mobile",
  "contact",
  "email",
  "mail",
  "address",
  "addr",
  "pincode",
  "pin",
  "postal",
  "zip",
  "city",
  "customer",
  "buyer",
  "recipient",
  "consignee",
  "whatsapp",
  "landline",
  "aadhaar",
  "pan",
]);

export function compactHeader(header: string): string {
  return normaliseHeader(header).replace(/[^a-z0-9]/g, "");
}

function words(header: string): string[] {
  return header
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
}

/** Headers that are standard for this file type, such as "Courier Name", are not personal data. */
function standardHeaders(fileType: FileType): Set<string> {
  const keys = new Set<string>();
  for (const spec of FIELD_SPECS[fileType]) {
    keys.add(compactHeader(spec.name));
    for (const alias of spec.aliases) keys.add(compactHeader(alias));
  }
  return keys;
}

export function isPersonalHeader(header: string, fileType: FileType): boolean {
  if (standardHeaders(fileType).has(compactHeader(header))) return false;
  return words(header).some((word) => PERSONAL_WORDS.has(word));
}

/** Sample values that look like a phone number or an e-mail address are never passed on. */
export function looksPersonalValue(value: string): boolean {
  return /@/.test(value) || /^\+?\d[\d\s-]{8,}$/.test(value.trim());
}
