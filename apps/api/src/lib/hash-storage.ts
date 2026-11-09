import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StorageEngine } from "multer";
import { env } from "../config/env.js";

/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace Express {
    namespace Multer {
      interface File {
        tempPath: string;
        sha256: string;
        sizeBytes: number;
        headBytes: Buffer;
      }
    }
  }
}

/* eslint-enable @typescript-eslint/no-namespace */

const HEAD_BYTES_LENGTH = 8;

function createHashingTransform() {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const head = Buffer.alloc(HEAD_BYTES_LENGTH);
  let headFilled = 0;

  const transform = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      sizeBytes += chunk.length;

      if (headFilled < HEAD_BYTES_LENGTH) {
        const take = Math.min(chunk.length, HEAD_BYTES_LENGTH - headFilled);
        chunk.copy(head, headFilled, 0, take);
        headFilled += take;
      }

      done(null, chunk);
    },
  });

  return {
    transform,
    finish: () => ({
      sha256: hash.digest("hex"),
      sizeBytes,
      headBytes: head.subarray(0, headFilled),
    }),
  };
}

function removeTempFile(filePath: string): Promise<void> {
  return rm(filePath, { force: true, maxRetries: 3, retryDelay: 50 });
}

export const hashStorage: StorageEngine = {
  _handleFile(_req, file, callback) {
    void (async () => {
      const tempPath = path.join(env.UPLOAD_TEMP_DIR, `${randomUUID()}.part`);

      try {
        await mkdir(env.UPLOAD_TEMP_DIR, { recursive: true });

        const hasher = createHashingTransform();

        await pipeline(file.stream, hasher.transform, createWriteStream(tempPath, { flags: "wx" }));

        callback(null, { tempPath, ...hasher.finish() });
      } catch (err) {
        await removeTempFile(tempPath).catch(() => undefined);
        callback(err);
      }
    })();
  },

  _removeFile(_req, file, callback) {
    if (!file.tempPath) {
      callback(null);
      return;
    }

    removeTempFile(file.tempPath).then(
      () => callback(null),
      (err: Error) => callback(err),
    );
  },
};
