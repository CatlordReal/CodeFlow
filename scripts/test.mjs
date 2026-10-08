import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
await mkdir('.local',{recursive:true});
for (const name of ['flowchart','presentation','export','preservation','history','close']) {
 const output=path.resolve('.local',`${name}-tests.mjs`);
 try {
  await build({entryPoints:[`tests/${name}.test.ts`],bundle:true,platform:'node',format:'esm',packages:'external',outfile:output});
  const result=spawnSync(process.execPath,[output],{stdio:'inherit'});
  if(result.status!==0) process.exitCode=1;
 } finally {await rm(output,{force:true});}
}
