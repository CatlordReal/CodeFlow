import assert from 'node:assert/strict';
import {createDesktopCloseHandler,type CloseRecoverySnapshot} from '../src/close';

const base:CloseRecoverySnapshot={contents:'one',projectToken:null,dirty:true,sourceDirty:true,projectDirty:false};

{
  const calls:string[]=[];
  const close=createDesktopCloseHandler({recoveryReady:()=>false,snapshot:()=>base,confirm:async()=>{calls.push('confirm');return true;},saveRecovery:async()=>{calls.push('save');},destroy:async()=>{calls.push('destroy');},showError:message=>calls.push(message)});
  await close();
  assert.deepEqual(calls,['Recovery is still loading. Close again when it finishes.']);
}

{
  const calls:string[]=[];
  const close=createDesktopCloseHandler({recoveryReady:()=>true,snapshot:()=>base,confirm:async()=>{calls.push('confirm');return false;},saveRecovery:async()=>{calls.push('save');},destroy:async()=>{calls.push('destroy');},showError:message=>calls.push(message)});
  await close();
  assert.deepEqual(calls,['confirm']);
}

{
  let snapshot=base;
  const saved:string[]=[];
  let releaseConfirm:((confirmed:boolean)=>void)|undefined;
  const close=createDesktopCloseHandler({recoveryReady:()=>true,snapshot:()=>snapshot,confirm:()=>new Promise(resolve=>{releaseConfirm=resolve;}),saveRecovery:async value=>{saved.push(value.contents);if(saved.length===1)snapshot={...snapshot,contents:'two',projectDirty:true};},destroy:async()=>{saved.push('destroy');},showError:message=>saved.push(message)});
  const first=close();
  const second=close();
  releaseConfirm!(true);
  await Promise.all([first,second]);
  assert.deepEqual(saved,['one','two','destroy']);
}

{
  const calls:string[]=[];
  const clean={...base,dirty:false,sourceDirty:false};
  const close=createDesktopCloseHandler({recoveryReady:()=>true,snapshot:()=>clean,confirm:async()=>{calls.push('confirm');return true;},saveRecovery:async()=>{calls.push('save');},destroy:async()=>{calls.push('destroy');},showError:message=>calls.push(message)});
  await close();
  assert.deepEqual(calls,['save','destroy']);
}

{
  const calls:string[]=[];
  const close=createDesktopCloseHandler({recoveryReady:()=>true,snapshot:()=>base,confirm:async()=>true,saveRecovery:async()=>{throw new Error('disk full');},destroy:async()=>{calls.push('destroy');},showError:message=>calls.push(message)});
  await close();
  assert.deepEqual(calls,['CodeFlow could not close: disk full']);
}

console.log('PASS: desktop close guards startup and concurrency, preserves cancellation, and flushes latest recovery');
