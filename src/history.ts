import {useCallback,useReducer} from 'react';
import type {ChartEdits,CaptionSets,LoopOverrides} from './presentation';
import type {SourceLanguage} from './types';
import {packHistories} from './projectSerialization';
export type ChartState={source?:string;labelSource?:string;language?:SourceLanguage;mode:'code'|'natural';edits:ChartEdits;captions:CaptionSets;loopDepth:number|null;loopOverrides:LoopOverrides;hiddenBoxes:Record<string,string[]>;showHiddenBoxes:boolean;includeComments:boolean;showLoopLabels:boolean;functionPositions:Record<string,{x:number;y:number}>};
export type Revision={id:string;parent:string|null;name:string;state:ChartState};
export type ChartHistory={active:string;next:number;revisions:Revision[]};
export const defaultChartState=():ChartState=>({mode:'natural',edits:{},captions:{},loopDepth:0,loopOverrides:{},hiddenBoxes:{},showHiddenBoxes:false,includeComments:false,showLoopLabels:true,functionPositions:{}});
export const initialHistory=(state:ChartState):ChartHistory=>({active:'revision-0',next:1,revisions:[{id:'revision-0',parent:null,name:'Initial',state}]});
/** Bound history while retaining the active revision and valid parent links. */
export function boundHistory(history:ChartHistory):ChartHistory {
 let revisions=history.revisions;
 const encoder=new TextEncoder();
 while(revisions.length>1 && (revisions.length>500 || encoder.encode(JSON.stringify(packHistories([{...history,revisions}]))).length>8*1024*1024)) {
  const index=revisions.findIndex(revision=>revision.id!==history.active);
  if(index<0)break;
  const removed=revisions[index].id;
  revisions=revisions.filter((_,i)=>i!==index).map(revision=>revision.parent===removed?{...revision,parent:null}:revision);
 }
 const bounded=revisions===history.revisions?history:{...history,revisions};
 if(encoder.encode(JSON.stringify(packHistories([bounded]))).length>8*1024*1024)throw new Error('Chart history exceeds 8 MiB; this change cannot be preserved.');
 return bounded;
}
export function appendRevision(history:ChartHistory,state:ChartState,name:string):ChartHistory{
 const id=`revision-${history.next}`;
 return boundHistory({active:id,next:history.next+1,revisions:[...history.revisions,{id,parent:history.active,name,state}]});
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
 if(!element?.closest('[data-chart-history], [data-document-history]') && element?.closest('textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], input[type="number"], [contenteditable]:not([contenteditable="false"])'))return null;
 const key=event.key.toLowerCase();
 if(key==='z')return event.shiftKey?'redo':'undo';
 if(key==='y'&&!event.shiftKey)return 'redo';
 return null;
}
export type HistoryOwner={history:ChartHistory;group:{key:string;field:keyof ChartState;time:number}|null;preferred:Record<string,string>;error:string|null};
export type HistoryAction=
 | {type:'change';field:keyof ChartState;value:unknown;name:string;group?:string;time:number}
 | {type:'fields';fields:Partial<ChartState>;name:string}
 | {type:'select';id:string}
 | {type:'navigate';direction:'undo'|'redo'}
 | {type:'reset'|'alternate'|'saved'|'clearError'}
 | {type:'load';state:ChartState;saved?:ChartHistory}
 | {type:'remap';transform:(state:ChartState)=>ChartState}
 | {type:'transform';transform:(history:ChartHistory)=>ChartHistory};
