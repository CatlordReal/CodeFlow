import parserLoopFixtures from './fixtures/outside-loop-edit.json';
import {simplifyGraph,overviewGraph,analyzeLoops} from '../src/simplify';
import assert from 'node:assert/strict';
import {defaultChartState} from '../src/history';
import {mapFunction,matchFunctions,remapChart} from '../src/preservation';
import {remapChartForLanguage} from '../src/preservation';
import type {FlowGraph,FlowNode} from '../src/types';
const node=(id:string,code:string,kind='process'):FlowNode=>({id,label:code,kind,line:1,start_byte:1,end_byte:2,comments:[],source_identity:code});
const graph=(nodes:FlowNode[]):FlowGraph=>({nodes,edges:[],diagnostics:[]});
const before=graph([node('a','x=1'),node('b','y=2')]);
const after=graph([node('c','x=1'),node('d','y=3')]);
const state=defaultChartState();
state.edits={'function:10:overview':{a:{position:{x:70,y:90},natural:'Set x',annotation:'Keep note',flagged:true,flaggedForUpdate:true,loopContinueLabel:'Keep going',loopExitLabel:'Done'},b:{natural:'Set y',flaggedForUpdate:true}}};
state.captions={'function:10:detail':{a:'Initialise x',b:'Initialise y'}};
state.hiddenBoxes={'function:10':['a']};state.functionPositions={'function:10':{x:90,y:100}};
const mapped=remapChart(state,[mapFunction('function:10','function:2',before,after)]);
assert.deepEqual(mapped.edits,{'function:2:overview':{c:{position:{x:70,y:90},natural:'Set x',annotation:'Keep note',flagged:true,flaggedForUpdate:true,loopContinueLabel:'Keep going',loopExitLabel:'Done'}}},'stable identities preserve flags and branch text; changed source discards stale metadata');
assert.deepEqual(mapped.captions,{'function:2:detail':{c:'Initialise x'}});
assert.deepEqual(mapped.hiddenBoxes,{'function:2':['c']});
assert.deepEqual(mapped.functionPositions,{'function:2':{x:90,y:100}});
assert.equal(state.edits['function:10:overview'].b.natural,'Set y');
const commentOnly=remapChart(state,[mapFunction('function:10','function:0',before,graph([node('n','x=1'),node('m','y=2')]))]);
assert.equal(commentOnly.edits['function:0:overview'].m.natural,'Set y');
assert.equal(matchFunctions([{id:'old',name:'sum',line:1,identity:'signature'}],[{id:'new',name:'sum',line:2,identity:'signature'}])[0][1].id,'new');
assert.equal(matchFunctions([{id:'old',name:'sum',line:1}],[{id:'new',name:'sum',line:2},{id:'overload',name:'sum',line:3}]).length,0);
const loopOld={...node('loop','old body','loop'),header_identity:'same condition'};
const loopNew={...node('newloop','changed body','loop'),header_identity:'same condition'};
const loopMap=mapFunction('old','new',graph([loopOld]),graph([loopNew]));
assert.equal(loopMap.detail.get('loop'),'newloop');assert.equal(loopMap.overview.has('loop'),false);
assert.equal(mapFunction('old','new',graph([node('a','same'),node('b','same')]),graph([node('c','same')])).detail.size,0);
assert.equal(mapFunction('old','new',graph([node('a','same'),node('b','same')]),graph([node('c','same'),node('d','same')])).detail.get('b'),'d','comment-only changes retain even repeated boxes when entire graph is unchanged');

