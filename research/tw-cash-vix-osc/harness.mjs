import fs from 'fs';
import path from 'path';import {fileURLToPath} from 'url';const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const src=fs.readFileSync(repo+'/src/App.jsx','utf8');
function grab(name){const i=src.indexOf('function '+name+'(');if(i<0)throw new Error(name);let j=src.indexOf('{',src.indexOf(')',i));let d=0,k=j;for(;k<src.length;k++){if(src[k]==='{')d++;else if(src[k]==='}'){d--;if(d===0)break;}}return src.slice(i,k+1);}
const names=['buildDataset','computeSMA','computeMASignal','percentileLinear','computeRollingSortedWindows','computeVixSignalFromSorted','computeVixSignal','combineSignals','runBacktest','sliceAndNormalize','computeStats'];
const code=names.map(grab).join('\n')+'\nreturn {buildDataset,computeMASignal,computeVixSignal,combineSignals,runBacktest,sliceAndNormalize,computeStats};';
const E=new Function(code)();
export default E;
