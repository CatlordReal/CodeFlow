import assert from "node:assert/strict";
import { createPngDataUrl, createSvgDocument } from "../src/exportSvg";
import type { CanvasNode } from "../src/layout";

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
const collapsedFlow = { ...flow, id: "collapsed", kind: "process", label: "for (...) ", shape: "subprocess" as const, loop_collapsed: true };
const collapsedSvg = createSvgDocument([{ id: "collapsed", type: "flowNode", position: { x: 0, y: 0 }, data: { flow: collapsedFlow } }] as CanvasNode[], [], "code", palette);
assert(collapsedSvg.includes('class="node node-subprocess node-loop"') && collapsedSvg.includes('class="loop-marker"'), "collapsed loop keeps subprocess shape and loop marker");
const reviewFlow = { ...flow, flagged: true, unmodified: true };
const reviewSvg = createSvgDocument([{ id: "n1", type: "flowNode", position: { x: 0, y: 0 }, data: { flow: reviewFlow } }] as CanvasNode[], [], "code", palette);
assert(reviewSvg.includes("node-unmodified node-flagged") && reviewSvg.includes("stroke-dasharray:7 4"), "unmodified export uses a dashed outline");
assert(reviewSvg.includes('class="flag-marker"') && reviewSvg.includes("FLAG") && reviewSvg.includes("Flagged for removal"), "flagged export includes visible and accessible state");
await assert.rejects(createPngDataUrl("bad"), /invalid SVG/, "PNG renderer rejects invalid geometry before allocating canvas");
console.log("PASS: export preserves theme, annotation, and bounded PNG validation");
