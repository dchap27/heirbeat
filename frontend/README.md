# Browser spike

This React/Vite package is a read-only feasibility probe for the official Miden v0.16 Web SDK and wallet adapter. It needs the four existing contract `.masp` artifacts under each contract package's `target/miden/release/` directory. Run `npm install` and `npm run build`; the pre-build step copies those public artifacts into ignored `public/contracts/` assets. Run `npm run dev` to inspect the wallet, endpoint, vault-read, note-construction, and NTX diagnostic panels.

The app does not import signing material or submit transactions. The SDK's browser IndexedDB is used only for its client sync state in this spike; no account creation or app-managed signer is enabled.

`npm test` initializes the SDK's browser WASM bindings directly because the optional native Node package omits browser-only collection wrappers. It tests note construction without RPC access. Live browser sync remains gated on an RPC endpoint that serves gRPC-Web with CORS enabled: the v0.16 `.io` endpoint answered the preflight but omitted CORS allow headers during this spike, and `.xyz` did not resolve from the test environment.
