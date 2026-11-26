import type { Client } from "@superdurable/dex";

/**
 * The Dex Client of this process, set once after bootstrap. Steps that start
 * other Flows and agent tools that call Flow RPCs read it at run time, so Flow
 * modules never import the Client.
 */
export class DexClientHolder {
  #client: Client | undefined;

  public set(client: Client): void {
    this.#client = client;
  }

  public get(): Client {
    if (this.#client === undefined) {
      throw new Error("the Dex Client is not set: the process sets it after it opens Dex");
    }
    return this.#client;
  }
}
