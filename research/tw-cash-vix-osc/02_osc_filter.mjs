import fs from 'fs';
import E from './harness.mjs';
import path from 'path';import {fileURLToPath} from 'url';const __d=path.dirname(fileURLToPath(import.meta.url));const repo=path.resolve(__d,'../..');
const mk=JSON.parse(fs.readFileSync(repo+'/src/data/market_data.json','utf8')).TW;
const al=JSON.parse(fs.readFileSync(path.join(__d,'data/osc_aligned.json'),'utf8'));
const full=E.buildDataset(mk); const s0=al.osc.findIndex(x=>x!=null);
const sl=a=>a.slice(s0);
const trimmed=E.buildDataset({dates:sl(mk.dates),anchor:mk.anchor,rollYield:sl(mk.rollYield),vix:sl(mk.vix),assets:Object.fromEntries(Object.entries(mk.assets).map(([k,v])=>[k,{c:sl(v.c),o:v.o?sl(v.o):null}]))});
const oscArr=al.osc.slice(s0);
const P={lookback:1000,vmode:'advanced',high:28,low:1,xlow:0.5};
const ryS=E.computeVixSignal(full.rollYield,P.lookback,P.vmode,P.high,P.low,P.xlow).slice(s0);
const maS=E.computeMASignal(full.prices[full.anchor],full.opens[full.anchor]||full.prices[full.anchor],60,20,'open').slice(s0);
const ds=trimmed;
const startIdx=ds.dates.findIndex((d,i)=>ryS[i]!=null&&true);
const osc=(h)=>E.computeVixSignal(oscArr,1000,'advanced',h,1,0.5);
const first=osc(28).findIndex(x=>x!=null); const start=ds.dates[first];
const fmt=x=>`${(x.cagr*100).toFixed(1)}% / Sh ${x.sharpe.toFixed(2)} / MDD ${(x.maxDD*100).toFixed(0)}% / Calmar ${(x.calmar??0).toFixed(2)} / sw ${x.sw}`;
function st(sig,a=start,b=null){const r=E.runBacktest(ds,sig,'00631L','00635U',{commissionRate:0.1425,taxRate:0.1});
 const i0=ds.dates.findIndex(d=>d>=a);let i1=b?ds.dates.map(d=>d<=b).lastIndexOf(true):ds.n-1;
 const eq=E.sliceAndNormalize(r.equity,i0,i1);let sw=0;for(let i=i0+1;i<=i1;i++)if(r.appliedAsset[i]!==r.appliedAsset[i-1])sw++;
 const s=E.computeStats(eq,sw,1.5);return {cagr:s.cagr,sharpe:s.sharpe,maxDD:s.maxDD,calmar:s.calmar,sw};}
const hyb=E.combineSignals(maS,ryS,'HOLD'), hyb2=E.combineSignals(maS,ryS,'OR');
console.log('同期起點',start);
console.log('基準 RY-VIX      ',fmt(st(ryS)));
console.log('基準 Hybrid HOLD ',fmt(st(hyb)));
console.log('基準 Hybrid OR   ',fmt(st(hyb2)));
for(const h of [10,15,20,28]){
  const o=osc(h);
  console.log(`\n-- Osc high=${h} 作濾網`);
  for(const m of ['AND','HOLD','OR']){
    console.log(` RY ${m} Osc     `,fmt(st(E.combineSignals(ryS,o,m))));
  }
  for(const m of ['AND','HOLD','OR']){
    console.log(` HybridHOLD ${m} Osc`,fmt(st(E.combineSignals(hyb,o,m))));
  }
}
// robustness: Hybrid HOLD AND/HOLD osc h=15, subperiods
const o15=osc(15), cand=E.combineSignals(hyb,o15,'HOLD'), c2=E.combineSignals(ryS,o15,'HOLD');
console.log('\n分期 (RY-VIX | RY HOLD Osc15 | HybridHOLD | HybridHOLD HOLD Osc15)');
for(const [a,b] of [[start,'2021-12-31'],['2022-01-01','2024-12-31'],['2025-01-01','2026-12-31']]){
  console.log(a,'~',b);
  console.log('  RY      ',fmt(st(ryS,a,b)));console.log('  RY+Osc  ',fmt(st(c2,a,b)));
  console.log('  Hyb     ',fmt(st(hyb,a,b)));console.log('  Hyb+Osc ',fmt(st(cand,a,b)));
}
