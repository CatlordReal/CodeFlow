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
const migratedHistory=(h:typeof history,source:string)=>({...h,revisions:h.revisions.map(revision=>({...revision,state:{...revision.state,source,labelSource:source,language:'cpp'}}))});
assert.deepEqual(readProject(JSON.stringify(project)).history,migratedHistory(history,project.source));
const flaggedState={...defaultChartState(),edits:{'f:detail':{loop:{position:{x:12,y:-4},flagged:true,flaggedForUpdate:true,loopContinueLabel:'Continue',loopExitLabel:'Ended'}}}};
const flaggedHistory=appendRevision(initialHistory(defaultChartState()),flaggedState,'Flag and label loop');
const flaggedProject={...project,...flaggedState,history:flaggedHistory};
assert.deepEqual(readProject(JSON.stringify(flaggedProject)).history,migratedHistory(flaggedHistory,project.source),'review metadata survives saved revision history');
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

class FakeElement { constructor(private editable:boolean,private chart=false) {} closest(selector:string){return (selector==='[data-chart-history], [data-document-history]'?this.chart:this.editable)?this:null;} }
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

// Source and chart edits share chronological revision navigation.
let combined=initialHistory({...defaultChartState(),source:'int f() {}',labelSource:'int f() {}',language:'cpp'});
combined=appendFieldsRevision(combined,{source:'int f() {} // note'},'Edit source');
combined=appendFieldsRevision(combined,{hiddenBoxes:{f:['box']}},'Hide box');
combined=appendFieldsRevision(combined,{edits:{f:{box:{position:{x:1,y:2}}}}},'Move box');
const chain:string[]=[];let cursor:string|null=combined.active;
while(cursor){const revision=combined.revisions.find(item=>item.id===cursor)!;chain.push(revision.name);cursor=revision.parent;}
assert.deepEqual(chain,['Move box','Hide box','Edit source','Initial']);
const combinedProject={...project,source:'int f() {} // note',history:combined};
assert.deepEqual(readProject(JSON.stringify(combinedProject)).history,combined);
for(const field of ['source','labelSource','language'])for(const invalid of [null,5,field==='language'?'python':'é'.repeat(1048577)]){
 const malformed=structuredClone(combinedProject) as any;malformed.history.revisions[0].state[field]=invalid;
 assert.throws(()=>readProject(JSON.stringify(malformed)));
}
let budget=initialHistory({...defaultChartState(),source:'a'.repeat(1024*1024)});
for(let i=0;i<12;i++)budget=appendRevision(budget,{...defaultChartState(),source:String(i)+'x'.repeat(1024*1024)},'Source');
assert(new TextEncoder().encode(JSON.stringify(budget)).length<=8*1024*1024);
assert.equal(budget.revisions.at(-1)!.id,budget.active);
assert(budget.revisions.every(revision=>revision.parent===null||budget.revisions.some(parent=>parent.id===revision.parent)));

// Revisions reference shared source text on disk, including legacy histories.
const {serializeProject}=await import('../src/projectSerialization');
const {boundHistory}=await import('../src/history');
const shared='x'.repeat(2*1024*1024);
const legacyRevisions=Array.from({length:500},(_,i)=>({id:`revision-${i}`,parent:i?`revision-${i-1}`:null,name:'Change',state:defaultChartState()}));
const legacyLarge={...project,source:shared,labelSource:shared,history:{active:'revision-499',next:500,revisions:legacyRevisions}};
const migratedLarge=readProject(JSON.stringify(legacyLarge));
const packed=serializeProject(migratedLarge);
assert(new TextEncoder().encode(packed).length<7*1024*1024);
const unpacked=readProject(packed);
assert.equal(unpacked.history!.revisions.length,500);
assert(unpacked.history!.revisions.every(revision=>revision.state.source===shared && revision.state.labelSource===shared));
const raw=JSON.parse(packed);
for(const invalid of [null,{},[4],['é'.repeat(1048577)]])assert.throws(()=>readProject(JSON.stringify({...raw,historySources:invalid})));
for(const invalid of [-1,1,0.5,'0',null]){const value=structuredClone(raw);value.history.revisions[0].state.sourceRef=invalid;assert.throws(()=>readProject(JSON.stringify(value)));}
const duplicate=structuredClone(raw);duplicate.history.revisions[0].state.source='duplicate';assert.throws(()=>readProject(JSON.stringify(duplicate)));
const oversized=initialHistory({...defaultChartState(),edits:{f:{box:{annotation:'x'.repeat(9*1024*1024)}}}});
assert.throws(()=>boundHistory(oversized),/Chart history exceeds 8 MiB/);

// StrictMode may call the reducer twice with exactly the same state and action.
const {initialHistoryOwner,historyReducer}=await import('../src/history');
let owner=initialHistoryOwner({...defaultChartState(),source:'before',labelSource:'before',language:'cpp'});
owner=historyReducer(owner,{type:'change',field:'hiddenBoxes',value:{f:['box']},name:'Hide box',time:1000});
const beforeSource=structuredClone(owner);
const firstSource={type:'change' as const,field:'source' as const,value:'after',name:'Edit source',group:'source',time:1100};
const replayOne=historyReducer(owner,firstSource),replayTwo=historyReducer(owner,firstSource);
assert.deepEqual(replayOne,replayTwo,'replay from same state is deterministic');
assert.deepEqual(owner,beforeSource,'reducer does not mutate input');
owner=replayOne;
assert.equal(owner.history.revisions.length,3,'source edit follows separate hide revision');
owner=historyReducer(owner,{...firstSource,value:'after more',time:1150});
assert.equal(owner.history.revisions.length,3,'source typing coalesces');
owner=historyReducer(owner,{type:'change',field:'edits',value:{f:{box:{position:{x:1,y:2}}}},name:'Move box',time:1200});
assert.equal(owner.history.revisions.length,4);
owner=historyReducer(owner,{type:'navigate',direction:'undo'});
assert.equal(owner.history.revisions.find(r=>r.id===owner.history.active)!.state.source,'after more');
assert.deepEqual(owner.history.revisions.find(r=>r.id===owner.history.active)!.state.hiddenBoxes,{f:['box']});
owner=historyReducer(owner,{type:'navigate',direction:'undo'});
assert.equal(owner.history.revisions.find(r=>r.id===owner.history.active)!.state.source,'before');
assert.deepEqual(owner.history.revisions.find(r=>r.id===owner.history.active)!.state.hiddenBoxes,{f:['box']});
owner=historyReducer(owner,{type:'navigate',direction:'undo'});
assert.deepEqual(owner.history.revisions.find(r=>r.id===owner.history.active)!.state.hiddenBoxes,{});
const badAction={type:'change' as const,field:'edits' as const,value:{f:{box:{annotation:'x'.repeat(9*1024*1024)}}},name:'Too large',time:2000};
const failed=historyReducer(owner,badAction);
assert.equal(failed.history,owner.history,'oversized action leaves history untouched');
assert.match(failed.error!,/Chart history exceeds 8 MiB/);
assert.equal(historyReducer(failed,{type:'clearError'}).error,null);
