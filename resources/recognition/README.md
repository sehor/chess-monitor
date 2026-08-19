# Recognition model resources

Stage 05 intentionally does not bundle an unverified chess-piece classifier.

The application looks for `resources/recognition/manifest.json` in development and `recognition/manifest.json` under Electron `process.resourcesPath` in a packaged build. The manifest and referenced ONNX file are verified before a Recognition Worker is created.

A deployable resource set must contain:

- `manifest.json` following `manifest.example.json`.
- The ONNX model named by `modelFile`.
- A SHA-256 in `modelSha256` that exactly matches the ONNX bytes.
- The exact class order `_ R N B A K C P r n b a k c p`.
- Preprocessing values matching the model's training/export pipeline.

Do not rename or reorder classes to make a model appear compatible. A mismatch is a hard failure by design.

Before promoting a model to `manifest.json`, record the fixed-client/theme/DPI benchmark required by `docs/phase-05-recognition-and-resync.md`. The current repository does not contain the 300-image independent holdout set needed to make that acceptance claim.

The runtime backend dynamically loads `onnxruntime-node` inside an isolated Node worker. If the package is not present in the final application, recognition returns a structured `RUNTIME_MISSING` error and leaves the current Position untouched.
