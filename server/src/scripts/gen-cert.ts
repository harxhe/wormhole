import { loadConfig } from "../config.ts";
import { DEFAULT_CONFIG_PATH } from "../paths.ts";
import { generateCertificate } from "../certs.ts";

const configPath = process.argv[2] ?? DEFAULT_CONFIG_PATH;
const config = loadConfig(configPath);
const result = await generateCertificate(config.cert);

if (result.created) {
  console.log(`Generated self-signed certificate for "${config.cert.commonName}"`);
} else {
  console.log("Certificate already exists; nothing to do");
}
console.log(`  key:  ${result.keyPath}`);
console.log(`  cert: ${result.certPath}`);
