import assert from 'node:assert/strict';
import { presentGraph, readProject, type Project } from '../src/presentation';
import type { FlowGraph } from '../src/types';
const graph: FlowGraph = {nodes:[{id:'n1',kind:'process',label:'x++',line:1,start_byte:0,end_byte:3,comments:['note']}],edges:[],diagnostics:[]};
const original = JSON.stringify(graph);
const shown = presentGraph(graph,'natural',false,{n1:{natural:'Increase x',annotation:'Count a visit'}},{n1:'AI caption'});
assert.equal(shown.nodes[0].label,'Increase x');
assert.equal(shown.nodes[0].annotation,'Count a visit');
assert.deepEqual(shown.nodes[0].comments,[]);
assert.equal(presentGraph(graph,'code',true,{n1:{natural:'Increase x'}}).nodes[0].label,'x++');
assert.equal(JSON.stringify(graph),original);
const project: Project = {format:'codeflow',version:1,source:'int f() {return 1;}',fileName:'example.cpp',mode:'natural',edits:{'1:overview':{n1:{natural:'Increase x',annotation:'Count a visit'}}},captions:{},expandLoops:false,includeComments:false};
assert.deepEqual(readProject(JSON.stringify(project)),project);
for(const invalid of [{...project,version:2},{...project,fileName:''},{...project,edits:[]},{...project,captions:{f:{n1:3}}},{...project,edits:{f:{n1:{annotation:'x'.repeat(2001)}}}}]) {
 assert.throws(()=>readProject(JSON.stringify(invalid)));
}
assert.throws(()=>readProject(JSON.stringify({...project,edits:JSON.parse('{"__proto__":{}}')})));
console.log('PASS: presentation keeps flow/source, mode-scoped edits, project round-trip and malformed project rejection');
