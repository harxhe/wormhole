import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generate } from "selfsigned";
import type { CertConfig } from "./config.ts";

export interface TlsCredentials {
  key: Buffer;
  cert: Buffer;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function altNameEntry(value: string): { type: 2; value: string } | { type: 7; ip: string } {
  return IPV4.test(value) ? { type: 7, ip: value } : { type: 2, value };
}

/**
 * Load the TLS key/cert pair, generating a self-signed certificate via
 * `selfsigned` on first run. Files are written to the configured cert paths.
 */
export async function ensureCertificate(config: CertConfig): Promise<TlsCredentials> {
  const missing = !existsSync(config.keyPath) || !existsSync(config.certPath);
  if (missing) {
    const notAfterDate = new Date(Date.now() + config.days * 24 * 60 * 60 * 1000);
    const pems = await generate([{ name: "commonName", value: config.commonName }], {
      notAfterDate,
      keySize: 2048,
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: true },
        { name: "keyUsage", keyCertSign: true, digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: config.altNames.map(altNameEntry) }
      ]
    });
    mkdirSync(config.dir, { recursive: true });
    writeFileSync(config.keyPath, pems.private);
    writeFileSync(config.certPath, pems.cert);
  }

  return {
    key: readFileSync(config.keyPath),
    cert: readFileSync(config.certPath)
  };
}

/** Generate the certificate if it does not already exist. */
export async function generateCertificate(
  config: CertConfig
): Promise<{ keyPath: string; certPath: string; created: boolean }> {
  const existed = existsSync(config.keyPath) && existsSync(config.certPath);
  await ensureCertificate(config);
  return { keyPath: config.keyPath, certPath: config.certPath, created: !existed };
}