const nestedLoops=(prefix:string,shift:number,innerIdentity='inner body'):FlowGraph=>{
  const ranged=(id:string,label:string,kind:string,start:number,end:number,sourceIdentity:string,headerIdentity?:string):FlowNode=>({
    id:`${prefix}-${id}`,label,kind,line:1,start_byte:start+shift,end_byte:end+shift,comments:[],source_identity:sourceIdentity,header_identity:headerIdentity,
  });
  const nodes=[
    ranged('start','Start','start',0,0,'start'),
    ranged('setup','int sum = 0','process',1,9,'setup'),
    ranged('outer','for (int value : values)','loop',10,100,'outer body','outer header'),
    ranged('inner','for (int repeat = 0; repeat < 2; repeat++)','loop',30,70,innerIdentity,'inner header'),
    ranged('body','sum += helper(value)','process',40,50,'sum body'),
    ranged('return','return sum','return',110,120,'return sum'),
    ranged('end','End','end',121,121,'end'),
  ];
  const id=(value:string)=>`${prefix}-${value}`;
  return {nodes,edges:[
    {id:id('e1'),source:id('start'),target:id('setup'),label:''},
    {id:id('e2'),source:id('setup'),target:id('outer'),label:''},
    {id:id('e3'),source:id('outer'),target:id('inner'),label:'Yes'},
    {id:id('e4'),source:id('outer'),target:id('return'),label:'No'},
    {id:id('e5'),source:id('inner'),target:id('body'),label:'Yes'},
    {id:id('e6'),source:id('inner'),target:id('outer'),label:'No'},
    {id:id('e7'),source:id('body'),target:id('inner'),label:'Repeat'},
    {id:id('e8'),source:id('return'),target:id('end'),label:''},
  ],diagnostics:[]};
};
const nestedBefore=nestedLoops('old',0);
const nestedAfter=nestedLoops('new',-21);
const nestedState=defaultChartState();
nestedState.edits={'old-function:overview':{
  'old-inner':{natural:'Sum values',annotation:'Keep nested-loop note'},
  'old-body':{natural:'Add repeated value'},
}};
nestedState.hiddenBoxes={'old-function':['old-inner','old-body']};
nestedState.loopOverrides={'old-function':{'old-inner':false}};
nestedState.edits['old-function:overview']['old-inner']={...nestedState.edits['old-function:overview']['old-inner'],code:'old code label',flagged:true,position:{x:10,y:20}};
const nestedMapped=remapChart(nestedState,[mapFunction('old-function','new-function',nestedBefore,nestedAfter)]);
assert.deepEqual(nestedMapped.edits,{'new-function:overview':{
  'new-inner':{natural:'Sum values',annotation:'Keep nested-loop note',code:'old code label',flagged:true,position:{x:10,y:20}},
  'new-body':{natural:'Add repeated value'},
}},'comment removal retains depth-1 collapsed loop and expanded-region process presentation');
assert.deepEqual(nestedMapped.hiddenBoxes,{'new-function':['new-inner','new-body']});
const changedNested=mapFunction('old-function','changed-function',nestedBefore,nestedLoops('changed',-21,'inner body changed'));
assert.equal(changedNested.overview.has('old-inner'),false,'collapsed loop body changes invalidate its presentation');
assert.equal(changedNested.detail.get('old-inner'),'changed-inner','expanded loop header presentation survives body-only changes');
const changedHidden=remapChart(nestedState,[changedNested]);
assert.deepEqual(changedHidden.hiddenBoxes,{'changed-function':['changed-inner','changed-body']},'hidden collapsed loop follows stable header');
assert.deepEqual(changedHidden.loopOverrides,{'changed-function':{'changed-inner':false}},'manual collapse survives body edits');
assert.deepEqual(changedHidden.edits['changed-function:overview']['changed-inner'],{annotation:'Keep nested-loop note',flagged:true,position:{x:10,y:20}},'structural metadata survives; captions tied to changed body are invalidated');
assert.equal(changedHidden.captions['changed-function:overview']?.['changed-inner'],undefined);
console.log('PASS: stable code retains labels, notes and layout; changed or ambiguous boxes invalidate only their edits');

// A return inside a loop makes collapsing unsafe; do not force a collapsed box.
const terminalGraph=nestedLoops('terminal',-21,'inner body changed');
terminalGraph.nodes=terminalGraph.nodes.map(item=>item.id==='terminal-body'?{...item,kind:'return'}:item);
const unsafeMapping=mapFunction('old-function','terminal-function',nestedBefore,terminalGraph);
assert.equal(unsafeMapping.collapsedLoops?.has('old-inner'),false);
assert.equal(remapChart(nestedState,[unsafeMapping]).hiddenBoxes['terminal-function']?.includes('terminal-inner')??false,false);

const multiLanguage=defaultChartState();
multiLanguage.edits={'cs:24:overview':{step:{natural:'Keep C# caption'}},'123:overview':{step:{natural:'Keep C++ caption'}}};
multiLanguage.captions={'cs:24:overview':{step:'C# AI label'},'123:overview':{step:'C++ AI label'}};
multiLanguage.loopOverrides={'cs:24':{loop:true},'123':{loop:false}};
multiLanguage.hiddenBoxes={'cs:24':['step'],'123':['step']};
multiLanguage.functionPositions={'cs:24':{x:120,y:340},'123':{x:420,y:30}};
for(const language of ['cpp','csharp'] as const){
 const kept=language==='cpp'?'cs:24':'123';
 const mapped=remapChartForLanguage(multiLanguage,[],language);
 for(const field of ['loopOverrides','hiddenBoxes','functionPositions'] as const)assert.deepEqual(mapped[field][kept],multiLanguage[field][kept]);
 for(const field of ['edits','captions'] as const)assert.deepEqual(mapped[field][kept+':overview'],multiLanguage[field][kept+':overview']);
 assert.equal(Object.keys(mapped.edits).length,1,'removed active-language functions must still invalidate their edits');
}

