# CodeFlow

CodeFlow turns C++ functions into interactive flowcharts. Parsing and layout run locally without an account or API key. Optional AI captions use a local Ollama model.

## Install on Windows

Download the `setup.exe` installer from [Releases](https://github.com/CatlordReal/CodeFlow/releases/latest). Windows 10/11 x64 is the initial release target. The installer uses the Microsoft Edge WebView2 runtime and can install it if needed.

Open a C++ source file, or paste code into the editor. Select a function to see its control flow. Charts start at the top and use conventional flowchart symbols. The default overview groups complete loops into subprocess boxes; **Expand loops** shows their internal control flow. **Comments** toggles source comments.

Choose **Code** or **Natural language** labels. Click a box to edit its label or add a note. **Save project** stores the source, labels, notes, and view options in a `.codeflow` file. **Save C++** saves only source code. **Export SVG** saves a standalone diagram. Edits are separate for overview and expanded views.

Use **Check updates** to look for a newer release. Installation happens only after confirmation. Save your project before installing an update because the app closes during installation.

The initial Windows installer is not Authenticode signed, so Windows may identify its publisher as unknown. Update packages are signed with a separate application update key and verified before installation.

Version 0.2 uses the native Windows certificate store and system proxy for updates. If an older installation cannot reach GitHub, install the latest release manually once. Network, firewall, and proxy restrictions can still prevent access.

## Local AI captions

Install and run [Ollama](https://ollama.com/download), then open **Local AI**. Choose an installed supported model or explicitly download one: Qwen 2.5 0.5B (smallest), Qwen 2.5 3B, or Qwen 3.5 4B. Model downloads require internet access and additional disk space; model inference stays on `127.0.0.1`. CodeFlow rejects Ollama cloud model aliases.

AI drafts short captions for process steps, including collapsed loops. Review and edit drafts before applying: small models can miss details. Decision tests, terminal paths, and graph structure remain parser-derived. AI captions are optional; ordinary flowcharts work without Ollama.

## Themes

System, Light, Dark; Catppuccin Latte, Frappé, Macchiato, Mocha; Sand, Dawn Paper, Golden Sand, Golden Paper, Sunset, Dusk. Manual choices persist; System follows the operating system.

## C++ support

The Rust core uses Tree-sitter's C++ grammar, rather than guessing structure with regular expressions. It detects function definitions and handles nested `if`/`else`, classic and range-based `for`, `while`, `do`/`while`, `switch` with fallthrough, `break`, `continue`, `return`, and `throw`. Comments are annotations and never change control-flow edges.

This is a source-level flowchart, not a compiler's fully resolved control-flow graph. It does not expand macros, resolve overloads, follow calls into other functions, or simulate execution. Syntax errors are reported. Unsupported control-flow constructs are reported instead of being presented as a reliable linear graph.

Files are limited to 2 MB. Large files are viewed one function at a time. The app never executes submitted C++.

## Development

Install Node.js 22+, a current stable Rust toolchain, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system.

```sh
npm ci
npm run tauri dev
```

```sh
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

The frontend is React/TypeScript with React Flow and ELK layout. `src-tauri/src/analyzer.rs` owns parsing and control-flow construction; its serializable graph contains source ranges, nodes, edges, and diagnostics. `src-tauri/src/lib.rs` provides the small desktop command boundary. Parsing runs off the UI thread.

## macOS and Linux

The same source uses Tauri's native webview on all three platforms. No Windows APIs are used in the parser or interface. To build another platform on that platform:

```sh
# macOS
npm run tauri build -- --bundles app

# Linux
npm run tauri build -- --bundles appimage
```

The release workflow currently packages Windows only. Publishing macOS or Linux updates requires adding their native build runners and updater artifacts to the workflow. Public macOS distribution also needs the usual Apple signing and notarization setup.

## Release and update signing

Update the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, refresh both lockfiles, then push a matching `vX.Y.Z` tag. The workflow tests and builds an NSIS installer, signature, and `latest.json`, and creates a draft release. Review the artifacts and publish the draft to make it available to the updater.

The signing key is stored in the repository's `TAURI_SIGNING_PRIVATE_KEY` Actions secret. The initial local backup is `.local/updater.key`, excluded from Git. Keep a secure backup: GitHub secrets cannot be retrieved, and losing the key prevents existing installations from trusting future updates. Never commit the private key. The public verification key is embedded in `tauri.conf.json`.

For a local signed build, set `TAURI_SIGNING_PRIVATE_KEY` to the key's path and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to its password (empty for the initial key). For an unsigned local development bundle, override `bundle.createUpdaterArtifacts` to `false` through a local Tauri config file.

The supplied private C++ sample was used for local verification and is not included in this repository.

## License

MIT. Dependencies retain their own licenses.
