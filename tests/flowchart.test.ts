import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { analyzeLoops, overviewGraph, simplifyGraph } from "../src/simplify";
import { layoutGraph, NODE_WIDTH, nodeHeight, type RoutePoint } from "../src/layout";
import { createSvgDocument } from "../src/exportSvg";
import type { FlowGraph, FlowNode } from "../src/types";

const node = (id: string, kind: string, label = id, start = Number(id.replace(/\D/g, "")) * 10): FlowNode => ({ id, kind, label, line: 1, start_byte: start, end_byte: start + 5, comments: [] });
const graph = (nodes: FlowNode[], links: [string, string, string?][]): FlowGraph => ({ nodes, edges: links.map(([source, target, label], index) => ({ id: `e${index}`, source, target, label: label ?? "" })), diagnostics: [] });
const input = graph([node("n0", "start", "work"), node("n1", "decision", "x > 0"), node("n2", "process", "x = 2"), node("n3", "merge", "Continue"), node("n4", "process", "x += 1"), node("n5", "return", "return x"), node("n6", "end", "End")], [["n0", "n1"], ["n1", "n2", "Yes"], ["n1", "n3", "No"], ["n2", "n3"], ["n3", "n4"], ["n4", "n5"]]);
const snapshot = JSON.stringify(input);
const simple = simplifyGraph(input);
assert.equal(JSON.stringify(input), snapshot, "transform must not mutate analyzer output");
assert(!simple.nodes.some((item) => item.kind === "merge" || item.kind === "end"));
assert.equal(simple.nodes[0].label, "Start");
assert.equal(simple.nodes[0].original_label, "work");
assert(simple.edges.some((edge) => edge.source === "n1" && edge.target === "n4" && edge.label === "No"));
assert.equal(simple.nodes.find((item) => item.id === "n5")?.shape, "terminator");
assert.deepEqual(simplifyGraph(simple), simple, "simplification must be idempotent");

const grouped = simplifyGraph(graph([node("n0", "start"), node("n1", "process", "x = 1"), node("n2", "process", "x += 2"), node("n3", "end")], [["n0", "n1"], ["n1", "n2"], ["n2", "n3"]]));
assert.equal(grouped.nodes.length, 3);
assert.equal(grouped.nodes[1].label, "x = 1\nx += 2");
assert.deepEqual(grouped.nodes[1].source_ids, ["n1", "n2"]);
assert.equal(grouped.nodes[1].end_byte, 25);
const mixed = simplifyGraph(graph([node("n0", "start"), node("n1", "process", 'cout << x\nx = 3\ncin >> x'), node("n2", "end")], [["n0", "n1"], ["n1", "n2"]]));
assert.deepEqual(mixed.nodes.slice(1, -1).map((item) => item.shape), ["io", "process", "io"]);
assert.equal(mixed.edges.length, 4);
const jump = simplifyGraph(graph([node("n0", "start"), node("n1", "loop", "x < 10"), node("n2", "decision", "skip"), node("n3", "continue", "Continue"), node("n4", "break", "Break"), node("n5", "end")], [["n0", "n1"], ["n1", "n2", "Yes"], ["n1", "n5", "No"], ["n2", "n3", "Yes"], ["n3", "n1"], ["n2", "n4", "No"], ["n4", "n5"]]));
assert(jump.edges.some((edge) => edge.source === "n2" && edge.target === "n1" && edge.label === "Yes"));
assert(jump.edges.some((edge) => edge.source === "n2" && edge.target === "n5" && edge.label === "No"));
assert(!jump.nodes.some((item) => ["break", "continue"].includes(item.kind)));
assert(nodeHeight({ ...node("n1", "process"), annotation: "Useful note" }) > nodeHeight(node("n1", "process")));

