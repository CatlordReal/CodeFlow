import assert from 'node:assert/strict';
import { hideGraphNodes, presentGraph, presentLoopEdgeLabels, readProject, type Project } from '../src/presentation';
import type { FlowGraph } from '../src/types';
const graph: FlowGraph = {nodes:[{id:'n1',kind:'process',label:'x++',line:1,start_byte:0,end_byte:3,comments:['note']}],edges:[],diagnostics:[]};
const original = JSON.stringify(graph);
const shown = presentGraph(graph,'natural',false,{n1:{natural:'Increase x',annotation:'Count a visit'}},{n1:'AI caption'});
assert.equal(shown.nodes[0].label,'Increase x');
assert.equal(shown.nodes[0].annotation,'Count a visit');
assert.deepEqual(shown.nodes[0].comments,[]);
assert.equal(presentGraph(graph,'code',true,{n1:{natural:'Increase x'}}).nodes[0].label,'x++');
assert.equal(JSON.stringify(graph),original);
const loopGraph:FlowGraph={nodes:[
  {...graph.nodes[0],id:'loop',kind:'loop',loop_condition:'i < 3'},
  {...graph.nodes[0],id:'range',kind:'loop',label:'for (const auto& item : items)',loop_condition:null},
  {...graph.nodes[0],id:'forever',kind:'loop',label:'for (;;) ',loop_condition:null},
  {...graph.nodes[0],id:'end'},
],edges:[
  {id:'condition',source:'loop',target:'range',label:'Yes'},
  {id:'finished',source:'loop',target:'end',label:'No'},
  {id:'next',source:'range',target:'loop',label:'Yes'},
  {id:'range-finished',source:'range',target:'end',label:'No'},
  {id:'always',source:'forever',target:'loop',label:'Yes'},
  {id:'never',source:'forever',target:'end',label:'No'},
  {id:'repeat',source:'end',target:'loop',label:'Repeat'},
],diagnostics:[]};
const loopOriginal=JSON.stringify(loopGraph);
assert.deepEqual(presentLoopEdgeLabels(loopGraph).edges.map(edge=>edge.label),['i < 3','not (i < 3)','Next item','Finished','Always','Never','Repeat']);
assert.equal(JSON.stringify(loopGraph),loopOriginal,'loop labels must not mutate analyzer output');
const project: Project = {format:'codeflow',version:1,source:'int f() {return 1;}',labelSource:'int f() {return 1;}',fileName:'example.cpp',mode:'natural',edits:{'1:overview':{n1:{natural:'Increase x',annotation:'Count a visit'}}},captions:{},expandLoops:false,includeComments:false,loopDepth:0,loopOverrides:{},hiddenBoxes:{},showHiddenBoxes:false,functionPositions:{}};
assert.deepEqual(readProject(JSON.stringify(project)),project);
for(const invalid of [{...project,version:2},{...project,fileName:''},{...project,edits:[]},{...project,captions:{f:{n1:3}}},{...project,edits:{f:{n1:{annotation:'x'.repeat(2001)}}}}]) {
 assert.throws(()=>readProject(JSON.stringify(invalid)));
}
assert.throws(()=>readProject(JSON.stringify({...project,edits:JSON.parse('{"__proto__":{}}')})));
console.log('PASS: presentation keeps flow/source, mode-scoped edits, project round-trip and malformed project rejection');

const legacy={...project} as Partial<Project>;delete legacy.loopDepth;delete legacy.loopOverrides;
assert.equal(readProject(JSON.stringify({...legacy,expandLoops:true})).loopDepth,null);
assert.deepEqual(readProject(JSON.stringify(legacy)).loopOverrides,{});
assert.deepEqual(readProject(JSON.stringify({...project,loopDepth:2,loopOverrides:{f:{n1:true,n2:false}}})).loopOverrides,{f:{n1:true,n2:false}});
for(const loopDepth of [-1,1.5,101,'all'])assert.throws(()=>readProject(JSON.stringify({...project,loopDepth})));
assert.throws(()=>readProject(JSON.stringify({...project,loopOverrides:{f:{n1:'yes'}}})));
assert.throws(()=>readProject(JSON.stringify({...project,loopOverrides:JSON.parse('{"__proto__":{}}')})));

const pathGraph:FlowGraph={nodes:[{...graph.nodes[0],id:'start',kind:'start'},{...graph.nodes[0],id:'step'},{...graph.nodes[0],id:'end',kind:'return'}],edges:[{id:'a',source:'start',target:'step',label:''},{id:'b',source:'step',target:'end',label:''}],diagnostics:[]};
assert.deepEqual(hideGraphNodes(pathGraph,['step'],false).edges.map(e=>[e.source,e.target]),[['start','end']]);
assert.equal(hideGraphNodes(pathGraph,['step'],true).nodes.find(n=>n.id==='step')?.hidden,true);
assert.equal(hideGraphNodes(pathGraph,['start','end'],false).nodes.length,3);
assert.throws(()=>readProject(JSON.stringify({...project,hiddenBoxes:{f:[3]}})));
