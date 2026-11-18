import assert from 'node:assert/strict';
import { hideGraphNodes, presentGraph, presentLoopEdgeLabels, readProject, loopCaption, type Project } from '../src/presentation';
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
  {...graph.nodes[0],id:'loop',kind:'loop',label:'for (int i = 0; i < 3; i++)',loop_condition:'i < 3'},
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
assert.deepEqual(presentLoopEdgeLabels(loopGraph).edges.map(edge=>edge.label),['Running','Done','Running','Done','Running','Done','Repeat']);
const noLoopLabels=presentLoopEdgeLabels(loopGraph,false);
assert.deepEqual(noLoopLabels.edges.map(edge=>edge.label),['','','','','','','Repeat']);
assert.deepEqual(noLoopLabels.edges.map(({label,...edge})=>edge),loopGraph.edges.map(({label,...edge})=>edge),'hiding labels preserves edge structure');
assert.equal(JSON.stringify(loopGraph),loopOriginal,'loop labels must not mutate analyzer output');
const whileGraph:FlowGraph={...loopGraph,nodes:loopGraph.nodes.map(node=>node.id==='loop'?{...node,label:'ready',loop_condition:'ready'}:node)};
assert.deepEqual(presentLoopEdgeLabels(whileGraph).edges.slice(0,2).map(edge=>edge.label),['Running','Done'],'while/do condition labels use brief defaults');
const customLoops=presentGraph(whileGraph,'natural',false,{loop:{loopContinueLabel:'Process next item',loopExitLabel:'All done'}});
assert.deepEqual(presentLoopEdgeLabels(customLoops).edges.slice(0,2).map(edge=>edge.label),['Process next item','All done']);
assert.deepEqual(customLoops.edges,whileGraph.edges,'branch text edits must not change parser edge structure');
assert.deepEqual(presentLoopEdgeLabels(presentGraph(loopGraph,'code',false,{loop:{loopContinueLabel:'Again',loopExitLabel:'Stop'}})).edges.slice(0,2).map(edge=>edge.label),['Again','Stop'],'for loops accept independent branch overrides');
const blankBranch=presentLoopEdgeLabels(presentGraph(whileGraph,'code',false,{loop:{loopContinueLabel:''}}));
assert.equal(blankBranch.edges[0].label,'','explicit empty branch text remains a user edit');
for(const mode of ['code','natural'] as const){
  const updateOnly=presentGraph(graph,mode,false,{n1:{flaggedForUpdate:true}}).nodes[0];
  assert.equal(updateOnly.flaggedForUpdate,true);assert.equal(updateOnly.flagged,false,'update flag must not imply removal');
  const both=presentGraph(graph,mode,false,{n1:{flagged:true,flaggedForUpdate:true}}).nodes[0];
  assert.equal(both.flagged,true);assert.equal(both.flaggedForUpdate,true,'review flags remain independent');
  assert.equal(presentGraph(graph,mode,false).nodes[0].flaggedForUpdate,false,'legacy boxes are not flagged for update');
}
const project: Project = {format:'codeflow',version:1,source:'int f() {return 1;}',labelSource:'int f() {return 1;}',fileName:'example.cpp',language:'cpp',view:'function',mode:'natural',edits:{'1:overview':{n1:{natural:'Increase x',annotation:'Count a visit'}}},captions:{},expandLoops:false,includeComments:false,loopDepth:0,loopOverrides:{},hiddenBoxes:{},showHiddenBoxes:false,functionPositions:{}};
assert.deepEqual(readProject(JSON.stringify(project)),{...project,showLoopLabels:true});
assert.equal(readProject(JSON.stringify({...project,showLoopLabels:false})).showLoopLabels,false);
for(const showLoopLabels of [null,1,'false',{},[]]) assert.throws(()=>readProject(JSON.stringify({...project,showLoopLabels})));
const reviewEdits={position:{x:-123.5,y:987},flagged:true,flaggedForUpdate:true,loopContinueLabel:'Continue work',loopExitLabel:'Finished work'};
const reviewProject={...project,edits:{'1:overview':{n1:reviewEdits}}};
assert.deepEqual(readProject(JSON.stringify(reviewProject)).edits,reviewProject.edits,'all review metadata survives saved projects');
assert.deepEqual(presentGraph(graph,'natural',false,{n1:reviewEdits}).nodes[0].position,reviewEdits.position);
assert.equal(presentGraph(graph,'natural',false).nodes[0].position,undefined);
for(const position of [null,[],{}, {x:1}, {x:1,y:null}, {x:'1',y:2}, {x:10000001,y:0}, {x:0,y:-10000001}, {x:0,y:0,z:1}]) {
  assert.throws(()=>readProject(JSON.stringify({...project,edits:{f:{n1:{position}}}})),'invalid node position rejected');
}