// Source transitions must not rewrite the only copy of earlier revision records.
const { appendRevision, initialHistory } = await import('../src/history');
const { restoreArchivedHistory } = await import('../src/preservation');
const loopSource = 'void f(){ for (;;) { work(); } keep(); }';
const commentedSource = 'void f(){ /* for (;;) { work(); } */ keep(); }';
const loopGraph = graph([node('loop','for (;;) { work(); }','loop'),node('work','work()'),node('keep','keep()')]);
const commentGraph = graph([node('keep-new','keep()')]);
const loopState = defaultChartState();
loopState.edits = {'f:overview':{loop:{annotation:'Loop note'},work:{natural:'Work caption'},keep:{natural:'Keep caption'}}};
const oldHistory = appendRevision(initialHistory(loopState), {...loopState,edits:{'f:overview':{...loopState.edits['f:overview'],loop:{annotation:'Revised loop note'}}}}, 'Edit note');
const commentedHistory = {...oldHistory,revisions:oldHistory.revisions.map(revision=>({...revision,state:remapChart(revision.state,[mapFunction('f','f',loopGraph,commentGraph)])}))};
assert.equal(commentedHistory.revisions[1].state.edits['f:overview']['keep-new'].natural, 'Keep caption');
assert.equal(commentedHistory.revisions[1].state.edits['f:overview'].loop, undefined, 'removed loop note does not attach to changed code');
const archive = {source:loopSource,language:'cpp' as const,history:oldHistory};
assert.equal(restoreArchivedHistory(commentedHistory,archive,commentedSource,'cpp'),commentedHistory, 'archive is not attached to different source');
const returned = {...commentedHistory,revisions:commentedHistory.revisions.map(revision=>({...revision,state:remapChart(revision.state,[mapFunction('f','f',commentGraph,loopGraph)])}))};
const restored = restoreArchivedHistory(returned,archive,loopSource,'cpp');
assert.equal(restored.revisions[0].state.edits['f:overview'].loop.annotation,'Loop note');
assert.equal(restored.revisions[1].state.edits['f:overview'].loop.annotation,'Revised loop note');
assert.equal(restored.revisions[1].state.edits['f:overview'].keep.natural,'Keep caption');
assert.equal(restoreArchivedHistory(returned,archive,loopSource,'csharp'),returned, 'archive is language scoped');
assert.equal(oldHistory.revisions[1].state.edits['f:overview'].loop.annotation,'Revised loop note', 'archived history remains unchanged');

const { readProject } = await import('../src/presentation');
const persistedProject = {format:'codeflow',version:1,source:commentedSource,fileName:'test.cpp',...commentedHistory.revisions[1].state,history:commentedHistory,sourceHistory:[archive]};
const reopened = readProject(JSON.stringify(persistedProject));
assert.deepEqual(reopened.sourceHistory?.[0].history, {...oldHistory,revisions:oldHistory.revisions.map(revision=>({...revision,state:{...revision.state,source:loopSource,labelSource:loopSource,language:'cpp'}}))}, 'source history survives save and reopen');
const restoredAfterOpen = restoreArchivedHistory(returned,reopened.sourceHistory![0],loopSource,'cpp');
assert.equal(restoredAfterOpen.revisions[1].state.edits['f:overview'].loop.annotation,'Revised loop note');
for (const sourceHistory of [null, {}, Array(11).fill(archive), [{...archive, source:'é'.repeat(1048577)}], [{...archive,language:'python'}], [{...archive,history:{...oldHistory,active:'missing'}}], [{...archive,history:{...oldHistory,revisions:[{...oldHistory.revisions[0],state:{...loopState,edits:{f:{n:{annotation:5}}}}}]}}]]) {
  assert.throws(()=>readProject(JSON.stringify({...persistedProject,sourceHistory})), 'invalid archive is rejected');
}

const { retainSourceHistory } = await import('../src/preservation');
const latestArchive = {source:'// latest café',language:'cpp' as const,history:archive.history};
const archiveProject = {...reopened,sourceHistory:[archive,latestArchive]};
const retained = retainSourceHistory(archiveProject,latestArchive);
assert.equal(retained.archives[0],latestArchive,'latest snapshot is always first');
assert.equal(retained.archives.filter(item=>item.source===latestArchive.source).length,1,'exact duplicate is removed');
assert.equal(retained.trimmed,0);
const largeOld = {...archive,source:'é'.repeat(8 * 1024 * 1024)};
const trimmed = retainSourceHistory({...archiveProject,sourceHistory:[largeOld,archive]},latestArchive);
assert.equal(trimmed.trimmed,1,'oversized old snapshot is reported');
assert.deepEqual(trimmed.archives,[latestArchive,archive],'smaller older snapshot remains');
assert.throws(()=>retainSourceHistory(archiveProject,{...latestArchive,source:'é'.repeat(8 * 1024 * 1024)}),/Cannot preserve this source change safely/,'latest snapshot must never be discarded');
const many = Array.from({length:11},(_,index)=>({...archive,source:`// ${index}`}));
const limited = retainSourceHistory({...archiveProject,sourceHistory:many},latestArchive);
assert.equal(limited.archives.length,10);
assert.equal(limited.trimmed,2,'ten-snapshot limit reports evictions');

