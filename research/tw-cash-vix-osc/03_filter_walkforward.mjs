import fs from 'fs';
import E from './harness.mjs';
import path from 'path';import {fileURLToPath} from 'url';const __d=path.dirname(fileURLToPath(import.meta.url));const repo=path.resolve(__d,'../..');
const mk=JSON.parse(fs.readFileSync(repo+'/src/data/market_data.json','utf8')).TW;
const al=JSON.parse(fs.readFileSync(path.join(__d,'data/osc_aligned.json'),'utf8'));
const full=E.buildDataset(mk); const s0=al.osc.findIndex(x=>x!=null); const sl=a=>a.slice(s0);
const ds=E.buildDataset({dates:sl(mk.dates),anchor:mk.anchor,rollYield:sl(mk.rollYield),vix:sl(mk.vix),assets:Object.fromEntries(Object.entries(mk.assets).map(([k,v])=>[k,{c:sl(v.c),o:v.o?sl(v.o):null}]))});
const oscArr=al.osc.slice(s0);
const ryS=E.computeVixSignal(full.rollYield,1000,'advanced',28,1,0.5).slice(s0);
const maS=E.computeMASignal(full.prices[full.anchor],full.opens[full.anchor]||full.prices[full.anchor],60,20,'open').slice(s0);
const hyb=E.combineSignals(maS,ryS,'HOLD');
const grid=[10,15,20,28];
const start=ds.dates[E.computeVixSignal(oscArr,1000,'advanced',28,1,0.5).findIndex(x=>x!=null)];
function rets(sig){const r=E.runBacktest(ds,sig,'00631L','00635U',{commissionRate:0.1425,taxRate:0.1});const o=[];for(let i=0;i<ds.n;i++)o.push(i?r.equity[i]/r.equity[i-1]-1:0);return o;}
function stats(rr,idx){let e=[1];for(const i of idx)e.push(e[e.length-1]*(1+rr[i]));const s=E.computeStats(e,0,1.5);return `${(s.cagr*100).toFixed(1)}% / Sh ${s.sharpe.toFixed(2)} / MDD ${(s.maxDD*100).toFixed(0)}% / Calmar ${(s.calmar??0).toFixed(2)}`;}
const yr=d=>+d.slice(0,4);
for(const mode of ['HOLD','AND']){
  const base=rets(hyb); const V={base}; for(const h of grid) V['h'+h]=rets(E.combineSignals(hyb,E.computeVixSignal(oscArr,1000,'advanced',h,1,0.5),mode));
  const idxAll=[];for(let i=1;i<ds.n;i++)if(ds.dates[i]>=start)idxAll.push(i);
  const wf=new Array(ds.n).fill(0); const picks={}; const wfNoBase=new Array(ds.n).fill(0); const picks2={};
  for(let Y=2021;Y<=2026;Y++){
    const tr=idxAll.filter(i=>yr(ds.dates[i])<Y), te=idxAll.filter(i=>yr(ds.dates[i])===Y); if(!te.length)continue;
    const sh=k=>{const r=tr.map(i=>V[k][i]);const m=r.reduce((a,b)=>a+b)/r.length;const sd=Math.sqrt(r.reduce((a,b)=>a+(b-m)**2,0)/r.length);return m/sd;};
    const best=Object.keys(V).sort((a,b)=>sh(b)-sh(a))[0]; picks[Y]=best; te.forEach(i=>wf[i]=V[best][i]);
    const bestF=grid.map(h=>'h'+h).sort((a,b)=>sh(b)-sh(a))[0]; picks2[Y]=bestF; te.forEach(i=>wfNoBase[i]=V[bestF][i]);
  }
  const te=idxAll.filter(i=>yr(ds.dates[i])>=2021);
  console.log(`\n=== Hybrid HOLD + Osc(${mode}) walk-forward，測試期 2021–2026`);
  console.log('基準 Hybrid        ',stats(base,te));
  console.log('固定 h15 (in-sample)',stats(V.h15,te));
  console.log('WF 含基準可選      ',stats(wf,te),JSON.stringify(picks));
  console.log('WF 必選濾網        ',stats(wfNoBase,te),JSON.stringify(picks2));
  for(const h of grid) console.log(' 固定 h'+h+'          ',stats(V['h'+h],te));
}
