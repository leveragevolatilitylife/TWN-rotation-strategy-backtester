import fs from 'fs';
import E from './harness.mjs';
import path from 'path';import {fileURLToPath} from 'url';const __d=path.dirname(fileURLToPath(import.meta.url));const repo=path.resolve(__d,'../..');
const mk=JSON.parse(fs.readFileSync(repo+'/src/data/market_data.json','utf8')).TW;
const al=JSON.parse(fs.readFileSync(path.join(__d,'data/osc_aligned.json'),'utf8'));
const full=E.buildDataset(mk);
const s0=al.osc.findIndex(x=>x!=null);
const sl=(a)=>a.slice(s0);
const mk2={dates:sl(mk.dates),anchor:mk.anchor,rollYield:sl(mk.rollYield),vix:sl(mk.vix),assets:Object.fromEntries(Object.entries(mk.assets).map(([k,v])=>[k,{c:sl(v.c),o:v.o?sl(v.o):null}]))};
const trimmed=E.buildDataset(mk2);
const oscArr=al.osc.slice(s0);
const dsOsc={...trimmed,rollYield:oscArr};
const cfgBase={bullAsset:'00631L',bearAsset:'00635U',commissionRate:0.1425,taxRate:0.1};
const PR={vix:{ma:false,vix:true},hybrid:{ma:true,vix:true,mode:'HOLD'},hybrid2:{ma:true,vix:true,mode:'OR'}};
function run(ds,which,p){ // p: lookback, mode, high, low, xlow
  let sa=null,sb=null;
  if(PR[which].ma) sa=E.computeMASignal(ds.prices[ds.anchor],ds.opens[ds.anchor]||ds.prices[ds.anchor],60,20,'open');
  sb=E.computeVixSignal(ds.rollYield,p.lookback,p.vmode,p.high,p.low,p.xlow);
  const sig=PR[which].ma?E.combineSignals(sa,sb,PR[which].mode):sb;
  const r=E.runBacktest(ds,sig,cfgBase.bullAsset,cfgBase.bearAsset,{commissionRate:cfgBase.commissionRate,taxRate:cfgBase.taxRate});
  return {...r,sig};
}
const first=(sig)=>sig.findIndex(x=>x!=null);
function stats(ds,r,startDate,endDate){
  const i0=ds.dates.findIndex(d=>d>=startDate); let i1=ds.dates.length-1; if(endDate){i1=ds.dates.map(d=>d<=endDate).lastIndexOf(true);} 
  const eq=E.sliceAndNormalize(r.equity,i0,i1); let sw=0; for(let i=i0+1;i<=i1;i++) if(r.appliedAsset[i]!==r.appliedAsset[i-1]) sw++;
  const st=E.computeStats(eq,sw,1.5); return {cagr:st.cagr,vol:st.annualVol,sharpe:st.sharpe,maxDD:st.maxDD,calmar:st.calmar,tot:st.totalReturn,sw};
}
function bh(ds,asset,a,b){const i0=ds.dates.findIndex(d=>d>=a);let i1=b?ds.dates.map(d=>d<=b).lastIndexOf(true):ds.n-1;let e=[1];for(let i=i0+1;i<=i1;i++)e.push(e[e.length-1]*(1+ds.returns[asset][i]));const st=E.computeStats(e,0,1.5);return {cagr:st.cagr,vol:st.annualVol,sharpe:st.sharpe,maxDD:st.maxDD,calmar:st.calmar,tot:st.totalReturn,sw:0};}
const P0={lookback:1000,vmode:'advanced',high:28,low:1,xlow:0.5};
const out={};
// 1) baseline on full history (original behaviour), and signal-start dates
const ryFull={};for(const w of Object.keys(PR)) ryFull[w]=run(full,w,P0);
const ryTrim={};for(const w of Object.keys(PR)) ryTrim[w]=run(trimmed,w,P0);
const osc={};for(const w of Object.keys(PR)) osc[w]=run(dsOsc,w,P0);
const startOsc=dsOsc.dates[Math.max(first(osc.vix.sig),first(osc.hybrid.sig))];
console.log('osc series starts',dsOsc.dates[0],' first osc signal date',startOsc, ' dataset end',dsOsc.dates[dsOsc.n-1]);
const fmt=(x)=>`${(x.cagr*100).toFixed(1)}% / vol ${(x.vol*100).toFixed(1)}% / Sh ${x.sharpe.toFixed(2)} / MDD ${(x.maxDD*100).toFixed(0)}% / Calmar ${(x.calmar??0).toFixed(2)} / sw ${x.sw}`;
console.log('\n=== 同期比較（'+startOsc+' 至今）；CAGR / 波動 / Sharpe / 最大回撤 / Calmar / 切換次數');
for(const w of Object.keys(PR)){
  console.log(w.padEnd(8),'RollYield(全史暖身)',fmt(stats(full,ryFull[w],startOsc)));
  console.log(w.padEnd(8),'RollYield(同樣2015起)',fmt(stats(trimmed,ryTrim[w],startOsc)));
  console.log(w.padEnd(8),'Osc 取代          ',fmt(stats(dsOsc,osc[w],startOsc)));
}
for(const a of ['0050','00631L','00635U']) console.log(('B&H '+a).padEnd(10),fmt(bh(full,a,startOsc)));
// 2) subperiods for vix-only
console.log('\n=== 分期（VIX Rotation+BTD：RollYield全史 vs Osc）');
for(const [a,b] of [[startOsc,'2021-12-31'],['2022-01-01','2024-12-31'],['2025-01-01','2026-12-31']]){
  console.log(a,'~',b,'\n  RY ',fmt(stats(full,ryFull.vix,a,b)),'\n  Osc',fmt(stats(dsOsc,osc.vix,a,b)),'\n  00631L B&H',fmt(bh(full,'00631L',a,b)));
}
// 3) sensitivity (vix-only, osc): lookback x high
console.log('\n=== Osc 參數敏感度（VIX-only，CAGR/Sharpe/MDD，同期 from first signal of lookback=1000）');
const looks=[500,750,1000], highs=[10,15,20,28,35,45];
for(const lb of looks){ let row=`lb=${lb}: `; for(const h of highs){const r=run(dsOsc,'vix',{lookback:lb,vmode:'advanced',high:h,low:1,xlow:0.5});const s=stats(dsOsc,r,startOsc);row+=` h${h}:${(s.cagr*100).toFixed(1)}%/${s.sharpe.toFixed(2)}/${(s.maxDD*100).toFixed(0)}% |`;} console.log(row);}
console.log('\n=== 同上，RollYield 作對照（全史）');
for(const lb of looks){ let row=`lb=${lb}: `; for(const h of highs){const r=run(full,'vix',{lookback:lb,vmode:'advanced',high:h,low:1,xlow:0.5});const s=stats(full,r,startOsc);row+=` h${h}:${(s.cagr*100).toFixed(1)}%/${s.sharpe.toFixed(2)}/${(s.maxDD*100).toFixed(0)}% |`;} console.log(row);}
// 4) signal agreement and bull share
const sa=osc.vix.sig, sb=ryFull.vix.sig; const off=s0; let agree=0,cnt=0,bullO=0,bullR=0;
for(let i=0;i<dsOsc.n;i++){const a=sa[i],b=sb[i+off]; if(a==null||b==null||dsOsc.dates[i]<startOsc) continue; cnt++; if(a===b)agree++; if(a==='BULL')bullO++; if(b==='BULL')bullR++;}
console.log(`\n訊號一致率 ${(agree/cnt*100).toFixed(1)}%；BULL 比例 Osc ${(bullO/cnt*100).toFixed(0)}% vs RY ${(bullR/cnt*100).toFixed(0)}%（n=${cnt}）`);