export const initialHistoryOwner=(state:ChartState):HistoryOwner=>({history:initialHistory(state),group:null,preferred:{},error:null});
/** Reducer is deterministic under React StrictMode updater replay. */
export function historyReducer(owner:HistoryOwner,action:HistoryAction):HistoryOwner {
 const history=owner.history;
 try {
  switch(action.type){
   case 'change': {
    const revision=history.revisions.find(r=>r.id===history.active)!;
    const previous=revision.state[action.field];
    const next=typeof action.value==='function'?(action.value as (value:typeof previous)=>typeof previous)(previous):action.value;
    if(JSON.stringify(next)===JSON.stringify(previous))return owner;
    const state={...revision.state,[action.field]:next};
    const coalesce=!!action.group && owner.group?.key===action.group && owner.group.field===action.field
      && action.time>=owner.group.time && action.time-owner.group.time<800
      && !history.revisions.some(r=>r.parent===revision.id) && revision.parent!==null;
    const updated=coalesce?boundHistory({...history,revisions:history.revisions.map(r=>r.id===revision.id?{...r,state}:r)}):appendRevision(history,state,action.name);
    return {...owner,history:updated,group:action.group?{key:action.group,field:action.field,time:action.time}:null,error:null};
   }
   case 'fields':return {...owner,history:appendFieldsRevision(history,action.fields,action.name),group:null,error:null};
   case 'select':return {...owner,history:history.revisions.some(r=>r.id===action.id)?{...history,active:action.id}:history,group:null};
   case 'navigate': {
    const target=historyTarget(history,action.direction,owner.preferred);
    return {...owner,history:target?{...history,active:target}:history,group:null,
      preferred:target&&action.direction==='undo'?{...owner.preferred,[target]:history.active}:owner.preferred};
   }
   case 'reset': {
    const state=history.revisions.find(r=>r.id===history.active)!.state;
    return {...owner,history:appendRevision(history,{...defaultChartState(),source:state.source,labelSource:state.labelSource,language:state.language,includeComments:state.includeComments,showLoopLabels:state.showLoopLabels},'Reset'),group:null,error:null};
   }
   case 'alternate':return {...owner,history:appendRevision(history,history.revisions.find(r=>r.id===history.active)!.state,'Alternate'),group:null,error:null};
   case 'load':return {history:action.saved??initialHistory(action.state),group:null,preferred:{},error:null};
   case 'remap':return {...owner,history:boundHistory({...history,revisions:history.revisions.map(r=>({...r,state:action.transform(r.state)}))}),group:null,error:null};
   case 'transform':return {...owner,history:boundHistory(action.transform(history)),group:null,error:null};
   case 'saved':return {...owner,group:null};
   case 'clearError':return {...owner,error:null};
  }
 } catch(error) {
  return {...owner,group:null,error:error instanceof Error?error.message:String(error)};
 }
}
export function useChartHistory(initialState:ChartState=defaultChartState()){
 const [owner,dispatch]=useReducer(historyReducer,initialState,initialHistoryOwner);
 const {history}=owner;
 const active=history.revisions.find(r=>r.id===history.active)!;
 const change=useCallback(<K extends keyof ChartState>(field:K,value:ChartState[K]|((previous:ChartState[K])=>ChartState[K]),name:string,group?:string)=>dispatch({type:'change',field,value,name,group,time:Date.now()}),[]);
 const changeFields=useCallback((fields:Partial<ChartState>,name:string)=>dispatch({type:'fields',fields,name}),[]);
 const select=useCallback((id:string)=>dispatch({type:'select',id}),[]);
 const navigate=useCallback((direction:'undo'|'redo')=>dispatch({type:'navigate',direction}),[]);
 const reset=useCallback(()=>dispatch({type:'reset'}),[]);
 const alternate=useCallback(()=>dispatch({type:'alternate'}),[]);
 const load=useCallback((state:ChartState,saved?:ChartHistory)=>dispatch({type:'load',state,saved}),[]);
 const remap=useCallback((transform:(state:ChartState)=>ChartState)=>dispatch({type:'remap',transform}),[]);
 const transformHistory=useCallback((transform:(history:ChartHistory)=>ChartHistory)=>dispatch({type:'transform',transform}),[]);
 const markSaved=useCallback(()=>dispatch({type:'saved'}),[]);
 const clearError=useCallback(()=>dispatch({type:'clearError'}),[]);
 return {state:active.state,history,transformHistory,change,changeFields,select,navigate,reset,alternate,load,remap,markSaved,error:owner.error,clearError};
}
