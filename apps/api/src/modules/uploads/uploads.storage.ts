import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

export function buildStoragePath(
  fileId: string,
  extension: string,
  now: Date = new Date(),
): string {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return path.posix.join(year, month, `${fileId}${extension.toLowerCase()}`);
}

export function resolveInside(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const rootWithSeparator = path.resolve(root) + path.sep;
  if (!resolved.startsWith(rootWithSeparator)) {
    throw new Error("Path escapes the storage folder.");
  }
  return resolved;
}

export async function moveIntoStorage(
  tempPath: string,
  storageRoot: string,
  relativePath: string,
): Promise<void> {
  const destination = resolveInside(storageRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await rename(tempPath, destination);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await copyFile(tempPath, destination);
    await rm(tempPath, { force: true });
  }
}

export async function removeFileQuietly(filePath: string): Promise<void> {
  await rm(filePath, { force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
}
