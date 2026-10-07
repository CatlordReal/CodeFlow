import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

async function main() {
const options = parseArguments(process.argv.slice(2));
const endpoint = `http://127.0.0.1:${options.port}`;
const deadline = Date.now() + options.timeout * 1000;
await mkdir(options.output, { recursive: true });
const restoreExpected = options.restoreOnly
  ? JSON.parse(await readFile(path.join(options.output, "windows-recovery-expected.json"), "utf8"))
  : null;

let client;
try {
  const target = await waitForTarget(endpoint, deadline, restoreExpected?.targetId);
  client = await CdpClient.connect(target.webSocketDebuggerUrl, remaining(deadline));
  await client.call("Runtime.enable");
  await client.call("Page.enable");
  await client.call("Page.bringToFront");
  await client.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });

  if (options.restoreOnly) {
    await waitForRecoveryRestore(client, deadline, restoreExpected);
    const reportPath = path.join(options.output, "windows-render-smoke.json");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    report.recovery = { ...report.recovery, restartPending: false, restored: true };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Restored ${restoreExpected.fileName} with ${restoreExpected.history.revisions.length} history revisions from native recovery.`);
    return;
  }

  await setViewport(client, 1440, 900);
  const initial = await waitForGraph(client, deadline, { comments: false });
  await chooseTheme(client, "Wallpaper");
  const wallpaperFirst = await waitForWallpaperPalette(client, deadline);
  await writeFile(path.join(options.output, "wallpaper-change.request"), "change\n");
  const wallpaperSecond = await waitForWallpaperPalette(client, deadline, wallpaperFirst.accent);
  const updater = await checkUpdater(client, deadline);
  await chooseTheme(client, "Latte");
  await waitForValue(client, deadline, `document.documentElement.dataset.theme === 'catppuccin-latte' && document.documentElement.style.colorScheme === 'light'`, "Latte theme");
  await setRange(client, 'input[aria-label="Transparency"]', 35);
  await waitForValue(client, deadline, `document.documentElement.style.getPropertyValue('--surface-opacity') === '65%' && document.querySelector('.transparency-control output')?.textContent === '35%'`, "window transparency");
  const wideBytes = await capture(client, path.join(options.output, "windows-smoke-wide.png"));

  await clickComments(client);
  const commentsOn = await waitForGraph(client, deadline, { comments: true });
  if (commentsOn.nodeCount !== initial.nodeCount) throw new Error("Comments toggle changed flow node count.");
  await clickComments(client);
  const commentsOff = await waitForGraph(client, deadline, { comments: false });

  await selectValue(client, 'select[aria-label="Label mode"]', 'code');
  const codeLabels = await waitForGraph(client, deadline, { comments: false, mode: "code" });
  if (!codeLabels.labels.some((label) => /^return\b/.test(label))) throw new Error("Code labels must preserve return statements.");
  await selectValue(client, 'select[aria-label="Label mode"]', 'natural');
  const naturalLabels = await waitForGraph(client, deadline, { comments: false, mode: "natural" });
  if (!naturalLabels.labels.some((label) => /^Return\b/.test(label))) throw new Error("Natural return labels are missing.");

  // Public synthetic source exercises a collapsible loop; the default sample's
  // early return correctly prevents its loop from becoming an overview box.
  const loopSource = `#include <vector>
int smokeSum(const std::vector<int>& values) {
    int sum = 0;
    // Add each number.
    for (int value : values) {
        for (int repeat = 0; repeat < 2; repeat++) { sum += helper(value); }
    }
    return sum;
}
int helper(int value) { return value * 2; }`;
  await setTextarea(client, 'textarea[aria-label="C++ source code"]', loopSource);
  const overview = await waitForGraph(client, deadline, { comments: false, sourceToken: "smokeSum", mode: "natural" });
  if (overview.subprocessCount !== 1) throw new Error("Loop overview must show one predefined-process box.");
  await selectValue(client, 'select[aria-label="Loop expansion depth"]', '1');
  const depthOne = await waitForGraph(client, deadline, { comments: false, sourceToken: "smokeSum", mode: "natural", loopDepth: "1", subprocesses: 1 });
  if (depthOne.nodeCount <= overview.nodeCount) throw new Error("Loop depth 1 did not expand the outer loop.");

  const boxLabel = "Sum values";
  const annotation = "Checked in Windows smoke";
  const selected = await evaluate(client, `(() => {
    const box = document.querySelector('.flow-symbol--subprocess')?.closest('.react-flow__node');
    if (!box) return false;
    box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  if (!selected) throw new Error("Nested loop box was not clickable.");
  await waitForValue(client, deadline, `Boolean(document.querySelector('textarea[aria-label="Box label"]'))`, "box editor");
  await clickButton(client, ".node-editor", "Expand this loop");
  const individuallyExpanded = await waitForGraph(client, deadline, { comments: false, sourceToken: "smokeSum", mode: "natural", loopDepth: "1", subprocesses: 0 });
  if (individuallyExpanded.nodeCount <= depthOne.nodeCount) throw new Error("Individual loop expansion did not reveal its body.");
  await clickButton(client, ".node-editor", "Collapse this loop");
  await waitForGraph(client, deadline, { comments: false, sourceToken: "smokeSum", mode: "natural", loopDepth: "1", subprocesses: 1 });
  await setTextarea(client, 'textarea[aria-label="Box label"]', boxLabel);
  await setTextarea(client, 'textarea[aria-label="Box annotation"]', annotation);
  await waitForValue(client, deadline, `(() => {
    const box = document.querySelector('.flow-symbol--subprocess');
    return box?.querySelector('.flow-symbol__label')?.textContent === ${JSON.stringify(boxLabel)} && box?.querySelector('.flow-symbol__annotation')?.textContent === ${JSON.stringify(annotation)};
  })()`, "edited label and annotation");
  await selectValue(client, 'select[aria-label="Label mode"]', 'code');
  await waitForValue(client, deadline, `document.querySelector('.flow-symbol--subprocess .flow-symbol__label')?.textContent.includes('for') && document.querySelector('.flow-symbol__annotation')?.textContent === ${JSON.stringify(annotation)}`, "separate code label with retained annotation");
  await selectValue(client, 'select[aria-label="Label mode"]', 'natural');
  await waitForValue(client, deadline, `document.querySelector('.flow-symbol--subprocess .flow-symbol__label')?.textContent === ${JSON.stringify(boxLabel)}`, "retained natural label");

  const commentRemovedSource = loopSource.replace("    // Add each number.\n", "");
  await setTextarea(client, 'textarea[aria-label="C++ source code"]', commentRemovedSource);
  await waitForGraph(client, deadline, { comments: false, sourceToken: "smokeSum", mode: "natural", loopDepth: "1", subprocesses: 1 });
  await waitForValue(client, deadline, `document.querySelector('.flow-symbol--subprocess .flow-symbol__label')?.textContent === ${JSON.stringify(boxLabel)}`, "edited label after comment removal");

  await clickCheckboxLabel(client, ".node-editor", "Flag for removal");
  await waitForValue(client, deadline, `document.querySelector('.flow-symbol--subprocess')?.dataset.flagged === 'true' && Boolean(document.querySelector('.flow-symbol__flag-marker'))`, "flagged box");
  await clickButton(client, ".chart-options", "Highlight unmodified labels");
  await waitForValue(client, deadline, `document.querySelectorAll('.flow-symbol[data-unmodified="true"]').length > 0`, "unmodified label highlights");

  await clickButton(client, ".node-editor", "Hide box");
  const hidden = await waitForGraph(client, deadline, { comments: false, sourceToken: "smokeSum", mode: "natural", loopDepth: "1", subprocesses: 0 });
  if (hidden.nodeCount >= depthOne.nodeCount) throw new Error("Hide box did not remove the selected loop from the chart.");
  await clickCheckboxLabel(client, ".chart-options", "Show hidden boxes");
  await waitForValue(client, deadline, `document.querySelector('.flow-symbol[data-hidden="true"]')?.classList.contains('flow-symbol--subprocess') === true`, "shown hidden box");
  await evaluate(client, `document.querySelector('.flow-symbol[data-hidden="true"]')?.closest('.react-flow__node')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await waitForValue(client, deadline, `Boolean(document.querySelector('.node-editor'))`, "hidden box editor");
  await clickButton(client, ".node-editor", "Reset box");
  await waitForValue(client, deadline, `!document.querySelector('.flow-symbol[data-flagged="true"]') && document.querySelector('.flow-symbol--subprocess .flow-symbol__label')?.textContent !== ${JSON.stringify(boxLabel)}`, "reset box state");

  const historyBefore = await historyRevisionCount(client);
  await clickButton(client, ".chart-options", "Alternate");
  await clickButton(client, ".chart-options", "History");
  await waitForValue(client, deadline, `document.querySelectorAll('.history-panel .react-flow__node').length > ${historyBefore}`, "alternate history branch");
  await clickButton(client, ".history-panel", "Close");
  await clickButton(client, ".chart-options", "Undo");
  await clickButton(client, ".chart-options", "Reset chart");
  await waitForValue(client, deadline, `document.querySelector('select[aria-label="Loop expansion depth"]')?.value === '0' && !document.querySelector('.flow-symbol[data-hidden="true"]') && !document.querySelector('.flow-symbol[data-flagged="true"]')`, "reset chart defaults");

  await selectValue(client, 'select[aria-label="Chart view"]', 'file');
  await waitForValue(client, deadline, `document.querySelectorAll('.function-board-card').length === 2 && document.querySelectorAll('.function-board .react-flow__edge').length >= 1`, "file map call references");
  await waitForValue(client, deadline, `[...document.querySelectorAll('.toolbar button')].some(button => button.textContent.trim() === 'Export PNG' && !button.disabled)`, "enabled PNG export");
  const pngControlPresent = true;
  await selectValue(client, 'select[aria-label="Chart view"]', 'function');
  await waitForGraph(client, deadline, { comments: false, sourceToken: "smokeSum", mode: "natural", loopDepth: "0", subprocesses: 1 });
  const saveProjectPresent = await evaluate(client, `[...document.querySelectorAll('.toolbar button')].some(button => button.textContent.trim() === 'Save project' && !button.disabled)`);
  if (!saveProjectPresent) throw new Error("Save project control is missing.");
  // Opening a native save chooser would block this unattended CI smoke run.
  await evaluate(client, `[...document.querySelectorAll('.node-editor button')].find(button => button.textContent.trim() === 'Close')?.click()`);

  await chooseTheme(client, "Mocha");
  await waitForValue(client, deadline, `document.documentElement.dataset.theme === 'catppuccin-mocha' && document.documentElement.style.colorScheme === 'dark'`, "Mocha theme");
  await setViewport(client, 760, 900);
  await evaluate(client, `document.querySelector('.react-flow__controls-fitview')?.click()`);
  await delay(500);
  const compact = await waitForGraph(client, deadline, { comments: false, sourceToken: "smokeSum", mode: "natural", loopDepth: "0", subprocesses: 1 });
  const compactBytes = await capture(client, path.join(options.output, "windows-smoke-compact.png"));

  const recoveryLabel = "Recovered Windows label";
  const recoveryFileName = "windows-recovery.cpp";
  const recoverySelected = await evaluate(client, `(() => {
    const box = document.querySelector('.flow-symbol--subprocess')?.closest('.react-flow__node');
    if (!box) return false;
    box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  if (!recoverySelected) throw new Error("Recovery box was not clickable.");
  await waitForValue(client, deadline, `Boolean(document.querySelector('textarea[aria-label="Box label"]'))`, "recovery box editor");
  await setTextarea(client, 'textarea[aria-label="Box label"]', recoveryLabel);
  await setInput(client, 'input[aria-label="C++ filename"]', recoveryFileName);
  await waitForValue(client, deadline, `document.querySelector('.flow-symbol--subprocess .flow-symbol__label')?.textContent === ${JSON.stringify(recoveryLabel)}`, "recovery label");
  const recovery = await waitForNativeRecovery(client, deadline, {
    source: commentRemovedSource,
    fileName: recoveryFileName,
    label: recoveryLabel,
  });
  const recoveryExpected = {
    targetId: target.id,
    source: recovery.project.source,
    fileName: recovery.project.fileName,
    edits: recovery.project.edits,
    history: recovery.project.history,
    label: recoveryLabel,
    dirty: recovery.dirty,
    sourceDirty: recovery.sourceDirty,
    projectDirty: recovery.projectDirty,
  };
  await writeFile(path.join(options.output, "windows-recovery-expected.json"), `${JSON.stringify(recoveryExpected, null, 2)}\n`);

  const result = {
    target: { title: target.title, url: target.url },
    wide: { width: 1440, height: 900, bytes: wideBytes, nodes: initial.nodeCount, theme: "catppuccin-latte" },
    compact: { width: 760, height: 900, bytes: compactBytes, nodes: compact.nodeCount, theme: "catppuccin-mocha" },
    comments: { initial: initial.commentCount, enabled: commentsOn.commentCount, disabled: commentsOff.commentCount },
    labelModes: ["code", "natural"],
    loopExpansion: { overview: overview.nodeCount, depthOne: depthOne.nodeCount, individual: individuallyExpanded.nodeCount },
    edits: { naturalLabel: boxLabel, annotation, retainedAcrossModeChange: true, retainedAfterCommentRemoval: true, flagHighlightHideReset: true },
    history: { alternate: true, undo: true, reset: true },
    fileMap: { cards: 2, callReferences: true },
    appearance: { transparency: 35, themePopup: true },
    wallpaper: { first: wallpaperFirst, second: wallpaperSecond, refreshed: true },
    pngExport: { controlPresent: pngControlPresent, nativeDialogOpened: false },
    projectSave: { controlPresent: saveProjectPresent, nativeDialogOpened: false, persistenceTested: false },
    recovery: { nativeSnapshot: true, restartPending: true, fileName: recoveryFileName, historyRevisions: recoveryExpected.history.revisions.length },
    updater,
  };
  await writeFile(path.join(options.output, "windows-render-smoke.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Rendered ${initial.nodeCount} initial nodes; loop overview ${overview.nodeCount}/${depthOne.nodeCount}/${individuallyExpanded.nodeCount}; native parser, presentation controls, file map, and themes passed.`);
} finally {
  client?.close();
}
}

function parseArguments(args) {
  const values = { port: 9222, output: "output", timeout: 60, restoreOnly: false };
  for (let index = 0; index < args.length;) {
    const name = args[index];
    if (name === "--restore-only") {
      values.restoreOnly = true;
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${name}.`);
    if (name === "--port") values.port = Number.parseInt(value, 10);
    else if (name === "--output") values.output = path.resolve(value);
    else if (name === "--timeout") values.timeout = Number.parseInt(value, 10);
    else throw new Error(`Unknown argument ${name}.`);
    index += 2;
  }
  if (!Number.isInteger(values.port) || values.port < 1 || values.port > 65535) throw new Error("Invalid CDP port.");
  if (!Number.isInteger(values.timeout) || values.timeout < 5 || values.timeout > 120) throw new Error("Invalid timeout.");
  return values;
}

async function waitForTarget(baseUrl, end, excludedTargetId = null) {
  let lastError = "no CDP response";
  while (Date.now() < end) {
    try {
      const response = await fetch(`${baseUrl}/json/list`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const targets = await response.json();
      const target = targets.find((candidate) =>
        candidate.type === "page" &&
        candidate.webSocketDebuggerUrl &&
        candidate.id !== excludedTargetId &&
        !String(candidate.url).startsWith("devtools://"),
      );
      if (target) return target;
      lastError = "CDP returned no page target";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`WebView2 CDP target unavailable: ${lastError}.`);
}

async function setViewport(client, width, height) {
  await client.call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    screenWidth: width,
    screenHeight: height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await delay(500);
}

async function waitForGraph(client, end, expected = {}) {
  const { comments = false, sourceToken = "firstPositive", mode, loopDepth, subprocesses } = expected;
  let state;
  while (Date.now() < end) {
    state = await evaluate(client, `(() => {
      const checkbox = document.querySelector('.toggle input[type="checkbox"]');
      const symbols = [...document.querySelectorAll('.flow-symbol')];
      const labels = symbols.map(node => [...node.querySelectorAll('.flow-symbol__label span')].map(line => line.textContent).join(' '));
      const start = symbols.find(node => node.querySelector('.flow-symbol__label')?.textContent === 'Start');
      const position = node => Number(node.closest('.react-flow__node')?.style.transform.match(/translate\\([^,]+,\\s*([-\\d.]+)px\\)/)?.[1]);
      return {
        ready: document.readyState,
        title: document.title,
        desktopRuntime: Boolean(window.__TAURI_INTERNALS__),
        sourceLoaded: document.querySelector('textarea[aria-label="C++ source code"]')?.value.includes(${JSON.stringify(sourceToken)}) ?? false,
        nodeCount: symbols.length,
        commentCount: document.querySelectorAll('.flow-symbol__comments').length,
        subprocessCount: document.querySelectorAll('.flow-symbol--subprocess').length,
        checked: checkbox?.checked ?? null,
        loopDepth: document.querySelector('select[aria-label="Loop expansion depth"]')?.value ?? null,
        mode: document.querySelector('select[aria-label="Label mode"]')?.value,
        busy: Boolean(document.querySelector('.analysis-progress')),
        error: document.querySelector('.chart-status--error')?.textContent?.trim() ?? '',
        labels,
        startTopmost: Boolean(start) && Number.isFinite(position(start)) && symbols.every(node => position(node) >= position(start)),
        terminatorCount: document.querySelectorAll('.flow-symbol--terminator').length,
      };
    })()`);
    if (state.error) throw new Error(`CodeFlow rendered an error: ${state.error}`);
    const commentsReady = comments ? state.checked === true && state.commentCount > 0 : state.checked === false && state.commentCount === 0;
    const modeReady = mode === undefined || (state.mode === mode && state.labels.some((label) => mode === "code" ? /^return\b/.test(label) : /^Return\b/.test(label)));
    const expansionReady = (loopDepth === undefined || state.loopDepth === loopDepth) && (subprocesses === undefined || state.subprocessCount === subprocesses);
    if (state.ready === "complete" && state.desktopRuntime && state.title.includes("CodeFlow") && state.sourceLoaded && state.nodeCount >= 4 && state.labels.includes("Start") && state.terminatorCount >= 2 && state.startTopmost && !state.busy && commentsReady && modeReady && expansionReady) return state;
    await delay(200);
  }
  throw new Error(`CodeFlow graph did not reach expected state: ${JSON.stringify(state)}.`);
}

async function waitForValue(client, end, expression, description) {
  while (Date.now() < end) {
    if (await evaluate(client, expression)) return;
    await delay(100);
  }
  throw new Error(`CodeFlow did not reach ${description}.`);
}

async function waitForWallpaperPalette(client, end, previousAccent = null) {
  let palette;
  while (Date.now() < end) {
    palette = await evaluate(client, `(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        theme: document.documentElement.dataset.theme ?? '',
        scheme: document.documentElement.style.colorScheme,
        accent: style.getPropertyValue('--accent').trim(),
        background: style.getPropertyValue('--bg').trim(),
      };
    })()`);
    if (palette.theme === "wallpaper" && palette.accent && palette.background &&
        (previousAccent === null || palette.accent !== previousAccent)) return palette;
    await delay(100);
  }
  throw new Error(`Wallpaper theme did not ${previousAccent === null ? "load" : "refresh"}: ${JSON.stringify(palette)}.`);
}

async function checkUpdater(client, end) {
  const clicked = await evaluate(client, `(() => {
    const button = document.querySelector('button[aria-label="Check for updates"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error("Check for updates control is unavailable.");

  let state;
  while (Date.now() < end) {
    state = await evaluate(client, `(() => {
      const banner = document.querySelector('.update-banner');
      const kind = [...(banner?.classList ?? [])].find(name => name.startsWith('update-banner--'))?.slice('update-banner--'.length) ?? '';
      return { kind, message: banner?.querySelector('span')?.textContent?.trim() ?? '' };
    })()`);
    if (state.kind === "error") throw new Error(state.message || "Updater returned an error.");
    if (state.kind === "current") {
      if (state.message !== "CodeFlow is up to date.") throw new Error(`Unexpected updater response: ${state.message}`);
      await evaluate(client, `document.querySelector('button[aria-label="Dismiss update status"]')?.click()`);
      await waitForValue(client, end, `!document.querySelector('.update-banner')`, "dismissed updater status");
      return state;
    }
    await delay(100);
  }
  throw new Error(`Updater did not complete: ${JSON.stringify(state)}.`);
}

async function selectValue(client, selector, value) {
  const changed = await evaluate(client, `(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    if (!select) return false;
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!changed) throw new Error(`Missing select: ${selector}.`);
}

async function chooseTheme(client, name) {
  const chosen = await evaluate(client, `(() => {
    const picker = document.querySelector('.theme-picker');
    const summary = picker?.querySelector('summary');
    if (!picker || !summary) return false;
    summary.click();
    const button = [...picker.querySelectorAll('.theme-picker__menu button')].find(item => item.textContent.trim() === ${JSON.stringify(name)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!chosen) throw new Error(`Missing theme option: ${name}.`);
}

async function setRange(client, selector, value) {
  const changed = await evaluate(client, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement)) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(String(value))});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!changed) throw new Error(`Missing range input: ${selector}.`);
}

async function clickButton(client, container, text) {
  const clicked = await evaluate(client, `(() => {
    const root = document.querySelector(${JSON.stringify(container)});
    const button = [...(root?.querySelectorAll('button') ?? [])].find(item => item.textContent.trim() === ${JSON.stringify(text)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Missing enabled button: ${container} / ${text}.`);
}

async function clickCheckboxLabel(client, container, text) {
  const clicked = await evaluate(client, `(() => {
    const root = document.querySelector(${JSON.stringify(container)});
    const label = [...(root?.querySelectorAll('label') ?? [])].find(item => item.textContent.includes(${JSON.stringify(text)}));
    const checkbox = label?.querySelector('input[type="checkbox"]');
    if (!checkbox || checkbox.disabled) return false;
    checkbox.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Missing enabled checkbox: ${container} / ${text}.`);
}

async function historyRevisionCount(client) {
  await clickButton(client, ".chart-options", "History");
  await waitForValue(client, Date.now() + 5_000, `document.querySelectorAll('.history-panel .react-flow__node').length > 0`, "history revisions");
  const count = await evaluate(client, `document.querySelectorAll('.history-panel .react-flow__node').length`);
  await clickButton(client, ".history-panel", "Close");
  return Number(count);
}

async function setTextarea(client, selector, value) {
  const changed = await evaluate(client, `(() => {
    const textarea = document.querySelector(${JSON.stringify(selector)});
    if (!textarea) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, ${JSON.stringify(value)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (!changed) throw new Error(`Missing textarea: ${selector}.`);
  await delay(200);
}

async function setInput(client, selector, value) {
  const changed = await evaluate(client, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement)) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!changed) throw new Error(`Missing input: ${selector}.`);
  await delay(200);
}

async function waitForNativeRecovery(client, end, expected) {
  let state;
  while (Date.now() < end) {
    state = await evaluate(client, `window.__TAURI_INTERNALS__.invoke('read_recovery').then(opened => {
      if (!opened) return null;
      try { return { ...opened, project: JSON.parse(opened.contents) }; }
      catch (error) { return { parseError: String(error) }; }
    })`);
    if (state?.parseError) throw new Error(`Native recovery JSON is invalid: ${state.parseError}`);
    const project = state?.project;
    if (project?.source === expected.source && project.fileName === expected.fileName &&
        JSON.stringify(project.edits).includes(JSON.stringify(expected.label)) &&
        project.history?.active && project.history.revisions?.length > 1 &&
        state.dirty === true && state.sourceDirty === true && state.projectDirty === true) return state;
    await delay(100);
  }
  throw new Error(`Native recovery did not reach latest UI state: ${JSON.stringify(state)}.`);
}

async function waitForRecoveryRestore(client, end, expected) {
  let state;
  while (Date.now() < end) {
    state = await evaluate(client, `window.__TAURI_INTERNALS__.invoke('read_recovery').then(opened => {
      let project = null;
      try { project = opened ? JSON.parse(opened.contents) : null; } catch {}
      return {
        source: document.querySelector('textarea[aria-label="C++ source code"]')?.value ?? null,
        fileName: document.querySelector('input[aria-label="C++ filename"]')?.value ?? null,
        labelVisible: [...document.querySelectorAll('.flow-symbol__label')].some(node => node.textContent === ${JSON.stringify(expected.label)}),
        busy: Boolean(document.querySelector('.analysis-progress')),
        error: document.querySelector('.chart-status--error')?.textContent?.trim() ?? '',
        project,
      };
    })`);
    if (state.error) throw new Error(`Recovery restore rendered an error: ${state.error}`);
    if (!state.busy && state.source === expected.source && state.fileName === expected.fileName && state.labelVisible &&
        JSON.stringify(state.project?.edits) === JSON.stringify(expected.edits) &&
        JSON.stringify(state.project?.history) === JSON.stringify(expected.history)) return;
    await delay(100);
  }
  throw new Error(`CodeFlow did not restore native recovery: ${JSON.stringify(state)}.`);
}

async function clickComments(client) {
  const clicked = await evaluate(client, `(() => {
    const checkbox = document.querySelector('.toggle input[type="checkbox"]');
    if (!checkbox) return false;
    checkbox.click();
    return true;
  })()`);
  if (!clicked) throw new Error("Comments toggle is missing.");
}

async function capture(client, file) {
  const result = await client.call("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const image = Buffer.from(result.data ?? "", "base64");
  if (image.length < 10_000 || image.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new Error(`CDP screenshot is blank or invalid (${image.length} bytes).`);
  }
  await writeFile(file, image);
  return image.length;
}

async function evaluate(client, expression) {
  const response = await client.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  }
  return response.result?.value;
}

function remaining(end) {
  return Math.max(1000, end - Date.now());
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class CdpClient {
  static async connect(url, timeout) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to WebView2 CDP.")), timeout);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("WebView2 CDP WebSocket connection failed."));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`CDP closed while waiting for ${pending.method}.`));
      }
      this.pending.clear();
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, 10_000);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

await main();
