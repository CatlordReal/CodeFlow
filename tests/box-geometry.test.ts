import assert from 'node:assert/strict';
import { snapBoxPosition, positionedCanvas } from '../src/boxGeometry';
import { routeLabelBounds } from '../src/layout';
import type { CanvasNode, CanvasEdge } from '../src/layout';
const node = (id: string, x: number, y: number, width = 100, height = 80): CanvasNode => ({ id, type: 'flowNode', position: {x,y}, width, height, data: { flow: { id, label: id, kind: 'process', line: 1, start_byte: 0, end_byte: 1, comments: [] } } });
const a = node('a', 0, 0), b = node('b', 200, 200, 120, 100);
assert.deepEqual(snapBoxPosition([a,b], 'a', {x: 202, y: 0}, 1).position, {x:200,y:0});
assert.equal(snapBoxPosition([a,b], 'a', {x: 213, y: 0}, 1).position.x, 210); // centers
assert.equal(snapBoxPosition([a,b], 'a', {x: 223, y: 0}, 1).position.x, 220); // right edges
assert.equal(snapBoxPosition([a,b], 'a', {x: 204, y: 0}, 2).position.x, 204);
assert.equal(snapBoxPosition([a,b], 'a', {x: 204, y: 0}, 1, true).position.x, 204);
const source = node('source', 0, 0), target = node('target', 0, 200);
const edge: CanvasEdge = { id: 'edge', source: 'source', target: 'target', sourceHandle: 'out-s', targetHandle: 'in-n', type: 'flowEdge', label: 'Yes', data: { points: [{x:50,y:80},{x:50,y:200}], labelPosition: {x:69,y:107}, sourceOrigin: {x:0,y:0}, targetOrigin: {x:0,y:200} } };
assert.equal(positionedCanvas([source,target], [edge]).edges[0].data!.points, edge.data!.points);
const movedSource = {...source, data: {flow: {...source.data.flow, position: {x:150,y:0}}}};
const movedTarget = {...target, data: {flow: {...target.data.flow, position: {x:100,y:250}}}};
for (const nodes of [[movedSource,target], [source,movedTarget], [movedSource,movedTarget]]) {
 const output = positionedCanvas(nodes, [edge]);
 const points = output.edges[0].data!.points;
 assert.deepEqual(points[0], {x:output.nodes[0].position.x + 50,y:output.nodes[0].position.y + 80});
 assert.deepEqual(points.at(-1), {x:output.nodes[1].position.x + 50,y:output.nodes[1].position.y});
 for(let i=1;i<points.length;i++) assert.ok(points[i].x===points[i-1].x || points[i].y===points[i-1].y);
 const label = routeLabelBounds(output.edges[0].data!.labelPosition,'Yes');
 for(const n of output.nodes) assert.ok(!(label.x < n.position.x + 100 && label.x + label.width > n.position.x && label.y < n.position.y + 80 && label.y + label.height > n.position.y));
}
console.log('box geometry tests passed');

// Cross-anchor alignment: moving right edge aligns to target left edge.
assert.equal(snapBoxPosition([a,b], 'a', {x: 103, y: 0}, 1).position.x, 100);
const obstacle = node('obstacle', 300, 100, 100, 80);
const movedObstacle = {...obstacle, data: {flow: {...obstacle.data.flow, position: {x: 0, y: 100}}}};
const rerouted = positionedCanvas([source,target,movedObstacle], [edge]).edges[0].data!.points;
assert.notEqual(rerouted, edge.data!.points);
const second: CanvasEdge = {...edge, id: 'second', label: 'No'};
const placed = positionedCanvas([source,target], [edge,second]).edges;
for (const item of placed) {
 const p = item.data!.labelPosition;
 assert.ok(item.data!.points.some((q,i,all) => i > 0 && ((q.x === all[i-1].x && p.x === q.x && p.y >= Math.min(q.y,all[i-1].y) && p.y <= Math.max(q.y,all[i-1].y)) || (q.y === all[i-1].y && p.y === q.y && p.x >= Math.min(q.x,all[i-1].x) && p.x <= Math.max(q.x,all[i-1].x)))));
}
const firstLabel = routeLabelBounds(placed[0].data!.labelPosition, 'Yes'), secondLabel = routeLabelBounds(placed[1].data!.labelPosition, 'No');
assert.ok(!(firstLabel.x < secondLabel.x + secondLabel.width && firstLabel.x + firstLabel.width > secondLabel.x && firstLabel.y < secondLabel.y + secondLabel.height && firstLabel.y + firstLabel.height > secondLabel.y));

