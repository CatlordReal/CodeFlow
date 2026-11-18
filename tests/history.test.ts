import assert from 'node:assert/strict';
import {appendRevision,defaultChartState,initialHistory,historyTarget,historyShortcut,appendFieldsRevision} from '../src/history';
import type {ChartState} from '../src/history';
import {readProject} from '../src/presentation';
let history=initialHistory(defaultChartState());
history=appendRevision(history,{...defaultChartState(),mode:'code'},'Code');
const codeId=history.active;
history={...history,active:'revision-0'};
history=appendRevision(history,{...defaultChartState(),showHiddenBoxes:true},'Alternate');
assert.equal(history.revisions[2].parent,'revision-0');assert.equal(history.revisions[1].id,codeId);
const project={format:'codeflow',version:1,source:'int sum(){return 1;}',fileName:'sum.cpp',...history.revisions[2].state,history};
assert.deepEqual(readProject(JSON.stringify(project)).history,history);
const flaggedState={...defaultChartState(),edits:{'f:detail':{loop:{position:{x:12,y:-4},flagged:true,flaggedForUpdate:true,loopContinueLabel:'Continue',loopExitLabel:'Ended'}}}};
const flaggedHistory=appendRevision(initialHistory(defaultChartState()),flaggedState,'Flag and label loop');
const flaggedProject={...project,...flaggedState,history:flaggedHistory};
assert.deepEqual(readProject(JSON.stringify(flaggedProject)).history,flaggedHistory,'review metadata survives saved revision history');
for(const edits of [{loop:{position:{x:0,y:10000001}}},{loop:{flaggedForUpdate:'yes'}},{loop:{loopExitLabel:42}},{loop:{loopContinueLabel:'x'.repeat(2001)}}]){
  const invalidHistory=structuredClone(flaggedHistory) as unknown as {revisions:{state:{edits:unknown}}[]};
  invalidHistory.revisions[1].state.edits={'f:detail':edits};
  assert.throws(()=>readProject(JSON.stringify({...flaggedProject,history:invalidHistory})),'revision metadata uses the same validation as current edits');
}
assert.throws(()=>readProject(JSON.stringify({...project,history:{...history,active:'missing'}})));
assert.throws(()=>readProject(JSON.stringify({...project,history:{...history,revisions:[history.revisions[2]]}})));
for(let i=0;i<501;i++)history=appendRevision(history,defaultChartState(),'Change');
assert.equal(history.revisions.length,500);
const ids=new Set(history.revisions.map(r=>r.id));assert.ok(history.revisions.every(r=>!r.parent||ids.has(r.parent)));
console.log('PASS: branching history survives saves and bounds retained revisions');

// Moving a box is a normal chart revision and can be navigated in both directions.
const movedState={...defaultChartState(),edits:{'f:detail':{box:{position:{x:120,y:80}}}}};
let movements=appendRevision(initialHistory(defaultChartState()),movedState,'Move box');
const movedId=movements.active;
assert.equal(historyTarget(movements,'undo'),'revision-0');
movements={...movements,active:'revision-0'};
assert.equal(historyTarget(movements,'redo'),movedId);
movements=appendRevision(movements,{...defaultChartState(),mode:'code'},'New branch');
const alternateId=movements.active;
movements={...movements,active:'revision-0'};
assert.equal(historyTarget(movements,'redo'),alternateId,'newest branch is default redo');
assert.equal(historyTarget(movements,'redo',{'revision-0':movedId}),movedId,'redo follows the branch just undone');
assert.equal(historyTarget({...movements,active:movedId},'redo'),null);

class FakeElement { constructor(private editable:boolean,private chart=false) {} closest(selector:string){return (selector==='[data-chart-history]'?this.chart:this.editable)?this:null;} }
Object.assign(globalThis,{Element:FakeElement});
const shortcut=(key:string,options:Partial<KeyboardEvent>={},editable=false,chart=false)=>historyShortcut({key,metaKey:false,ctrlKey:false,altKey:false,shiftKey:false,...options},new FakeElement(editable,chart) as unknown as EventTarget);
assert.equal(shortcut('z',{metaKey:true}),'undo');
assert.equal(shortcut('Z',{metaKey:true,shiftKey:true}),'redo');
assert.equal(shortcut('y',{metaKey:true}),'redo');
assert.equal(shortcut('z',{ctrlKey:true}),'undo');
assert.equal(shortcut('Z',{ctrlKey:true,shiftKey:true}),'redo');
assert.equal(shortcut('y',{ctrlKey:true}),'redo');
assert.equal(shortcut('z',{metaKey:true},true),null,'source editor retains native undo');
assert.equal(shortcut('z',{metaKey:true},true,true),'undo','chart text uses shared history');
assert.equal(shortcut('y',{metaKey:true},true,true),'redo','chart text redo uses shared history');
assert.equal(shortcut('z',{metaKey:true,altKey:true}),null);
console.log('PASS: movement revisions, branching redo, and platform shortcuts');

const expanded={...defaultChartState(),loopDepth:1,loopOverrides:{f:{loop:true}}} as ChartState;
const beforeDepth=initialHistory(expanded);
const afterDepth=appendFieldsRevision(beforeDepth,{loopDepth:0,loopOverrides:{}},'Loop depth');
assert.equal(afterDepth.revisions.length,2,'loop depth and override reset make one revision');
assert.deepEqual(afterDepth.revisions.find(revision=>revision.id===historyTarget(afterDepth,'undo'))?.state,expanded);
assert.equal(appendFieldsRevision(afterDepth,{loopDepth:0,loopOverrides:{}},'Loop depth'),afterDepth,'unchanged settings do not create a revision');

// Older saved histories inherit the project's diagram toggles; explicit new revisions keep theirs.
const legacyProject=JSON.parse(JSON.stringify(project));
legacyProject.includeComments=true;legacyProject.showLoopLabels=false;
for(const revision of legacyProject.history.revisions){delete revision.state.includeComments;delete revision.state.showLoopLabels;}
legacyProject.sourceHistory=[{source:'old code',language:'cpp',history:structuredClone(legacyProject.history)}];
const migrated=readProject(JSON.stringify(legacyProject));
for(const saved of [migrated.history!,migrated.sourceHistory![0].history]){
 assert.ok(saved.revisions.every(revision=>revision.state.includeComments===true&&revision.state.showLoopLabels===false));
}
const explicit=structuredClone(legacyProject);explicit.history.revisions[0].state.includeComments=false;explicit.history.revisions[0].state.showLoopLabels=true;
assert.equal(readProject(JSON.stringify(explicit)).history!.revisions[0].state.includeComments,false);
assert.equal(readProject(JSON.stringify(explicit)).history!.revisions[0].state.showLoopLabels,true);
for(const field of ['includeComments','showLoopLabels'])for(const invalid of [null,'false',0]){
 const malformed=structuredClone(legacyProject);malformed.history.revisions[0].state[field]=invalid;
 assert.throws(()=>readProject(JSON.stringify(malformed)),`invalid historical ${field} rejected`);
}
console.log('PASS: legacy diagram toggles migrate without losing history or accepting malformed values');