assert.deepEqual(readProject(JSON.stringify({...project,edits:{f:{n1:{flagged:false,flaggedForUpdate:false}}}})).edits.f.n1,{flagged:false,flaggedForUpdate:false});
for(const field of ['flagged','flaggedForUpdate'])for(const invalid of ['true',1,null,{},[]])assert.throws(()=>readProject(JSON.stringify({...project,edits:{f:{n1:{[field]:invalid}}}})),`${field} must be boolean`);
for(const field of ['loopContinueLabel','loopExitLabel','trueLabel','falseLabel']){
  for(const invalid of [true,1,null,{},[],'x'.repeat(2001)])assert.throws(()=>readProject(JSON.stringify({...project,edits:{f:{n1:{[field]:invalid}}}})),`${field} must be a bounded string`);
  assert.equal(readProject(JSON.stringify({...project,edits:{f:{n1:{[field]:'x'.repeat(2000)}}}})).edits.f.n1[field as 'loopContinueLabel'|'loopExitLabel'|'trueLabel'|'falseLabel']?.length,2000);
}
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

const oldProject={...project};delete oldProject.language;delete oldProject.view;
assert.equal(readProject(JSON.stringify(oldProject)).language,'cpp');
assert.equal(readProject(JSON.stringify(oldProject)).view,'function');
const csProject={...project,language:'csharp',view:'program',fileName:'Program.cs'};
assert.deepEqual(readProject(JSON.stringify(csProject)),{...csProject,showLoopLabels:true});
for(const value of [{...project,language:'java'},{...project,view:'folder'}])assert.throws(()=>readProject(JSON.stringify(value)));
assert.equal(loopCaption('foreach (var item in values)'), 'For each item in values');
const csLoop={...loopGraph,nodes:[{...graph.nodes[0],id:'each',kind:'loop',label:'foreach (var item in values)',loop_condition:null}],edges:[{id:'next',source:'each',target:'body',label:'Yes'},{id:'done',source:'each',target:'end',label:'No'}]};
assert.deepEqual(presentLoopEdgeLabels(csLoop).edges.map(edge=>edge.label),['Running','Done']);

const hiddenLoopGraph: FlowGraph = {nodes:[
 {...graph.nodes[0],id:'entry',kind:'start',start_byte:0,end_byte:0},
 {...graph.nodes[0],id:'loop',kind:'loop',label:'while (ready)',start_byte:10,end_byte:50},
 {...graph.nodes[0],id:'body',kind:'process',start_byte:20,end_byte:30},
 {...graph.nodes[0],id:'exit',kind:'end',start_byte:60,end_byte:60},
],edges:[{id:'a',source:'entry',target:'loop',label:''},{id:'b',source:'loop',target:'body',label:'Yes'},
{id:'c',source:'body',target:'loop',label:'Repeat'},{id:'d',source:'loop',target:'exit',label:'No'}],diagnostics:[]};
const hiddenLoop=hideGraphNodes(hiddenLoopGraph,['loop'],false);
assert.deepEqual(hiddenLoop.edges.map(({source,target,label})=>[source,target,label]),[['entry','body',''],['entry','exit',''],['body','exit','']]);

