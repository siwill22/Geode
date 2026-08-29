import { chromium } from 'playwright';
const OUT = process.argv[2];
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const p = await b.newPage({viewport:{width:900,height:800}});
await p.goto('http://localhost:5173/',{waitUntil:'load'});
await p.waitForFunction(()=>window.__geode?.ready===true,{timeout:120000});
const shot = async n => { await p.waitForTimeout(700); await p.screenshot({path:`${OUT}/${n}.png`}); console.log(' ',n); };
const go = async (f,a) => { await p.evaluate(([f,a])=>window.__geode[f](a),[f,a]); await p.waitForTimeout(300); };

await go('setCamera',{lon:-90,lat:25,dist:2.9});
await go('setSurfaceMode','land');
await go('setAge',0);
await shot('land-0Ma');
await go('setAge',60);
await shot('land-60Ma');
await go('setAge',120);
await shot('land-120Ma');
console.log(JSON.stringify(await p.evaluate(()=>window.__geode.landStats?.()??'no landStats')));
await b.close();