const loopHeader = { ...node("n1", "loop", "x < 10"), end_byte: 70 };
const overviewInput = simplifyGraph(graph([node("n0", "start"), loopHeader, node("n2", "process", "x += 1"), node("n8", "end")], [["n0", "n1"], ["n1", "n2", "Yes"], ["n2", "n1", "Repeat"], ["n1", "n8", "No"]]));
const overviewSnapshot = JSON.stringify(overviewInput);
const overview = overviewGraph(overviewInput);
assert.equal(JSON.stringify(overviewInput), overviewSnapshot, "overview must not mutate expanded graph");
assert.equal(overview.nodes.length, 3);
assert.equal(overview.nodes[1].shape, "subprocess");
assert.deepEqual(overview.nodes[1].source_ids, ["n1", "n2"]);
assert.equal(overview.nodes[1].start_byte, 10);
assert.equal(overview.nodes[1].end_byte, 70);
assert(overview.edges.some((edge) => edge.source === "n1" && edge.target === "n8" && !edge.label));
assert.deepEqual(overviewGraph(overview), overview, "overview must be idempotent");
const unsafe = (extraNodes: FlowNode[], extraEdges: [string, string, string?][]) => simplifyGraph(graph([node("n0", "start"), loopHeader, node("n2", "process", "x += 1"), node("n8", "end"), ...extraNodes], [["n0", "n1"], ["n1", "n2", "Yes"], ["n2", "n1", "Repeat"], ["n1", "n8", "No"], ...extraEdges]));
assert(!overviewGraph(unsafe([node("n3", "return", "return x")], [["n2", "n3"]])).nodes.some((item) => item.shape === "subprocess"), "loops with returns must stay expanded");
assert(!overviewGraph(unsafe([node("n9", "end")], [["n2", "n9"]])).nodes.some((item) => item.shape === "subprocess"), "multiple exits must stay expanded");
assert(!overviewGraph(unsafe([], [["n0", "n2"]])).nodes.some((item) => item.shape === "subprocess"), "outside body entry must stay expanded");
assert(!overviewGraph(unsafe([{ ...node("n3", "process"), end_byte: 90 }], [["n2", "n3"]])).nodes.some((item) => item.shape === "subprocess"), "partial source ranges must stay expanded");
assert(!overviewGraph(unsafe([{ ...node("n7", "process"), start_byte: 5, end_byte: 20 }], [["n0", "n7"], ["n7", "n1"]])).nodes.some((item) => item.shape === "subprocess"), "left-boundary overlaps must stay expanded");

