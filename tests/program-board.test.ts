import assert from "node:assert/strict";
import type { CanvasNode } from "../src/layout";
import {
  arrangeProgramGroups, buildProgramCallEdges, composeProgramSvg, namespaceProgramDiagram, positionProgramEdges, programGroupId,
  type ProgramDiagram,
  isProgramEntry,
} from "../src/programLayout";
import type { FunctionInfo, FlowNode } from "../src/types";

const info = (id: string, name: string, identity?: string): FunctionInfo => ({ id, name, identity, line: 1 });
const flow = (id: string, kind: string, label: string): FlowNode => ({ id, kind, label, original_label: label, line: 1, start_byte: 0, end_byte: 1, comments: [] });
const node = (item: FlowNode, x = 0, y = 0): CanvasNode => ({ id: item.id, type: "flowNode", position: { x, y }, data: { flow: item } });

const main = info("function:main", "main", "stable-main");
assert.equal(programGroupId(main), "program:function:main", "group ID uses raw function ID shared with saved positions");
assert(isProgramEntry(main) && isProgramEntry(info("cs:method:Main", "Main")) && isProgramEntry(info("cs:top", "Top-level statements")), "C++, C# Main, and C# top-level code are entries");
const namespaced = namespaceProgramDiagram(programGroupId(main), [node(flow("n1", "start", "Start"))], [{ id: "e1", source: "n1", target: "n1", type: "flowEdge", data: { points: [], labelPosition: { x: 0, y: 0 }, sourceOrigin: { x: 0, y: 0 }, targetOrigin: { x: 0, y: 0 } } }]);
assert.equal(namespaced.nodes[0].id, "program:function:main/n1");
assert.deepEqual([namespaced.edges[0].id, namespaced.edges[0].source, namespaced.edges[0].target], ["program:function:main/e1", "program:function:main/n1", "program:function:main/n1"]);
const placed = positionProgramEdges("program:function:main", [{ id: "route", source: "n1", target: "n2", type: "flowEdge", label: "Yes", data: { points: [{ x: 10, y: 20 }, { x: 10, y: 80 }], labelPosition: { x: 24, y: 42 }, sourceOrigin: { x: 0, y: 0 }, targetOrigin: { x: 0, y: 100 } } }], { x: 300, y: 400 }, { x: 18, y: 56 })[0];
assert.deepEqual(placed.data?.points, [{ x: 328, y: 476 }, { x: 328, y: 536 }], "program route follows group and content offsets");
assert.deepEqual(placed.data?.labelPosition, { x: 342, y: 498 }, "program label follows group drag offset");
assert.deepEqual([placed.source, placed.target, placed.type, placed.zIndex], ["program:function:main/n1", "program:function:main/n2", "flowEdge", 1], "program internal edge keeps custom route above group");

const groups = [
  { id: "program:b", info: info("b", "helper"), width: 420, height: 260 },
  { id: "program:function:main", info: main, width: 520, height: 310 },
  { id: "program:c", info: info("c", "last"), width: 390, height: 240 },
];
const positions = arrangeProgramGroups(groups, 40, 1000);
assert.deepEqual(positions["program:function:main"], { x: 0, y: 0 }, "main entrypoint is placed first");
for (let index = 0; index < groups.length; index++) for (let other = index + 1; other < groups.length; other++) {
  const a = groups[index], b = groups[other], pa = positions[a.id], pb = positions[b.id];
  assert(pa.x + a.width <= pb.x || pb.x + b.width <= pa.x || pa.y + a.height <= pb.y || pb.y + b.height <= pa.y, `${a.id} and ${b.id} do not overlap`);
}
const withSaved = arrangeProgramGroups([{ ...groups[0], position: { x: 0, y: 0 } }, groups[1]], 40, 1000);
assert.deepEqual(withSaved["program:b"], { x: 0, y: 0 }, "saved raw-function position is retained");
assert(withSaved["program:function:main"].x >= groups[0].width + 40, "new group avoids saved group");
const reachable = [
  { id: "program:main", info: info("main", "main"), width: 100, height: 100 },
  { id: "program:twice", info: info("twice", "twice"), width: 100, height: 100 },
  { id: "program:total", info: info("total", "total"), width: 100, height: 100 },
  { id: "program:unused", info: info("unused", "unused"), width: 100, height: 100 },
];
const reachablePositions = arrangeProgramGroups(reachable, 20, 1000, [
  { id: "c1", source: "program:main", target: "program:total", label: "calls total", sourceGroup: "program:main", targetGroup: "program:total" },
  { id: "c2", source: "program:total", target: "program:twice", label: "calls twice", sourceGroup: "program:total", targetGroup: "program:twice" },
]);
assert(reachablePositions["program:main"].x < reachablePositions["program:total"].x && reachablePositions["program:total"].x < reachablePositions["program:twice"].x && reachablePositions["program:twice"].x < reachablePositions["program:unused"].x, "auto-layout follows entry call reachability before unused functions");

