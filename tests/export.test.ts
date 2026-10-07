import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPngDataUrl, createSvgDocument } from "../src/exportSvg";
import type { CanvasNode } from "../src/layout";
import { THEMES } from "../src/themes";

const flow = { id: "n1", label: "Run", kind: "process", line: 3, start_byte: 0, end_byte: 3, comments: ["kept"], annotation: "also kept" };
const nodes = [{ id: "n1", type: "flowNode", position: { x: 10, y: 20 }, data: { flow } }] as CanvasNode[];
const palette = {
  background: "#010203", edgeLabelBackground: "#020304", text: "#313233", muted: "#414243", edge: "#515253",
  processFill: "#111111", processStroke: "#121212", decisionFill: "#212121", decisionStroke: "#222222",
  ioFill: "#313131", ioStroke: "#323232", terminatorFill: "#414141", terminatorStroke: "#424242",
  subprocessFill: "#616161", subprocessStroke: "#626262",
};
const svg = createSvgDocument(nodes, [], "code", palette);
assert(svg.includes('fill="#010203"'), "export uses opaque selected-theme background");
for (const color of Object.values(palette)) assert(svg.includes(color), `export uses selected palette color ${color}`);
assert(svg.includes(".node-process>rect") && svg.includes("fill:#111111;stroke:#121212"));
assert(svg.includes(".node-decision>rect") && svg.includes("fill:#212121;stroke:#222222"));
assert(svg.includes(".node-io>rect") && svg.includes("fill:#313131;stroke:#323232"));
assert(svg.includes(".node-terminator>rect") && svg.includes("fill:#414141;stroke:#424242"));
assert(svg.includes(".node-subprocess>rect") && svg.includes("fill:#616161;stroke:#626262"));
assert(svg.includes("also kept") && svg.includes("kept"), "export preserves annotations and comments");
const loopFlow = { ...flow, id: "loop", kind: "loop", label: "i < 3", shape: "decision" as const, loop_condition: "i < 3" };
const loopSvg = createSvgDocument([{ id: "loop", type: "flowNode", position: { x: 0, y: 0 }, data: { flow: loopFlow } }] as CanvasNode[], [], "code", palette);
assert(loopSvg.includes('class="node node-decision node-loop"'), "loop keeps conventional decision diamond");
assert(loopSvg.includes('class="loop-marker"') && loopSvg.includes("LOOP"), "loop export includes distinct marker");
assert(loopSvg.includes(".node-decision .loop-marker rect{fill:#212121;stroke:#222222}"), "loop marker matches its decision palette");
assert(!loopSvg.includes(".node-loop>rect,.node-loop>polygon,.node-loop>ellipse{stroke:#626262"), "loop outline keeps its shape palette");
const collapsedFlow = { ...flow, id: "collapsed", kind: "process", label: "for (...) ", shape: "subprocess" as const, loop_collapsed: true };
const collapsedSvg = createSvgDocument([{ id: "collapsed", type: "flowNode", position: { x: 0, y: 0 }, data: { flow: collapsedFlow } }] as CanvasNode[], [], "code", palette);
assert(collapsedSvg.includes('class="node node-subprocess node-loop"') && collapsedSvg.includes('class="loop-marker"'), "collapsed loop keeps subprocess shape and loop marker");
const reviewFlow = { ...flow, flagged: true, unmodified: true };
const reviewSvg = createSvgDocument([{ id: "n1", type: "flowNode", position: { x: 0, y: 0 }, data: { flow: reviewFlow } }] as CanvasNode[], [], "code", palette);
assert(reviewSvg.includes("node-unmodified node-flagged") && reviewSvg.includes("stroke-dasharray:7 4"), "unmodified export uses a dashed outline");
assert(reviewSvg.includes('class="flag-marker"') && reviewSvg.includes("FLAG") && reviewSvg.includes("Flagged for removal"), "flagged export includes visible and accessible state");
const flowchartCss = await readFile(new URL("../src/flowchart.css", import.meta.url), "utf8");
assert(!flowchartCss.includes("[data-loop] { --flow-node-border"), "canvas loop outline keeps its shape palette");
assert(flowchartCss.includes("border: 1px solid var(--flow-node-border)") && flowchartCss.includes("background: var(--flow-node-bg)"), "canvas loop marker matches its shape palette");
const officialCatppuccinTokens: Record<string, readonly string[]> = {
  "catppuccin-latte": ["#eff1f5", "#e6e9ef", "#dce0e8", "#ccd0da", "#bcc0cc", "#9ca0b0", "#4c4f69", "#5c5f77", "#8839ef", "#7287fd", "#d20f39", "#40a02b", "#fe640b", "#1e66f5", "#179299"],
  "catppuccin-frappe": ["#303446", "#292c3c", "#414559", "#51576d", "#737994", "#c6d0f5", "#b5bfe2", "#ca9ee6", "#babbf1", "#e78284", "#a6d189", "#ef9f76", "#8caaee", "#81c8be"],
  "catppuccin-macchiato": ["#24273a", "#1e2030", "#363a4f", "#494d64", "#6e738d", "#cad3f5", "#a5adcb", "#c6a0f6", "#b7bdf8", "#ed8796", "#a6da95", "#f5a97f", "#8aadf4", "#8bd5ca"],
  "catppuccin-mocha": ["#1e1e2e", "#181825", "#313244", "#45475a", "#6c7086", "#cdd6f4", "#a6adc8", "#cba6f7", "#b4befe", "#f38ba8", "#a6e3a1", "#fab387", "#89b4fa", "#94e2d5"],
};
for (const theme of THEMES.filter((candidate) => candidate.family === "Catppuccin")) {
  const official = new Set(officialCatppuccinTokens[theme.id]);
  for (const [token, value] of Object.entries(theme.colors)) {
    if (token !== "shadow") assert(official.has(value), `${theme.name} ${token} uses official Catppuccin palette value ${value}`);
  }
  for (const [token, value] of Object.entries(theme.diagram)) {
    if (token.endsWith("Stroke")) assert(official.has(value), `${theme.name} ${token} uses official Catppuccin palette value ${value}`);
  }
}
await assert.rejects(createPngDataUrl("bad"), /invalid SVG/, "PNG renderer rejects invalid geometry before allocating canvas");
console.log("PASS: export preserves official theme palettes, state parity, annotation, and bounded PNG validation");
