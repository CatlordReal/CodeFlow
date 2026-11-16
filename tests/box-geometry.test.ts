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
