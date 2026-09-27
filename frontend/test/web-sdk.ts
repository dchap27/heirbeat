import { readFileSync } from "node:fs";
import { initSync } from "../node_modules/@miden-sdk/miden-sdk/dist/st/Cargo-COv7UhCD.js";

const wasm = new URL("../node_modules/@miden-sdk/miden-sdk/dist/st/assets/miden_client_web.wasm", import.meta.url);
initSync({ module: readFileSync(wasm) });

export * from "../node_modules/@miden-sdk/miden-sdk/dist/st/Cargo-COv7UhCD.js";
