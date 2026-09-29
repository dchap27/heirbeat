import { copyFile, mkdir, access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const contracts = ["check-in-note", "deposit-note", "claim-note", "activate-vault-note", "heirbeat-vault"];
const destination = resolve(root, "frontend/public/contracts");

await mkdir(destination, { recursive: true });
for (const name of contracts) {
  const source = resolve(root, `contracts/${name}/target/miden/release/${name}.masp`);
  await access(source);
  await copyFile(source, resolve(destination, `${name}.masp`));
}
console.log(`Copied ${contracts.length} current .masp artifacts into frontend/public/contracts.`);