const nestedInput = simplifyGraph(graph([
  node("n0", "start"), { ...node("n1", "loop", "outer"), end_byte: 100 },
  { ...node("n2", "loop", "inner"), start_byte: 30, end_byte: 70 },
  { ...node("n3", "process", "inside"), start_byte: 40, end_byte: 45 },
  { ...node("n4", "process", "after inner"), start_byte: 80, end_byte: 85 }, node("n9", "end", "End", 110),
], [["n0", "n1"], ["n1", "n2", "Yes"], ["n2", "n3", "Yes"], ["n3", "n2", "Repeat"], ["n2", "n4", "No"], ["n4", "n1", "Repeat"], ["n1", "n9", "No"]]));
const nestedSnapshot = JSON.stringify(nestedInput);
assert.deepEqual(analyzeLoops(nestedInput).map(({ id, depth, parent_id, can_collapse }) => ({ id, depth, parent_id, can_collapse })), [
  { id: "n1", depth: 0, parent_id: null, can_collapse: true },
  { id: "n2", depth: 1, parent_id: "n1", can_collapse: true },
]);
const loopState = (value: FlowGraph) => value.nodes.filter((item) => item.loop_id).map((item) => [item.loop_id, item.loop_depth, item.loop_collapsed, item.loop_can_collapse]);
assert.deepEqual(loopState(overviewGraph(nestedInput)), [["n1", 0, true, true]], "depth 0 collapses outer loops");
assert.deepEqual(loopState(overviewGraph(nestedInput, { depth: 1 })), [["n1", 0, false, true], ["n2", 1, true, true]], "depth 1 expands outer loops");
assert.deepEqual(loopState(overviewGraph(nestedInput, { depth: 2 })), [["n1", 0, false, true], ["n2", 1, false, true]], "depth 2 expands nested loops");
assert.deepEqual(loopState(overviewGraph(nestedInput, { depth: null })), [["n1", 0, false, true], ["n2", 1, false, true]], "null expands all loops");
assert.deepEqual(loopState(overviewGraph(nestedInput, { overrides: { n2: true } })), [["n1", 0, false, true], ["n2", 1, false, true]], "expanded descendant exposes ancestors");
assert.deepEqual(loopState(overviewGraph(nestedInput, { depth: null, overrides: { n2: false } })), [["n1", 0, false, true], ["n2", 1, true, true]], "collapse override beats global depth");
assert.equal(JSON.stringify(nestedInput), nestedSnapshot, "nested overview must not mutate expanded graph");
const siblingInput = simplifyGraph(graph([
  node("n0", "start"), { ...node("n1", "loop", "first"), end_byte: 40 }, node("n2", "process", "first body", 20),
  { ...node("n5", "loop", "second", 50), end_byte: 80 }, node("n6", "process", "second body", 60), node("n9", "end", "End", 90),
], [["n0", "n1"], ["n1", "n2", "Yes"], ["n2", "n1", "Repeat"], ["n1", "n5", "No"], ["n5", "n6", "Yes"], ["n6", "n5", "Repeat"], ["n5", "n9", "No"]]));
assert.deepEqual(loopState(overviewGraph(siblingInput, { overrides: { n5: true } })), [["n1", 0, true, true], ["n5", 0, false, true]], "sibling overrides stay independent");
const equalRangeInput = graph([
  node("n0", "start"), { ...node("n1", "loop", "first"), end_byte: 70 },
  { ...node("n2", "loop", "second"), start_byte: 10, end_byte: 70 }, node("n3", "process", "body", 30), node("n9", "end", "End", 90),
], [["n0", "n1"], ["n1", "n2"], ["n2", "n3"], ["n3", "n1"], ["n1", "n9"]]);
assert.deepEqual(analyzeLoops(equalRangeInput).map(({ id, parent_id, can_collapse }) => ({ id, parent_id, can_collapse })), [
  { id: "n1", parent_id: null, can_collapse: false }, { id: "n2", parent_id: null, can_collapse: false },
], "equal loop ranges are noncollapsible peers");
assert.doesNotThrow(() => overviewGraph(equalRangeInput, { overrides: { n1: true, n2: true } }), "malformed loop metadata must not cycle");

function verifyOverviewBoundaries(expanded: FlowGraph, overview: FlowGraph) {
  const ownership = new Map<string, FlowNode>();
  for (const item of expanded.nodes) {
    const owner = overview.nodes.find((candidate) => candidate.id === item.id)
      ?? overview.nodes.find((candidate) => candidate.shape === "subprocess" && item.start_byte >= candidate.start_byte && item.end_byte <= candidate.end_byte && (item.source_ids ?? [item.id]).every((id) => candidate.source_ids?.includes(id)));
    assert(owner, "overview must retain every source node in a source group");
    ownership.set(item.id, owner);
  }
  for (const edge of expanded.edges) {
    const source = ownership.get(edge.source), target = ownership.get(edge.target);
    assert(source && target, "overview must retain every source node in a source group");
    if (source.id === target.id) continue;
    const output = overview.edges.find((item) => item.source === source.id && item.target === target.id);
    assert(output, "overview must preserve every external transition");
    if (source.shape !== "subprocess") assert.equal(output.label, edge.label, "external branch labels must stay exact");
  }
}
verifyOverviewBoundaries(overviewInput, overview);

function segmentHitsBox(a: RoutePoint, b: RoutePoint, x: number, y: number, width: number, height: number): boolean {
  const epsilon = 0.01;
  if (a.x === b.x) return a.x > x + epsilon && a.x < x + width - epsilon && Math.max(a.y, b.y) > y + epsilon && Math.min(a.y, b.y) < y + height - epsilon;
  if (a.y === b.y) return a.y > y + epsilon && a.y < y + height - epsilon && Math.max(a.x, b.x) > x + epsilon && Math.min(a.x, b.x) < x + width - epsilon;
  throw new Error("Route must be orthogonal");
}

