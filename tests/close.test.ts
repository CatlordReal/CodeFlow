import assert from 'node:assert/strict';
import {createDesktopCloseHandler,type CloseRecoverySnapshot} from '../src/close';

const base:CloseRecoverySnapshot={contents:'one',projectToken:null,dirty:true,sourceDirty:true,projectDirty:false};
function setup(overrides:Partial<Parameters<typeof createDesktopCloseHandler>[0]> = {}) {
  const calls:string[]=[];
  const close=createDesktopCloseHandler({recoveryReady:()=>true,snapshot:()=>base,choose:async()=>{calls.push('choose');return 'cancel';},save:async()=>{calls.push('save');return true;},discardRecovery:async()=>{calls.push('discard');},resumeRecovery:async()=>{calls.push('resume');},saveRecovery:async value=>{calls.push(`recovery:${value.contents}`);},destroy:async()=>{calls.push('destroy');},showError:message=>calls.push(message),...overrides});
  return {close,calls};
}
{
  const {close,calls}=setup({recoveryReady:()=>false});await close();
  assert.deepEqual(calls,['Recovery is still loading. Close again when it finishes.']);
}
{
  const {close,calls}=setup();await close();assert.deepEqual(calls,['choose']);
}
{
  const {close,calls}=setup({choose:async()=> 'discard'});await close();assert.deepEqual(calls,['discard','destroy']);
}
{
  const {close,calls}=setup({choose:async()=> 'discard',destroy:async()=>{throw new Error('window failed');}});await close();
  assert.deepEqual(calls,['discard','resume','recovery:one','CodeFlow could not close: window failed']);
}
{
  const {close,calls}=setup({choose:async()=> 'save',save:async()=>false});await close();assert.deepEqual(calls,[]);
}
{
  let snapshot=base;
  const {close,calls}=setup({choose:async()=> 'save',save:async()=>{snapshot={...snapshot,contents:'edited'};return true;},snapshot:()=>snapshot});await close();
  assert.deepEqual(calls,['Project changed while saving. Close again to save the latest changes.']);
}
{
  let snapshot=base;let release:((choice:'save')=>void)|undefined;
  const {close,calls}=setup({choose:()=>new Promise(resolve=>{release=resolve;}),snapshot:()=>snapshot,saveRecovery:async value=>{calls.push(value.contents);if(calls.length===2)snapshot={...snapshot,contents:'two'};}});
  const first=close();const second=close();release!('save');await Promise.all([first,second]);
  assert.deepEqual(calls,['save','one','two','destroy']);
}
{
  const {close,calls}=setup({snapshot:()=>({...base,dirty:false,sourceDirty:false}),saveRecovery:async()=>{throw new Error('disk full');}});await close();
  assert.deepEqual(calls,['CodeFlow could not close: disk full']);
}
console.log('PASS: desktop close choices, errors, concurrent requests and latest recovery');
