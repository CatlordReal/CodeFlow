# CodeFlow

CodeFlow turns C++ functions into interactive flowcharts. Parsing and layout run locally without an account or API key. Optional AI captions use a local Ollama model.

## Install on Windows

Windows 10/11 x64 is the initial release target. Download the `setup.exe` installer from [Releases](https://github.com/CatlordReal/CodeFlow/releases/latest). It uses Microsoft Edge WebView2 and can install that runtime if needed.

The Windows installer is not Authenticode signed, so Windows may identify its publisher as unknown. Update packages use a separate application update signature and are verified before installation.

## Flowcharts

Open a C++ source file or paste code into the editor, then choose a function. CodeFlow provides:

- Conventional flowchart symbols with exact parser-derived decisions and paths.
- Loop depth controls for overview, nested levels, or full expansion.
- Individual loop expansion and collapse, where control flow permits it.
- Exact classic-loop conditions on branch labels, range-loop completion labels, and distinct Loop badges.
- Code and natural-language label modes, source comments, annotations, box hiding, removal flags, and highlighting for unchanged natural-language labels.
- SVG and PNG export using the palette active at export time.

Hidden boxes remain recoverable through **Show hidden boxes**. Hiding reconnects visible paths and retains relevant decision text. Flags mark candidates without deleting them.

## Projects and recovery

**New project** starts a clean document. **Open** accepts C++ source or `.codeflow` projects. **Save project** chooses a target on the first save, then writes to the same approved target; **Save as** chooses another target. **Recent projects** reopens previously saved projects. `Ctrl+S` or `⌘S` saves the project, and the filename can be edited in the source header. **Save C++** saves source only.

A `.codeflow` project stores source, filename, labels, annotations, flags, hidden boxes, loop settings, file-map positions, and history. CodeFlow also keeps a current recovery copy and restores it on launch. Immediately before installing an update, CodeFlow saves recovery again so unsaved current work can return after restart.

## History and label preservation

Chart edits create a branching history of up to 500 revisions. **Undo** selects the parent revision, **History** opens the revision graph, **Alternate** starts another branch from the selected revision, and **Reset chart** records a reset as a new revision. History persists in `.codeflow` projects.

CodeFlow preserves labels, annotations, flags, and layout when matching code remains unchanged across edits, comment changes, and pasted revisions. Matching uses source identities rather than box numbers. It searches up to 5 recent projects plus 10 versions retained during the current session. Ambiguous matches, including duplicate or overloaded identities that cannot be distinguished conservatively, are omitted rather than attached to different code.

## File map

**File map** renders every detected function as a static flowchart card. Cards can be dragged, and their positions persist in the project. Reference lines connect uniquely identifiable static calls between functions in the same parsed file.

These reference lines are source-level hints, not compiler name resolution. CodeFlow does not resolve dynamic dispatch, function pointers, templates, macros, external definitions, or C++ overload resolution. Unqualified or overloaded calls with multiple possible targets are omitted.

## Local AI captions

Install and run [Ollama](https://ollama.com/download), then open **Local AI**. Choose an installed supported model or explicitly download one: Qwen 2.5 0.5B, Qwen 2.5 3B, or Qwen 3.5 4B. Model downloads require internet access and disk space; inference stays on `127.0.0.1`. CodeFlow rejects Ollama cloud model aliases.

AI generates caption proposals for process and input/output steps, including collapsed loops. Every proposal starts unaccepted and shows the existing label beside the proposed label. Review and optionally edit each proposal, then accept or decline it individually or use **Accept all** and **Decline all**. Only accepted proposals are applied. If source, chart structure, or displayed labels change during review, pending proposals are invalidated.

Decision tests, terminal paths, and graph structure remain parser-derived. AI captions are optional; ordinary flowcharts work without Ollama.

## Appearance

Themes include System, Light, Dark; Catppuccin Latte, Frappé, Macchiato, Mocha; and Sand, Dawn Paper, Golden Sand, Golden Paper, Sunset, Dusk. Manual choices persist, and System follows the operating system.

On Windows, **Wallpaper** derives a palette from the current desktop wallpaper. It checks every 5 seconds and reuses the cached result while the wallpaper path, modification time, and size remain unchanged.

Transparency uses the Windows compositor for actual window transparency. On macOS and Linux, the control changes application surface tint only; it does not claim transparent native-window composition.

## C++ support

The Rust core uses Tree-sitter's C++ grammar. It detects function definitions and handles nested `if`/`else`, classic and range-based `for`, `while`, `do`/`while`, `switch` with fallthrough, `break`, `continue`, `return`, and `throw`. Comments are annotations and never change control-flow edges.

This is a source-level flowchart, not a compiler-resolved control-flow graph. It does not expand macros, resolve overloads, follow calls into other functions in function view, or simulate execution. Syntax errors are reported. Unsupported control-flow constructs are reported instead of being presented as reliable linear graphs.

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

The frontend is React/TypeScript with React Flow and ELK layout. `src-tauri/src/analyzer.rs` owns parsing and control-flow construction; its serializable graph contains source ranges, nodes, edges, and diagnostics. `src-tauri/src/lib.rs` provides the desktop command boundary. Parsing runs off the UI thread.

## macOS and Linux

The source uses Tauri's native webview on Windows, macOS, and Linux. Parser and interface code do not depend on Windows APIs; Wallpaper mode and native compositor transparency are Windows-specific.

Build another platform on that platform:

```sh
# macOS
npm run tauri build -- --bundles app

# Linux
npm run tauri build -- --bundles appimage
```

Current release automation targets Windows. Publishing macOS or Linux updates requires native build runners and updater artifacts. Public macOS distribution also requires Apple signing and notarization.

## Release and update signing

Update the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, refresh both lockfiles, then push a matching `vX.Y.Z` tag. The workflow tests and builds an NSIS installer, signature, and `latest.json`, then creates a draft release. Review the artifacts before publishing the draft.

The signing key is stored in the repository's `TAURI_SIGNING_PRIVATE_KEY` Actions secret. A local backup belongs outside version control. Keep a secure backup: GitHub secrets cannot be retrieved, and losing the key prevents existing installations from trusting future updates. Never commit the private key. The public verification key is embedded in `tauri.conf.json`.

For a local signed build, set `TAURI_SIGNING_PRIVATE_KEY` to the key's path and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to its password. For an unsigned local development bundle, override `bundle.createUpdaterArtifacts` to `false` through a local Tauri config file.

The supplied private C++ sample was used for local verification and is not included in this repository.

## License

MIT. Dependencies retain their own licenses.