const diagrams: ProgramDiagram[] = [
  { ...groups[1], nodes: [node({ ...flow("start", "start", "Start"), start_byte: 0, end_byte: 100 }), node({ ...flow("call", "decision", "if helper"), start_byte: 10, end_byte: 20 }, 0, 90)], edges: [] },
  { ...groups[0], nodes: [node(flow("entry", "start", "Start"))], edges: [] },
];
const calls = buildProgramCallEdges([{ source: "stable-main", target: "b", label: "helper", start_byte: 12, end_byte: 14 }], diagrams);
assert.equal(calls.length, 1);
assert.equal(calls[0].source, "program:function:main/call", "native call range anchors most-specific containing box regardless of shape");
assert.equal(calls[0].target, "program:b/entry", "call targets function start box");
assert.equal(calls[0].label, "calls helper");
assert.equal(buildProgramCallEdges([{ source: "missing", target: "b", label: "helper" }], diagrams).length, 0, "unknown source never creates inferred sequential flow");
assert.equal(buildProgramCallEdges([{ source: "stable-main", target: "b", label: "helper" }], diagrams)[0].source, "program:function:main", "missing native range uses safe group port");
const ambiguous = [{ ...diagrams[0], nodes: [...diagrams[0].nodes, node({ ...flow("call2", "process", "helper"), start_byte: 10, end_byte: 20 }, 0, 160)] }, diagrams[1]];
assert.equal(buildProgramCallEdges([{ source: "stable-main", target: "b", label: "helper", start_byte: 12, end_byte: 14 }], ambiguous)[0].source, "program:function:main", "equally specific native ranges use safe group port");

const palette = { background: "#000", edgeLabelBackground: "#111", text: "#fff", muted: "#aaa", edge: "#888", processFill: "#111", processStroke: "#0af", decisionFill: "#111", decisionStroke: "#f0f", ioFill: "#111", ioStroke: "#0ff", terminatorFill: "#111", terminatorStroke: "#fa0", subprocessFill: "#111", subprocessStroke: "#0f0" };
const escaped = [{ ...diagrams[0], info: { ...diagrams[0].info, name: "main <entry>&" } }, diagrams[1]];
const svg = composeProgramSvg(escaped, [{ ...calls[0], label: "calls <helper>&" }], positions, palette, () => '<svg viewBox="0 0 10 10"><text>&amp;</text></svg>');
assert(svg.includes("main &lt;entry&gt;&amp;") && svg.includes("calls &lt;helper&gt;&amp;"), "export escapes function and call labels");
assert(svg.includes("stroke-dasharray:8 6"), "export preserves dashed call links");
assert(svg.indexOf('class="group"') < svg.indexOf('class="call"'), "export call links layer above group cards like canvas links");
const overflowing = composeProgramSvg([{ ...diagrams[0], width: 100, height: 100 }], [], { "program:function:main": { x: 40, y: 50 } }, palette, () => '<svg viewBox="-200 -70 700 400"><text>wide label</text></svg>');
assert(overflowing.includes('viewBox="-190 -12 796 496"'), "program export bounds include nested diagram overflow on every side");
assert(overflowing.includes('<svg x="-142" y="36" width="700" height="400"'), "nested diagram keeps its translated viewBox extent");
assert(composeProgramSvg(diagrams, calls, positions, palette, () => '<svg viewBox="0 0 10 10"></svg>').includes("ENTRY"), "export marks main entrypoint");
assert.equal(composeProgramSvg([{ ...diagrams[0], error: "Unavailable" }], [], positions, palette, () => ""), "", "export remains empty when any group failed");

console.log("PASS: program board keeps IDs, strict calls, non-overlap, and escaped complete export");
