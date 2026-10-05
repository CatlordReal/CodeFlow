import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

async function main() {
const options = parseArguments(process.argv.slice(2));
const endpoint = `http://127.0.0.1:${options.port}`;
const deadline = Date.now() + options.timeout * 1000;
await mkdir(options.output, { recursive: true });

let client;
try {
  const target = await waitForTarget(endpoint, deadline);
  client = await CdpClient.connect(target.webSocketDebuggerUrl, remaining(deadline));
  await client.call("Runtime.enable");
  await client.call("Page.enable");
  await client.call("Page.bringToFront");
  await client.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });

  await setViewport(client, 1440, 900);
  const initial = await waitForGraph(client, deadline, { comments: false });
  await selectValue(client, 'select[aria-label="Theme"]', 'catppuccin-latte');
  await waitForValue(client, deadline, `document.documentElement.dataset.theme === 'catppuccin-latte' && document.documentElement.style.colorScheme === 'light'`, "Latte theme");
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
    for (int value : values) { sum += value; }
    return sum;
}`;
  await setTextarea(client, 'textarea[aria-label="C++ source code"]', loopSource);
  const overview = await waitForGraph(client, deadline, { comments: false, sourceToken: "smokeSum", mode: "natural" });
  if (overview.subprocessCount !== 1) throw new Error("Loop overview must show one predefined-process box.");
  await clickExpandLoops(client);
  const expanded = await waitForGraph(client, deadline, { comments: false, sourceToken: "smokeSum", mode: "natural", expanded: true });
  if (expanded.nodeCount <= overview.nodeCount || expanded.subprocessCount !== 0) throw new Error("Expand loops did not restore the loop body.");
  await clickExpandLoops(client);
  const overviewRestored = await waitForGraph(client, deadline, { comments: false, sourceToken: "smokeSum", expanded: false });
  if (overviewRestored.nodeCount !== overview.nodeCount) throw new Error("Overview node count was not restored.");

  const boxLabel = "Sum values";
  const annotation = "Checked in Windows smoke";
  const selected = await evaluate(client, `(() => {
    const box = document.querySelector('.flow-symbol--subprocess')?.closest('.react-flow__node');
    if (!box) return false;
    box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  if (!selected) throw new Error("Overview box was not clickable.");
  await waitForValue(client, deadline, `Boolean(document.querySelector('textarea[aria-label="Box label"]'))`, "box editor");
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
  const saveProjectPresent = await evaluate(client, `[...document.querySelectorAll('.toolbar button')].some(button => button.textContent.trim() === 'Save project' && !button.disabled)`);
  if (!saveProjectPresent) throw new Error("Save project control is missing.");
  // Opening a native save chooser would block this unattended CI smoke run.
  await evaluate(client, `[...document.querySelectorAll('.node-editor button')].find(button => button.textContent.trim() === 'Close')?.click()`);

  await selectValue(client, 'select[aria-label="Theme"]', 'catppuccin-mocha');
  await waitForValue(client, deadline, `document.documentElement.dataset.theme === 'catppuccin-mocha' && document.documentElement.style.colorScheme === 'dark'`, "Mocha theme");
  await setViewport(client, 760, 900);
  await evaluate(client, `document.querySelector('.react-flow__controls-fitview')?.click()`);
  await delay(500);
  const compact = await waitForGraph(client, deadline, { comments: false, sourceToken: "smokeSum", mode: "natural", expanded: false });
  const compactBytes = await capture(client, path.join(options.output, "windows-smoke-compact.png"));

  const result = {
    target: { title: target.title, url: target.url },
    wide: { width: 1440, height: 900, bytes: wideBytes, nodes: initial.nodeCount, theme: "catppuccin-latte" },
    compact: { width: 760, height: 900, bytes: compactBytes, nodes: compact.nodeCount, theme: "catppuccin-mocha" },
    comments: { initial: initial.commentCount, enabled: commentsOn.commentCount, disabled: commentsOff.commentCount },
    labelModes: ["code", "natural"],
    loopExpansion: { overview: overview.nodeCount, expanded: expanded.nodeCount, restored: overviewRestored.nodeCount },
    edits: { naturalLabel: boxLabel, annotation, retainedAcrossModeChange: true },
    projectSave: { controlPresent: saveProjectPresent, nativeDialogOpened: false, persistenceTested: false },
  };
  await writeFile(path.join(options.output, "windows-render-smoke.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Rendered ${initial.nodeCount} initial nodes; loop overview ${overview.nodeCount}/${expanded.nodeCount}; themes and box edits passed.`);
} finally {
  client?.close();
}
}

function parseArguments(args) {
  const values = { port: 9222, output: "output", timeout: 30 };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${name}.`);
    if (name === "--port") values.port = Number.parseInt(value, 10);
    else if (name === "--output") values.output = path.resolve(value);
    else if (name === "--timeout") values.timeout = Number.parseInt(value, 10);
    else throw new Error(`Unknown argument ${name}.`);
  }
  if (!Number.isInteger(values.port) || values.port < 1 || values.port > 65535) throw new Error("Invalid CDP port.");
  if (!Number.isInteger(values.timeout) || values.timeout < 5 || values.timeout > 120) throw new Error("Invalid timeout.");
  return values;
}

async function waitForTarget(baseUrl, end) {
  let lastError = "no CDP response";
  while (Date.now() < end) {
    try {
      const response = await fetch(`${baseUrl}/json/list`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const targets = await response.json();
      const target = targets.find((candidate) =>
        candidate.type === "page" &&
        candidate.webSocketDebuggerUrl &&
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
  const { comments = false, sourceToken = "firstPositive", mode, expanded } = expected;
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
        expanded: document.querySelector('.chart-options input[type="checkbox"]')?.checked ?? null,
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
    const expansionReady = expanded === undefined || (state.expanded === expanded && (expanded ? state.subprocessCount === 0 : state.subprocessCount === 1));
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

async function clickExpandLoops(client) {
  const clicked = await evaluate(client, `(() => {
    const checkbox = document.querySelector('.chart-options input[type="checkbox"]');
    if (!checkbox) return false;
    checkbox.click();
    return true;
  })()`);
  if (!clicked) throw new Error("Expand loops toggle is missing.");
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
