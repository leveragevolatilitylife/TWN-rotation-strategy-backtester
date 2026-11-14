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

const Ts=[10,20,30,40,50,60,70];
const rev=(T)=>mix(T,true,H2,H1);
const rets=sig=>{const r=run(sig);return r.equity.map((e,i)=>i?e/r.equity[i-1]-1:0);};
const V={H1:rets(H1.map((x,i)=>pct[i]==null?null:x)),H2:rets(H2.map((x,i)=>pct[i]==null?null:x))};for(const T of Ts)V['R'+T]=rets(rev(T));
const yr=d=>+d.slice(0,4);const idx=[];for(let i=1;i<ds.n;i++)if(ds.dates[i]>=start)idx.push(i);
const S=(r,ii)=>{let e=[1];for(const i of ii)e.push(e[e.length-1]*(1+r[i]));const s=E.computeStats(e,0,1.5);return `${(s.cagr*100).toFixed(1)}% / Sh ${s.sharpe.toFixed(2)} / MDD ${(s.maxDD*100).toFixed(0)}% / Calmar ${(s.calmar??0).toFixed(2)}`;};
const wf=new Array(ds.n).fill(0),picks={};
for(let Y=2021;Y<=2026;Y++){const tr=idx.filter(i=>yr(ds.dates[i])<Y),te=idx.filter(i=>yr(ds.dates[i])===Y);if(!te.length)continue;
 const sh=k=>{const r=tr.map(i=>V[k][i]);const m=r.reduce((a,b)=>a+b)/r.length;return m/Math.sqrt(r.reduce((a,b)=>a+(b-m)**2,0)/r.length);};
 const best=Ts.map(t=>'R'+t).sort((a,b)=>sh(b)-sh(a))[0];picks[Y]=best;te.forEach(i=>wf[i]=V[best][i]);}
const te=idx.filter(i=>yr(ds.dates[i])>=2021);
console.log('=== 反向版 Walk-forward 2021–2026');
console.log('Hybrid   ',S(V.H1,te));console.log('Hybrid II',S(V.H2,te));console.log('WF 反向  ',S(wf,te),JSON.stringify(picks));
for(const T of [10,30,50]) console.log('固定 R'+T,'  ',S(V['R'+T],te));
console.log('\n=== 分年（固定 R30 vs Hybrid vs Hybrid II）CAGR/年報酬');
const yret=(r,Y)=>{let e=1;for(const i of idx.filter(i=>yr(ds.dates[i])===Y))e*=1+r[i];return ((e-1)*100).toFixed(0)+'%';};
for(let Y=2019;Y<=2026;Y++)console.log(Y,'H',yret(V.H1,Y).padStart(5),' H2',yret(V.H2,Y).padStart(5),' R30',yret(V.R30,Y).padStart(5));
// placebo: random regime with same share as T30 stress (35%), persistence via blocks of 20 days
const share=pct.filter(x=>x!=null&&x<30).length/pct.filter(x=>x!=null).length;
let seed=12345;const rnd=()=>{seed=(seed*1664525+1013904223)%4294967296;return seed/4294967296;};
const real=(()=>{let e=[1];for(const i of idx)e.push(e[e.length-1]*(1+V.R30[i]));return E.computeStats(e,0,1.5).sharpe;})();
const shs=[];
for(let k=0;k<200;k++){const flag=new Array(ds.n).fill(false);for(let i=0;i<ds.n;i+=20){const f=rnd()<share;for(let j=i;j<Math.min(ds.n,i+20);j++)flag[j]=f;}
 const sig=H1.map((_,i)=>pct[i]==null||H1[i]==null||H2[i]==null?null:(flag[i]?H2[i]:H1[i]));
 const r=rets(sig);let e=[1];for(const i of idx)e.push(e[e.length-1]*(1+r[i]));shs.push(E.computeStats(e,0,1.5).sharpe);}
shs.sort((a,b)=>a-b);
console.log(`\n=== 安慰劑：隨機（20日區塊、壓力占比${(share*100).toFixed(0)}%）用 Hybrid II 的 200 次 Sharpe：中位 ${shs[100].toFixed(2)}，90% 分位 ${shs[180].toFixed(2)}，最高 ${shs[199].toFixed(2)}；實際 R30 = ${real.toFixed(2)}；勝過隨機比例 ${(shs.filter(x=>x<real).length/2).toFixed(0)}%`);
