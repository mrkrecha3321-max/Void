# Test layout

## Quality-gate tests

- `tier1_build.test.mjs` executes the real TypeScript/Vite build and real `cargo check --locked`.
- Rust unit/integration tests live beside production modules in `src-tauri/src/**` and exercise real crypto, protocol envelopes, encrypted storage, backup and transport abstraction.
- Kotlin tests under `src-tauri/gen/android/app/src/test` exercise the production BLE frame codec.
- Android instrumentation tests live under `src-tauri/gen/android/app/src/androidTest`.

## Contract-model tests

`tier1_features`, `tier2_boundary`, `tier3_cross_feature`, `tier4_real_world` and `helpers/mesh_contracts.mjs` are a deterministic JavaScript protocol model retained for regression comparison. They **do not execute Rust, Kotlin, GATT, NFC or physical BLE** and must not be interpreted as end-to-end or hardware verification.

CI treats the production Rust/Kotlin tests and builds as authoritative. The contract model is supplementary only.
