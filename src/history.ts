import {useCallback,useRef,useState} from 'react';
import type {ChartEdits,CaptionSets,LoopOverrides} from './presentation';
export type ChartState={mode:'code'|'natural';edits:ChartEdits;captions:CaptionSets;loopDepth:number|null;loopOverrides:LoopOverrides;hiddenBoxes:Record<string,string[]>;showHiddenBoxes:boolean;includeComments:boolean;showLoopLabels:boolean;functionPositions:Record<string,{x:number;y:number}>};
export type Revision={id:string;parent:string|null;name:string;state:ChartState};
export type ChartHistory={active:string;next:number;revisions:Revision[]};
export const defaultChartState=():ChartState=>({mode:'natural',edits:{},captions:{},loopDepth:0,loopOverrides:{},hiddenBoxes:{},showHiddenBoxes:false,includeComments:false,showLoopLabels:true,functionPositions:{}});
export const initialHistory=(state:ChartState):ChartHistory=>({active:'revision-0',next:1,revisions:[{id:'revision-0',parent:null,name:'Initial',state}]});
export function appendRevision(history:ChartHistory,state:ChartState,name:string):ChartHistory{
 const id=`revision-${history.next}`;let revisions=[...history.revisions,{id,parent:history.active,name,state}];
 if(revisions.length>500){revisions=revisions.slice(-500);const ids=new Set(revisions.map(r=>r.id));revisions=revisions.map(r=>({...r,parent:r.parent&&ids.has(r.parent)?r.parent:null}));}
 return {active:id,next:history.next+1,revisions};
}
export function appendFieldsRevision(history:ChartHistory,fields:Partial<ChartState>,name:string):ChartHistory{
 const revision=history.revisions.find(r=>r.id===history.active)!;
 const state={...revision.state,...fields};
 return JSON.stringify(state)===JSON.stringify(revision.state)?history:appendRevision(history,state,name);
}
export function historyTarget(history:ChartHistory,direction:'undo'|'redo',preferred:Record<string,string>={}):string|null{
 const active=history.revisions.find(revision=>revision.id===history.active);
 if(!active)return null;
 if(direction==='undo')return active.parent;
 const children=history.revisions.filter(revision=>revision.parent===active.id);
 return children.find(revision=>revision.id===preferred[active.id])?.id ?? children.at(-1)?.id ?? null;
}
export function historyShortcut(event:Pick<KeyboardEvent,'key'|'metaKey'|'ctrlKey'|'altKey'|'shiftKey'>,target:EventTarget|null):'undo'|'redo'|null{
 if(!(event.metaKey||event.ctrlKey)||event.altKey)return null;
 const element=target instanceof Element?target:null;
 if(!element?.closest('[data-chart-history]') && element?.closest('textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], input[type="number"], [contenteditable]:not([contenteditable="false"])'))return null;
 const key=event.key.toLowerCase();
 if(key==='z')return event.shiftKey?'redo':'undo';
 if(key==='y'&&!event.shiftKey)return 'redo';
 return null;
}
export function useChartHistory(){
 const [history,setHistory]=useState(()=>initialHistory(defaultChartState()));
 const active=history.revisions.find(r=>r.id===history.active)!;
 const preferred=useRef<Record<string,string>>({});
 const grouping=useRef<{key:string;time:number}|null>(null);
 const change=useCallback(<K extends keyof ChartState>(field:K,value:ChartState[K]|((previous:ChartState[K])=>ChartState[K]),name:string,group?:string)=>{
  setHistory(current=>{const revision=current.revisions.find(r=>r.id===current.active)!;const next=typeof value==='function'?(value as (v:ChartState[K])=>ChartState[K])(revision.state[field]):value;
   if(JSON.stringify(next)===JSON.stringify(revision.state[field]))return current;
   const state={...revision.state,[field]:next};const now=Date.now();const coalesce=group&&grouping.current?.key===group&&now-grouping.current.time<800&&!current.revisions.some(r=>r.parent===revision.id)&&revision.parent!==null;
   grouping.current=group?{key:group,time:now}:null;
   return coalesce?{...current,revisions:current.revisions.map(r=>r.id===revision.id?{...r,state}:r)}:appendRevision(current,state,name);
  });
 },[]);
 const changeFields=useCallback((fields:Partial<ChartState>,name:string)=>{grouping.current=null;setHistory(current=>appendFieldsRevision(current,fields,name));},[]);
 const select=useCallback((id:string)=>{grouping.current=null;setHistory(current=>current.revisions.some(r=>r.id===id)?{...current,active:id}:current);},[]);
 const navigate=useCallback((direction:'undo'|'redo')=>{grouping.current=null;setHistory(current=>{const target=historyTarget(current,direction,preferred.current);if(!target)return current;if(direction==='undo')preferred.current[target]=current.active;return {...current,active:target};});},[]);
 const reset=useCallback(()=>{grouping.current=null;setHistory(current=>{const state=current.revisions.find(revision=>revision.id===current.active)!.state;return appendRevision(current,{...defaultChartState(),includeComments:state.includeComments,showLoopLabels:state.showLoopLabels},'Reset');});},[]);
 const alternate=useCallback(()=>{grouping.current=null;setHistory(current=>appendRevision(current,current.revisions.find(r=>r.id===current.active)!.state,'Alternate'));},[]);
 const load=useCallback((state:ChartState,saved?:ChartHistory)=>{grouping.current=null;preferred.current={};setHistory(saved??initialHistory(state));},[]);
 const remap=useCallback((transform:(state:ChartState)=>ChartState)=>{grouping.current=null;setHistory(current=>({...current,revisions:current.revisions.map(revision=>({...revision,state:transform(revision.state)}))}));},[]);
 const transformHistory=useCallback((transform:(history:ChartHistory)=>ChartHistory)=>{grouping.current=null;setHistory(transform);},[]);
 return {state:active.state,history,transformHistory,change,changeFields,select,navigate,reset,alternate,load,remap,markSaved:()=>{grouping.current=null;}};
}