async function verifyLayout(simple: FlowGraph, name: string) {
  const canvas = await layoutGraph(simple);
  assert.equal(canvas.nodes.length, simple.nodes.length);
  assert.equal(canvas.edges.length, simple.edges.length);
  const start = canvas.nodes.find((item) => item.data.flow.kind === "start")!;
  assert.equal(start.position.y, Math.min(...canvas.nodes.map((item) => item.position.y)), `${name}: Start must be topmost`);
  for (const edge of canvas.edges) {
    assert(edge.data?.points.length, `${name}: ${edge.id} missing actual route`);
    if (edge.targetHandle === "in-n") {
      const source = canvas.nodes.find((item) => item.id === edge.source)!;
      const target = canvas.nodes.find((item) => item.id === edge.target)!;
      assert(target.position.y >= source.position.y + nodeHeight(source.data.flow), `${name}: forward flow must descend (${edge.id})`);
    }
    for (let index = 1; index < edge.data!.points.length; index++) {
      const a = edge.data!.points[index - 1], b = edge.data!.points[index];
      assert(a.x === b.x || a.y === b.y, `${name}: nonorthogonal segment`);
      for (const other of canvas.nodes) {
        if (other.id === edge.source || other.id === edge.target) continue;
        assert(!segmentHitsBox(a, b, other.position.x, other.position.y, NODE_WIDTH, nodeHeight(other.data.flow)), `${name}: ${edge.id} crosses ${other.id}`);
      }
    }
  }
  const svg = createSvgDocument(canvas.nodes, canvas.edges);
  assert(svg.includes("<ellipse"), `${name}: conventional terminators in export`);
  if (simple.nodes.some((item) => item.shape === "decision" || item.shape === "io")) assert(svg.includes("<polygon"), `${name}: conventional decisions/IO in export`);
  for (const edge of canvas.edges) assert(svg.includes(`M ${edge.data!.points[0].x} ${edge.data!.points[0].y}`), `${name}: export uses actual routes`);
  return canvas;
}
await verifyLayout(simple, "branch");
await verifyLayout(jump, "loop jumps");
await verifyLayout(overview, "loop overview");
const fixture = new URL("../.local/sample-graphs.json", import.meta.url);
// esbuild runs this test from .local, where the same filename stays local and private.
const fixturePath = existsSync(fixture) ? fixture : new URL("./sample-graphs.json", import.meta.url);
if (existsSync(fixturePath)) {
  const samples = JSON.parse(readFileSync(fixturePath, "utf8"));
  const simplified = structuredClone(samples);
  const overviews = structuredClone(samples);
  for (const entry of samples.functions) {
    for (const [mode, sourceGraph] of Object.entries(samples.graphs[entry.id])) {
      const output = simplifyGraph(sourceGraph as FlowGraph);
      assert(!output.nodes.some((item) => ["merge", "break", "continue"].includes(item.kind)));
      await verifyLayout(output, `${entry.name}/${mode}`);
      simplified.graphs[entry.id][mode] = output;
      const summary = overviewGraph(output);
      await verifyLayout(summary, `${entry.name}/${mode}/overview`);
      verifyOverviewBoundaries(output, summary);
      overviews.graphs[entry.id][mode] = summary;
      console.log(`${entry.name}/${mode}: ${(sourceGraph as FlowGraph).nodes.length} to ${output.nodes.length} expanded, ${summary.nodes.length} overview nodes`);
    }
  }
  writeFileSync(new URL("./simplified-graphs.json", fixturePath), JSON.stringify(simplified));
  writeFileSync(new URL("./overview-graphs.json", fixturePath), JSON.stringify(overviews));
}
console.log("Flowchart regression checks passed");
