import { generate } from "selfsigned";

let credentialsPromise: Promise<{ key: Buffer; cert: Buffer }> | undefined;

/** A self-signed key/cert pair, generated once and reused across tests. */
export function getTestCredentials(): Promise<{ key: Buffer; cert: Buffer }> {
  credentialsPromise ??= generate([{ name: "commonName", value: "localhost" }], {
    algorithm: "sha256",
    keySize: 2048
  }).then((pems) => ({ key: Buffer.from(pems.private), cert: Buffer.from(pems.cert) }));
  return credentialsPromise;
}