// Hidden control boxes must not leave their source text or branch labels on bypass edges.
const nestedHidden:FlowGraph={nodes:[
 {...graph.nodes[0],id:'entry',kind:'start',start_byte:0,end_byte:0},
 {...graph.nodes[0],id:'outer',kind:'loop',label:'for (int i = 0; i < n; i++)',start_byte:10,end_byte:100},
 {...graph.nodes[0],id:'choice',kind:'decision',label:'secret_condition()',start_byte:20,end_byte:70},
 {...graph.nodes[0],id:'inner',kind:'loop',label:'while (private_condition())',start_byte:30,end_byte:60},
 {...graph.nodes[0],id:'body',kind:'process',start_byte:40,end_byte:50},
 {...graph.nodes[0],id:'exit',kind:'end',start_byte:110,end_byte:110},
],edges:[
 {id:'a',source:'entry',target:'outer',label:''},
 {id:'b',source:'outer',target:'choice',label:'Yes'},
 {id:'c',source:'outer',target:'exit',label:'No'},
 {id:'d',source:'choice',target:'inner',label:'Yes'},
 {id:'e',source:'choice',target:'outer',label:'No'},
 {id:'f',source:'inner',target:'body',label:'Yes'},
 {id:'g',source:'inner',target:'outer',label:'No'},
 {id:'h',source:'body',target:'inner',label:'Repeat'},
],diagnostics:[]};
const bypass=hideGraphNodes(nestedHidden,['choice','inner'],false);
assert(bypass.edges.every(edge=>!edge.label.includes('condition') && !edge.label.includes(' / ')));
const presentedBypass=presentLoopEdgeLabels(presentGraph(bypass,'code',false,{outer:{loopContinueLabel:'Keep going',loopExitLabel:'Finished'}}));
assert(presentedBypass.edges.some(edge=>edge.source==='outer' && edge.label==='Keep going'));
assert(presentedBypass.edges.some(edge=>edge.source==='outer' && edge.label==='Finished'));
assert(presentLoopEdgeLabels(presentGraph(bypass,'code',false,{outer:{loopContinueLabel:'Keep going'}}),false).edges.filter(edge=>edge.source==='outer').every(edge=>edge.label===''));
const decisionGraph:FlowGraph={nodes:[{...graph.nodes[0],id:'choice',kind:'decision'},{...graph.nodes[0],id:'yes'},{...graph.nodes[0],id:'no'}],edges:[{id:'yes',source:'choice',target:'yes',label:'Yes'},{id:'no',source:'choice',target:'no',label:'No'}],diagnostics:[]};
assert.deepEqual(presentLoopEdgeLabels(decisionGraph).edges.map(edge=>edge.label),['True','False']);
assert.deepEqual(presentLoopEdgeLabels(decisionGraph,false).edges.map(edge=>edge.label),['True','False']);
assert(hideGraphNodes(decisionGraph,['choice'],true).nodes.find(node=>node.id==='choice')?.hidden);

const customDecision=presentGraph(decisionGraph,'natural',false,{choice:{trueLabel:'Proceed',falseLabel:'   '}});
assert.deepEqual(presentLoopEdgeLabels(customDecision).edges.map(edge=>edge.label),['Proceed','   ']);
assert.deepEqual(presentLoopEdgeLabels(customDecision,false).edges.map(edge=>edge.label),['Proceed','   '],'loop label toggle does not hide decision labels');
const switchGraph={...decisionGraph,nodes:decisionGraph.nodes.map(node=>node.id==='choice'?{...node,kind:'switch'}:node)};
assert.deepEqual(presentLoopEdgeLabels(presentGraph(switchGraph,'code',false,{choice:{trueLabel:'Wrong'}})).edges.map(edge=>edge.label),['Yes','No']);
const decisionProject={...project,edits:{'f:detail':{choice:{trueLabel:'Proceed',falseLabel:'   '}}}};
assert.deepEqual(readProject(JSON.stringify(decisionProject)).edits,decisionProject.edits);
