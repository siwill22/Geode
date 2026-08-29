import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
const r = await build({entryPoints:['src/mask.ts'],bundle:true,format:'esm',platform:'neutral',write:false,logLevel:'silent'});
const mod = await import('data:text/javascript;base64,'+Buffer.from(r.outputFiles[0].text).toString('base64'));
const {rasteriseMask, MASK_W, MASK_H} = mod;
const DEG=Math.PI/180;
function densify(v,s=0.5){const tv=({lon,lat})=>{const c=Math.cos(lat*DEG);return[c*Math.cos(lon*DEG),Math.sin(lat*DEG),c*Math.sin(lon*DEG)];};
const tl=([x,y,z])=>({lat:Math.asin(Math.max(-1,Math.min(1,y)))/DEG,lon:Math.atan2(z,x)/DEG});
const o=[];for(let i=0;i<v.length;i++){const a=tv(v[i]),b=tv(v[(i+1)%v.length]);
const d=Math.max(-1,Math.min(1,a[0]*b[0]+a[1]*b[1]+a[2]*b[2]));const om=Math.acos(d);
if(om<1e-9){o.push(v[i]);continue;}const n=Math.max(1,Math.ceil(om/DEG/s));const si=Math.sin(om);
for(let k=0;k<n;k++){const t=k/n,w0=Math.sin((1-t)*om)/si,w1=Math.sin(t*om)/si;
o.push(tl([w0*a[0]+w1*b[0],w0*a[1]+w1*b[1],w0*a[2]+w1*b[2]]));}}return o;}

const verts=[[-140,40],[-90,10],[-120,-40],[-180,-20],[-175,25]].map(([lon,lat])=>({lon,lat}));
const m = rasteriseMask(densify(verts), false);
// count filled per row, report runs of rows that differ from neighbours
let rows=[];
for(let j=0;j<MASK_H;j++){let c=0;for(let i=0;i<MASK_W;i++) if(m[j*MASK_W+i]) c++; rows.push(c);}
const nz=rows.map((c,j)=>[j,c]).filter(([,c])=>c>0);
console.log('rows with any fill:', nz.length, 'of', MASK_H);
console.log('first 5:', nz.slice(0,5).map(([j,c])=>`${j}:${c}`).join(' '));
// look for alternating empty rows inside the filled band
const j0=nz[0][0], j1=nz[nz.length-1][0];
let empties=[];
for(let j=j0;j<=j1;j++) if(rows[j]===0) empties.push(j);
console.log('EMPTY rows inside the filled latitude band:', empties.length);
if(empties.length) console.log('  e.g.', empties.slice(0,20).join(','));
// also check for rows filled almost fully (parity inverted)
let wide=[];
for(let j=j0;j<=j1;j++) if(rows[j]>MASK_W*0.7) wide.push(j);
console.log('rows filled >70% of all longitudes (parity likely inverted):', wide.length);
if(wide.length) console.log('  e.g.', wide.slice(0,20).join(','));