// Returning to a source must restore hidden boxes lost in an intermediate parse,
// even when another hidden box survived and was mapped back.
const hiddenOriginal = defaultChartState();
hiddenOriginal.hiddenBoxes = { f: ['loop', 'keep'] };
const hiddenHistory = initialHistory(hiddenOriginal);
const hiddenIntermediate = { ...hiddenHistory, revisions: hiddenHistory.revisions.map(revision => ({
  ...revision, state: remapChart(revision.state, [mapFunction('f', 'f', loopGraph, commentGraph)]),
})) };
const hiddenReturned = { ...hiddenIntermediate, revisions: hiddenIntermediate.revisions.map(revision => ({
  ...revision, state: remapChart(revision.state, [mapFunction('f', 'f', commentGraph, loopGraph)]),
})) };
const hiddenRestored = restoreArchivedHistory(hiddenReturned, {source: loopSource, language: 'cpp', history: hiddenHistory}, loopSource, 'cpp');
assert.deepEqual(hiddenRestored.revisions[0].state.hiddenBoxes.f, ['loop', 'keep']);

// Real native C++ parser output: the changed statement is outside the loop.
// Sources: int f(int n){for(int i=0;i<n;i++){n+=i;break;} cout<<n; return n;}
//          int f(int n){for(int i=0;i<n;i++){n+=i;break;} n+=1; return n;}
const [parserBefore,parserAfter]=parserLoopFixtures.map(item=>simplifyGraph(item as FlowGraph));
for(const parsed of [parserBefore,parserAfter]){
 const loop=parsed.nodes.find(item=>item.kind==='loop')!;
 assert.equal(analyzeLoops(parsed).find(item=>item.id===loop.id)?.can_collapse,true);
 assert.equal(overviewGraph(parsed).nodes.find(item=>item.id===loop.id)?.loop_collapsed,true);
 assert(!parsed.nodes.some(item=>item.kind==='process'&&item.start_byte<loop.end_byte&&item.end_byte>loop.end_byte),'no process crosses loop boundary');
}
const parserOldLoop=parserBefore.nodes.find(item=>item.kind==='loop')!;
const parserNewLoop=parserAfter.nodes.find(item=>item.kind==='loop')!;
const parserState=defaultChartState();
parserState.loopOverrides={f:{[parserOldLoop.id]:false}};
parserState.hiddenBoxes={f:[parserOldLoop.id]};
parserState.edits={'f:overview':{[parserOldLoop.id]:{natural:'Loop caption',flagged:true}}};
const parserMapping=mapFunction('f','f',parserBefore,parserAfter);
const parserRemapped=remapChart(parserState,[parserMapping]);
assert.equal(parserRemapped.loopOverrides.f[parserNewLoop.id],false);
assert.deepEqual(parserRemapped.hiddenBoxes.f,[parserNewLoop.id]);
assert.deepEqual(parserRemapped.edits['f:overview'][parserNewLoop.id],{natural:'Loop caption',flagged:true});

// Repeated headers retain distinct loops when their bodies uniquely identify them.
const repeatedBefore=graph([{...loopOld,id:'one',source_identity:'body one'}, {...loopOld,id:'two',source_identity:'body two'},node('outside','old')]);
const repeatedAfter=graph([{...loopNew,id:'new-one',source_identity:'body one'}, {...loopNew,id:'new-two',source_identity:'body two'},node('new-outside','changed')]);
const repeated=mapFunction('old','new',repeatedBefore,repeatedAfter);
assert.equal(repeated.loops.get('one'),'new-one');
assert.equal(repeated.loops.get('two'),'new-two');
const repeatedState=defaultChartState();repeatedState.loopOverrides={old:{one:false,two:true}};
assert.deepEqual(remapChart(repeatedState,[repeated]).loopOverrides,{new:{'new-one':false,'new-two':true}});
const ambiguousAfter=graph([{...loopNew,id:'a',source_identity:'body one'}, {...loopNew,id:'b',source_identity:'body one'},node('new-outside','changed')]);
assert.equal(mapFunction('old','new',repeatedBefore,ambiguousAfter).loops.size,0,'ambiguous repeated bodies remain unmapped');
