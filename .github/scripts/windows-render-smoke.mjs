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
  const initial = await waitForGraph(client, deadline, true);
  const wideBytes = await capture(client, path.join(options.output, "windows-smoke-wide.png"));

  await clickComments(client);
  const commentsOff = await waitForGraph(client, deadline, false);
  if (commentsOff.nodeCount !== initial.nodeCount) {
    throw new Error(`Comments toggle changed flow node count (${initial.nodeCount} to ${commentsOff.nodeCount}).`);
  }

  await clickComments(client);
  const commentsRestored = await waitForGraph(client, deadline, true);
  await setViewport(client, 760, 900);
  await evaluate(client, `document.querySelector('.react-flow__controls-fitview')?.click()`);
  await delay(500);
  const compact = await waitForGraph(client, deadline, true);
  const compactBytes = await capture(client, path.join(options.output, "windows-smoke-compact.png"));

  const result = {
    target: { title: target.title, url: target.url },
    wide: { width: 1440, height: 900, bytes: wideBytes, nodes: initial.nodeCount },
    compact: { width: 760, height: 900, bytes: compactBytes, nodes: compact.nodeCount },
    comments: {
      initial: initial.commentCount,
      disabled: commentsOff.commentCount,
      restored: commentsRestored.commentCount,
    },
  };
  await writeFile(
    path.join(options.output, "windows-render-smoke.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(`Rendered ${initial.nodeCount} flow nodes; comments ${initial.commentCount}/0/${commentsRestored.commentCount}.`);
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

async function waitForGraph(client, end, commentsExpected) {
  let state;
  while (Date.now() < end) {
    state = await evaluate(client, `(() => {
      const checkbox = document.querySelector('.toggle input[type="checkbox"]');
      return {
        ready: document.readyState,
        title: document.title,
        desktopRuntime: Boolean(window.__TAURI_INTERNALS__),
        sourceLoaded: document.querySelector('textarea[aria-label="C++ source code"]')?.value.includes('firstPositive') ?? false,
        nodeCount: document.querySelectorAll('.flow-node').length,
        commentCount: document.querySelectorAll('.flow-node__comments').length,
        checked: checkbox?.checked ?? null,
        busy: Boolean(document.querySelector('.analysis-progress')),
        error: document.querySelector('.chart-status--error')?.textContent?.trim() ?? '',
        empty: document.querySelector('.empty-state')?.textContent?.trim() ?? '',
        kinds: [...document.querySelectorAll('.flow-node__meta span:first-child')].map((node) => node.textContent?.trim()),
      };
    })()`);
    if (state.error) throw new Error(`CodeFlow rendered an error: ${state.error}`);
    const commentsReady = commentsExpected
      ? state.checked === true && state.commentCount > 0
      : state.checked === false && state.commentCount === 0;
    if (
      state.ready === "complete" &&
      state.desktopRuntime &&
      state.title.includes("CodeFlow") &&
      state.sourceLoaded &&
      state.nodeCount >= 4 &&
      state.kinds.includes("Entry") &&
      state.kinds.includes("Return") &&
      !state.busy &&
      commentsReady
    ) {
      return state;
    }
    await delay(200);
  }
  throw new Error(`CodeFlow graph did not reach expected state: ${JSON.stringify(state)}.`);
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
