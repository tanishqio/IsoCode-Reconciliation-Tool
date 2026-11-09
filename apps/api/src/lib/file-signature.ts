import path from "node:path";

export type UploadFormat = "CSV" | "XLS" | "XLSX";

export type SignatureResult =
  | { ok: true; format: UploadFormat }
  | { ok: false; reason: "UNSUPPORTED_EXTENSION" | "EMPTY_FILE" | "SIGNATURE_MISMATCH" };

const EXTENSION_TO_FORMAT: Record<string, UploadFormat> = {
  ".csv": "CSV",
  ".xls": "XLS",
  ".xlsx": "XLSX",
};

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export function formatFromFileName(fileName: string): UploadFormat | null {
  const extension = path.extname(fileName).toLowerCase();
  return EXTENSION_TO_FORMAT[extension] ?? null;
}

function startsWith(head: Buffer, magic: Buffer): boolean {
  return head.length >= magic.length && head.subarray(0, magic.length).equals(magic);
}

function looksLikeText(head: Buffer): boolean {
  if (startsWith(head, ZIP_MAGIC) || startsWith(head, OLE2_MAGIC)) return false;
  const isUtf16Bom =
    head.length >= 2 &&
    ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff));
  if (isUtf16Bom) return true;
  return !head.includes(0x00);
}

export function checkFileSignature(fileName: string, head: Buffer): SignatureResult {
  const format = formatFromFileName(fileName);
  if (!format) return { ok: false, reason: "UNSUPPORTED_EXTENSION" };
  if (head.length === 0) return { ok: false, reason: "EMPTY_FILE" };

  const matches =
    format === "XLSX"
      ? startsWith(head, ZIP_MAGIC)
      : format === "XLS"
        ? startsWith(head, OLE2_MAGIC)
        : looksLikeText(head);

  return matches ? { ok: true, format } : { ok: false, reason: "SIGNATURE_MISMATCH" };
}
