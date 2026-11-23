// Requires Vite on 127.0.0.1:1420 and the .local/regression-bridge Rust analyzer on port 23239.
// Open with the headless Playwright CLI, then run: playwright-cli run-code "$(cat tests/source-pipeline.browser.js)"
async page => {
  const cpp = 'int main() { int x = 1; return x; }';
  const csharp = 'class Program { static int Main() { int x = 1; return x; } }';
  await page.addInitScript(() => {
    let next = 0; const callbacks = new Map();
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(callback) { callbacks.set(++next, callback); return next; },
      async invoke(command, args) {
        if (['inspect_cpp','function_references','analyze_cpp','inspect_code','code_references','analyze_code'].includes(command)) {
          if (window.__hold && command.startsWith('analyze_')) { window.__held=true; await new Promise(r => {window.__release=r}); }
          if (window.__delay && command.startsWith('analyze_')) await new Promise(r => setTimeout(r, window.__delay));
          const response = await fetch('http://127.0.0.1:23239', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})});
          const result = await response.json(); if (result?.error) throw new Error(result.error); return result;
        }
        if (command === 'open_document') { window.__opens=(window.__opens||0)+1; return window.__opened; }
        if (command === 'plugin:dialog|ask' || command === 'plugin:dialog|confirm') return true;
        if (command === 'plugin:event|listen') return ++next;
        if (command === 'plugin:event|unlisten' || command === 'save_recovery') return;
        if (command === 'read_recovery') return JSON.parse(localStorage.getItem('source-pipeline-recovery') || 'null');
        if (command === 'wallpaper_theme') return null;
        if (command === 'recent_projects' || command === 'ai_models') return [];
        if (command === 'save_project_document') { window.__project = args.contents; return {saved:true,projectToken:'test'}; }
        if (command === 'plugin:dialog|message') return 'Ok';
        throw Error('Unhandled command '+command);
      }
    };
  });
  await page.reload();
  await page.getByRole('button',{name:'Save project',exact:true}).first().waitFor();
  await page.waitForTimeout(1000);
  const source = () => page.locator('textarea');
  const chart = (label='int x = 1') => page.waitForFunction(label => { const c=document.querySelector('.chart-canvas'); return c && !c.closest('[inert]') && !c.querySelector('[inert]') && c.textContent.includes(label) && document.querySelectorAll('.chart-canvas .flow-symbol').length > 1; }, label, {timeout:5000});
  const open = async (name, contents) => {
    const count=await page.evaluate(({name, contents}) => {window.__opened={name,contents,projectToken:null};return window.__opens||0;}, {name,contents});
    await page.keyboard.press('Meta+o');
    await page.waitForFunction(count => window.__opens > count, count,{timeout:5000});
    await page.waitForTimeout(300);
    if (!name.endsWith('.codeflow')) await page.waitForFunction(({contents})=>document.querySelector('textarea')?.value===contents, {contents}, {timeout:5000});
    else await page.waitForTimeout(600);
  };
  const failures=[];
  const test = async (name, fn) => { try { await fn(); console.log('PASS '+name); } catch(e) { failures.push(name+': '+e.message); console.log('FAIL '+name+': '+e.message); } };
  await test('raw C++ open', async()=>{await open('main.cpp',cpp);await chart();});
  await test('same raw file twice', async()=>{await open('main.cpp',cpp);await chart();await open('main.cpp',cpp);await chart();});
  await test('raw C# open', async()=>{await open('Program.cs',csharp);await chart();});
  await test('valid invalid valid repair', async()=>{await source().fill('class Program { static int Main( {');await page.getByText(/Showing the last valid chart/).first().waitFor({timeout:5000});await source().fill(csharp.replace('x = 1','x = 3'));await page.getByText(/Showing the last valid chart/).first().waitFor({state:'hidden',timeout:5000});await chart('int x = 3');});
  await test('C++ invalid and distinct repair', async()=>{await open('main.cpp',cpp);await chart();await source().fill('int main( {');await page.getByText(/Showing the last valid chart/).first().waitFor({timeout:5000});await source().fill('int main() { int x = 2; return x; }');await page.getByText(/Showing the last valid chart/).first().waitFor({state:'hidden',timeout:5000});await chart('int x = 2');});
  await test('project open', async()=>{await page.getByRole('button',{name:'Save project',exact:true}).first().click();await page.waitForFunction(()=>window.__project);const project=await page.evaluate(()=>window.__project);await open('saved.codeflow',project);await chart('int x = 2');});
  await test('startup recovery', async()=>{const project=await page.evaluate(()=>window.__project);await page.evaluate(project=>localStorage.setItem('source-pipeline-recovery',JSON.stringify({contents:project,dirty:false})),project);await page.reload();await chart('int x = 2');await page.evaluate(()=>localStorage.removeItem('source-pipeline-recovery'));});
  await test('held analysis preserves syntax diagnostic', async()=>{await open('main.cpp',cpp);await chart();await page.evaluate(()=>{window.__hold=true;window.__held=false});await page.getByRole('button',{name:'Analyze again'}).click();await page.screenshot({path:'.local/source-race-0.png'});await page.waitForFunction(()=>window.__held,null,{timeout:5000});await source().fill('int main( {');await page.getByText(/Showing the last valid chart/).first().waitFor({timeout:5000});await page.screenshot({path:'.local/source-race-1.png'});await page.evaluate(()=>{window.__hold=false;window.__release()});await page.waitForTimeout(800);if (!(await page.getByText(/Showing the last valid chart/).first().isVisible())) throw Error('diagnostic disappeared');await source().fill(cpp);await page.getByText(/Showing the last valid chart/).first().waitFor({state:'hidden',timeout:5000});await chart();await page.screenshot({path:'.local/source-race-2.png'});});
  await test('delayed analysis after source repair', async()=>{await open('Program.cs',csharp);await chart();await page.evaluate(()=>{window.__delay=700});await source().fill(csharp+'\n// first');await page.waitForTimeout(350);await source().fill(csharp+'\n// final');await chart();await page.waitForTimeout(1400);await chart();await page.evaluate(()=>{window.__delay=0});});
  if (!failures.length) { await page.getByRole('button',{name:'Fit View'}).click(); await page.screenshot({path:'.local/source-pipeline-wide.png'});await page.setViewportSize({width:900,height:900});await page.getByRole('button',{name:'Fit View'}).click();await page.screenshot({path:'.local/source-pipeline-compact.png'}); }
  if (failures.length) throw Error(failures.join('\n'));
}
