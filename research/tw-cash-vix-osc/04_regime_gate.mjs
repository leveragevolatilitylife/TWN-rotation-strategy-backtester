import fs from 'fs';
import E from './harness.mjs';
import path from 'path';import {fileURLToPath} from 'url';const __d=path.dirname(fileURLToPath(import.meta.url));const repo=path.resolve(__d,'../..');
const mk=JSON.parse(fs.readFileSync(repo+'/src/data/market_data.json','utf8')).TW;
const al=JSON.parse(fs.readFileSync(path.join(__d,'data/osc_aligned.json'),'utf8'));
const full=E.buildDataset(mk); const s0=al.osc.findIndex(x=>x!=null); const sl=a=>a.slice(s0);
const ds=E.buildDataset({dates:sl(mk.dates),anchor:mk.anchor,rollYield:sl(mk.rollYield),vix:sl(mk.vix),assets:Object.fromEntries(Object.entries(mk.assets).map(([k,v])=>[k,{c:sl(v.c),o:v.o?sl(v.o):null}]))});
const osc=al.osc.slice(s0);
const ryS=E.computeVixSignal(full.rollYield,1000,'advanced',28,1,0.5).slice(s0);
const maS=E.computeMASignal(full.prices[full.anchor],full.opens[full.anchor]||full.prices[full.anchor],60,20,'open').slice(s0);
const H1=E.combineSignals(maS,ryS,'HOLD'), H2=E.combineSignals(maS,ryS,'OR');
const L=1000; const pct=osc.map((v,i)=>{if(i<L-1)return null;let c=0;for(let j=i-L+1;j<=i;j++)if(osc[j]<=v)c++;return c/L*100;});
const start=ds.dates[pct.findIndex(x=>x!=null)];
const cfg=[ 'bull','bear' ];
const run=sig=>{const r=E.runBacktest(ds,sig,'00631L','00635U',{commissionRate:0.1425,taxRate:0.1});return r;};
function st(sig,a=start,b=null){const r=run(sig);const i0=ds.dates.findIndex(d=>d>=a);const i1=b?ds.dates.map(d=>d<=b).lastIndexOf(true):ds.n-1;const eq=E.sliceAndNormalize(r.equity,i0,i1);let sw=0;for(let i=i0+1;i<=i1;i++)if(r.appliedAsset[i]!==r.appliedAsset[i-1])sw++;const s=E.computeStats(eq,sw,1.5);return {cagr:s.cagr,sh:s.sharpe,mdd:s.maxDD,cal:s.calmar??0,sw,txt:`${(s.cagr*100).toFixed(1)}% / Sh ${s.sharpe.toFixed(2)} / MDD ${(s.maxDD*100).toFixed(0)}% / Calmar ${(s.calmar??0).toFixed(2)} / sw ${sw}`};}
const mix=(T,stressIsLow=true,A=H1,B=H2)=>H1.map((_,i)=>{if(pct[i]==null||A[i]==null||B[i]==null)return null;const stress=stressIsLow?pct[i]<T:pct[i]>=T;return stress?A[i]:B[i];});
console.log('起點',start);
console.log('Hybrid(HOLD)  ',st(H1.map((x,i)=>pct[i]==null?null:x)).txt);
console.log('Hybrid II(OR) ',st(H2.map((x,i)=>pct[i]==null?null:x)).txt);
const Ts=[10,20,30,40,50,60,70];
console.log('\n--- 閘門：Osc 百分位 < T（壓力區）→ Hybrid；其餘 → Hybrid II');
for(const T of Ts){let s=st(mix(T));let share=pct.filter(x=>x!=null&&x<T).length/pct.filter(x=>x!=null).length;console.log(`T=${T} (壓力區占 ${(share*100).toFixed(0)}%)`.padEnd(24),s.txt);}
console.log('\n--- 反向對照：Osc 百分位 < T → Hybrid II；其餘 → Hybrid');
for(const T of Ts) console.log(`T=${T}`.padEnd(24),st(mix(T,true,H2,H1)).txt);
// subperiods for T=30
console.log('\n--- 分期 T=30 vs 單一策略');
for(const [a,b] of [[start,'2021-12-31'],['2022-01-01','2024-12-31'],['2025-01-01','2026-12-31']]){
 console.log(a,'~',b);console.log('  Hybrid  ',st(H1,a,b).txt);console.log('  HybridII',st(H2,a,b).txt);console.log('  閘門T30 ',st(mix(30),a,b).txt);}
// walk-forward on T (selection by Sharpe on daily returns of each variant, expanding window)
const rets=sig=>{const r=run(sig);return r.equity.map((e,i)=>i?e/r.equity[i-1]-1:0);};
const V={H1:rets(H1.map((x,i)=>pct[i]==null?null:x)),H2:rets(H2.map((x,i)=>pct[i]==null?null:x))};for(const T of Ts)V['T'+T]=rets(mix(T));
const yr=d=>+d.slice(0,4);const idx=[];for(let i=1;i<ds.n;i++)if(ds.dates[i]>=start)idx.push(i);
const wf=new Array(ds.n).fill(0),picks={};
for(let Y=2021;Y<=2026;Y++){const tr=idx.filter(i=>yr(ds.dates[i])<Y),te=idx.filter(i=>yr(ds.dates[i])===Y);if(!te.length||tr.length<250)continue;
 const sh=k=>{const r=tr.map(i=>V[k][i]);const m=r.reduce((a,b)=>a+b)/r.length;return m/Math.sqrt(r.reduce((a,b)=>a+(b-m)**2,0)/r.length);};
 const ks=Ts.map(t=>'T'+t);const best=ks.sort((a,b)=>sh(b)-sh(a))[0];picks[Y]=best;te.forEach(i=>wf[i]=V[best][i]);}
const te=idx.filter(i=>yr(ds.dates[i])>=2021);
const S=r=>{let e=[1];for(const i of te)e.push(e[e.length-1]*(1+r[i]));const s=E.computeStats(e,0,1.5);return `${(s.cagr*100).toFixed(1)}% / Sh ${s.sharpe.toFixed(2)} / MDD ${(s.maxDD*100).toFixed(0)}% / Calmar ${(s.calmar??0).toFixed(2)}`;};
console.log('\n--- Walk-forward 測試期 2021–2026');
console.log('Hybrid   ',S(V.H1));console.log('Hybrid II',S(V.H2));console.log('WF 閘門  ',S(wf),JSON.stringify(picks));
for(const T of [20,30,50]) console.log('固定 T'+T,'  ',S(V['T'+T]));