const alreadyMovedObstacle = {...movedObstacle, position: {x:0,y:100}};
assert.notEqual(positionedCanvas([source,target,alreadyMovedObstacle], [edge], new Map(), new Set(['obstacle'])).edges[0].data!.points, edge.data!.points, 'explicit moved node reroutes obstructed unrelated edges');

// An unrelated box forcing a detour must also reshape the edge when moved away.
const distantTarget = node('target', 0, 400);
const longEdge: CanvasEdge = {...edge, data: {...edge.data!, points: [{x:50,y:80},{x:50,y:400}], targetOrigin: {x:0,y:400}}};
const blocking = node('obstacle', 0, 200);
const blocked = positionedCanvas([source, distantTarget, blocking], [longEdge], new Map(), new Set(['obstacle']));
const clearObstacle = {...blocking, position: {x: 300, y: 200}};
const cleared = positionedCanvas([source, distantTarget, clearObstacle], blocked.edges, new Map(), new Set(['obstacle']));
assert.notDeepEqual(cleared.edges[0].data!.points, blocked.edges[0].data!.points, 'moving an obstacle away releases its detour');
assert.deepEqual(cleared.edges[0].data!.points, [{x:50,y:80},{x:50,y:400}]);

// Replaying a saved position and restoring it must keep each handle attached.
const sideEdge: CanvasEdge = {...edge, sourceHandle: 'out-e', targetHandle: 'in-w', data: {...edge.data!, points: [{x:100,y:40},{x:150,y:40},{x:150,y:240},{x:0,y:240}]}};
const movedSide = positionedCanvas([movedSource, movedTarget], [sideEdge]);
assert.deepEqual(movedSide.edges[0].data!.points[0], {x:250,y:40});
assert.deepEqual(movedSide.edges[0].data!.points.at(-1), {x:100,y:290});
const restored = positionedCanvas([source, target], movedSide.edges);
assert.deepEqual(restored.edges[0].data!.points[0], {x:100,y:40});
assert.deepEqual(restored.edges[0].data!.points.at(-1), {x:0,y:240});

// Alternating barriers require more than one turn between the endpoint stubs.
const mazeTarget = node('target', 0, 1000);
const mazeEdge: CanvasEdge = {...edge, data: {...edge.data!, targetOrigin: {x:0,y:900}}};
const maze = [node('left-wall', -300, -100, 200, 1300), node('right-wall', 200, -100, 200, 1300), node('first-wall', -100, 250, 200, 80), node('second-wall', 0, 550, 200, 80)];
const mazePath = positionedCanvas([source, mazeTarget, ...maze], [mazeEdge]).edges[0].data!.points;
assert.deepEqual(mazePath[0], {x:50,y:80});
assert.deepEqual(mazePath.at(-1), {x:50,y:1000});
for (let i = 1; i < mazePath.length; i++) {
 const a = mazePath[i - 1], b = mazePath[i];
 assert.ok(a.x === b.x || a.y === b.y, 'maze route remains orthogonal');
 for (const box of maze) {
  const {x, y} = box.position, width = box.width!, height = box.height!;
  const hit = a.x === b.x ? a.x > x && a.x < x + width && Math.max(a.y,b.y) > y && Math.min(a.y,b.y) < y + height : a.y > y && a.y < y + height && Math.max(a.x,b.x) > x && Math.min(a.x,b.x) < x + width;
  assert.equal(hit, false, `maze route avoids ${box.id}`);
 }
}

