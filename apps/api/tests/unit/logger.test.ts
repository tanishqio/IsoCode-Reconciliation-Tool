import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, logger } from "../../src/lib/logger.js";

function capture() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const records = () =>
    chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { stream, records, raw: () => chunks.join("") };
}

describe("logger", () => {
  it("is silent when NODE_ENV is test", () => {
    expect(logger.level).toBe("silent");
  });

  it("writes JSON lines when given a level", () => {
    const out = capture();
    createLogger(out.stream, "info").info({ port: 4000 }, "hello");
    const [record] = out.records();
    expect(record?.["msg"]).toBe("hello");
    expect(record?.["port"]).toBe(4000);
    expect(record?.["level"]).toBe(30);
  });

  it("redacts secret fields at the top level", () => {
    const out = capture();
    createLogger(out.stream, "info").info(
      { password: "P1", passwordHash: "P2", token: "P3", csrfToken: "P4", keep: "visible" },
      "x",
    );
    const raw = out.raw();
    for (const secret of ["P1", "P2", "P3", "P4"]) expect(raw).not.toContain(`"${secret}"`);
    const [record] = out.records();
    expect(record?.["password"]).toBe("[redacted]");
    expect(record?.["passwordHash"]).toBe("[redacted]");
    expect(record?.["token"]).toBe("[redacted]");
    expect(record?.["csrfToken"]).toBe("[redacted]");
    expect(record?.["keep"]).toBe("visible");
  });

  it("redacts secret fields one level down", () => {
    const out = capture();
    createLogger(out.stream, "info").info(
      { user: { password: "N1", passwordHash: "N2" }, session: { token: "N3", csrfToken: "N4" } },
      "x",
    );
    const raw = out.raw();
    for (const secret of ["N1", "N2", "N3", "N4"]) expect(raw).not.toContain(`"${secret}"`);
  });

  it("redacts cookie, authorization and CSRF headers", () => {
    const out = capture();
    createLogger(out.stream, "info").info(
      {
        req: {
          headers: {
            cookie: "sid=H1",
            authorization: "Bearer H2",
            "x-csrf-token": "H3",
            accept: "text/html",
          },
        },
        res: { headers: { "set-cookie": "sid=H4" } },
      },
      "x",
    );
    const raw = out.raw();
    for (const secret of ["sid=H1", "Bearer H2", "H3", "sid=H4"]) expect(raw).not.toContain(secret);
    expect(raw).toContain("text/html");
  });

  it("does not write below the configured level", () => {
    const out = capture();
    const log = createLogger(out.stream, "warn");
    log.info("ignored");
    log.warn("kept");
    expect(out.records().map((r) => r["msg"])).toEqual(["kept"]);
  });
});
