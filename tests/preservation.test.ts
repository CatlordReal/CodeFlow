import assert from 'node:assert/strict';
import {defaultChartState} from '../src/history';
import {mapFunction,matchFunctions,remapChart} from '../src/preservation';
import type {FlowGraph,FlowNode} from '../src/types';
const node=(id:string,code:string,kind='process'):FlowNode=>({id,label:code,kind,line:1,start_byte:1,end_byte:2,comments:[],source_identity:code});
const graph=(nodes:FlowNode[]):FlowGraph=>({nodes,edges:[],diagnostics:[]});
const before=graph([node('a','x=1'),node('b','y=2')]);
const after=graph([node('c','x=1'),node('d','y=3')]);
const state=defaultChartState();
state.edits={'function:10:overview':{a:{natural:'Set x',annotation:'Keep note'},b:{natural:'Set y'}}};
state.captions={'function:10:detail':{a:'Initialise x',b:'Initialise y'}};
state.hiddenBoxes={'function:10':['a']};state.functionPositions={'function:10':{x:90,y:100}};
const mapped=remapChart(state,[mapFunction('function:10','function:2',before,after)]);
assert.deepEqual(mapped.edits,{'function:2:overview':{c:{natural:'Set x',annotation:'Keep note'}}});
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
const nestedMapped=remapChart(nestedState,[mapFunction('old-function','new-function',nestedBefore,nestedAfter)]);
assert.deepEqual(nestedMapped.edits,{'new-function:overview':{
  'new-inner':{natural:'Sum values',annotation:'Keep nested-loop note'},
  'new-body':{natural:'Add repeated value'},
}},'comment removal retains depth-1 collapsed loop and expanded-region process presentation');
assert.deepEqual(nestedMapped.hiddenBoxes,{'new-function':['new-inner','new-body']});
const changedNested=mapFunction('old-function','changed-function',nestedBefore,nestedLoops('changed',-21,'inner body changed'));
assert.equal(changedNested.overview.has('old-inner'),false,'collapsed loop body changes invalidate its presentation');
assert.equal(changedNested.detail.get('old-inner'),'changed-inner','expanded loop header presentation survives body-only changes');
const changedHidden=remapChart(nestedState,[changedNested]);
assert.deepEqual(changedHidden.hiddenBoxes,{'changed-function':['changed-body']},'hidden collapsed loop does not transfer through header identity after its body changes');
console.log('PASS: stable code retains labels, notes and layout; changed or ambiguous boxes invalidate only their edits');
