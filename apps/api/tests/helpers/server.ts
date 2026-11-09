import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Starts an Express app on a random free port so tests can call it with fetch. */
export async function startServer(app: Express): Promise<TestServer> {
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