// Collision avoidance must win even when the clear route exceeds one million units.
const wideTarget = node('target', 0, 2_000_000);
const wideEdge: CanvasEdge = {...edge, data: {...edge.data!, targetOrigin: {x:0,y:1_900_000}}};
const wideObstacle = node('wide-obstacle', -2_000_000, 1_000_000, 4_000_000, 80);
const widePath = positionedCanvas([source, wideTarget, wideObstacle], [wideEdge]).edges[0].data!.points;
for (let i = 1; i < widePath.length; i++) {
 const a = widePath[i - 1], b = widePath[i], {x,y} = wideObstacle.position;
 const hit = a.x === b.x ? a.x > x && a.x < x + 4_000_000 && Math.max(a.y,b.y) > y && Math.min(a.y,b.y) < y + 80 : a.y > y && a.y < y + 80 && Math.max(a.x,b.x) > x && Math.min(a.x,b.x) < x + 4_000_000;
 assert.equal(hit, false, 'large route avoids obstacle');
}

// Opposed close ports with a diagonal offset must not reverse along the travel axis.
for (const [sourceSide, targetSide, sourcePosition, targetPosition, axis, sign] of [
 ['s','n',{x:0,y:0},{x:150,y:100},'y',1],
 ['n','s',{x:0,y:100},{x:150,y:0},'y',-1],
 ['e','w',{x:0,y:0},{x:120,y:150},'x',1],
 ['w','e',{x:120,y:0},{x:0,y:150},'x',-1],
] as const) {
 const from = node('source',sourcePosition.x,sourcePosition.y), to = node('target',targetPosition.x,targetPosition.y);
 const connection: CanvasEdge = {...edge,sourceHandle:`out-${sourceSide}`,targetHandle:`in-${targetSide}`,data:{...edge.data!,sourceOrigin:{x:-1,y:-1}}};
 const points = positionedCanvas([from,to],[connection]).edges[0].data!.points;
 const expectedStart = sourceSide === 's' ? {x:50,y:80} : sourceSide === 'n' ? {x:50,y:100} : sourceSide === 'e' ? {x:100,y:40} : {x:120,y:40};
 const expectedEnd = targetSide === 'n' ? {x:200,y:100} : targetSide === 's' ? {x:200,y:80} : targetSide === 'w' ? {x:120,y:190} : {x:100,y:190};
 assert.deepEqual(points[0], expectedStart);
 assert.deepEqual(points.at(-1), expectedEnd);
 for (let i=1;i<points.length;i++) assert.ok(sign * (points[i][axis] - points[i-1][axis]) >= 0, `close ${sourceSide}/${targetSide} route does not backtrack`);
}

// A hidden loop body becomes a self-edge; moving its header keeps body and
// return attached to separate bottom and left ports.
const loopNode: CanvasNode = {...node('loop', 0, 0), data: {flow: {...node('loop', 0, 0).data.flow, kind: 'loop', position: {x: 150, y: 120}}}};
const selfEdge: CanvasEdge = {id:'self',source:'loop',target:'loop',sourceHandle:'out-s',targetHandle:'in-w',data:{points:[{x:50,y:80},{x:-24,y:80},{x:-24,y:40},{x:0,y:40}],labelPosition:{x:-24,y:60},sourceOrigin:{x:0,y:0},targetOrigin:{x:0,y:0}}};
const selfPoints = positionedCanvas([loopNode], [selfEdge]).edges[0].data!.points;
assert.deepEqual(selfPoints[0], {x:200,y:200});
assert.deepEqual(selfPoints.at(-1), {x:150,y:160});
assert(selfPoints[1].x === 200 && selfPoints[1].y > 200, 'self-edge leaves bottom');
assert(selfPoints.at(-2)!.x < 150 && selfPoints.at(-2)!.y === 160, 'self-edge arrives from left');
