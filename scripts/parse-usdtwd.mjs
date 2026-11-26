// 讀取 data/USD_TWD_Historical_Data.csv（investing.com 匯出：Date,Price,...，日期格式 MM/DD/YYYY），
// 轉成 src/data/usdtwd.json（{dates:[YYYY-MM-DD 升冪], close:[收盤]}）供「升息期持空方改持美元」選項使用。
// 用法：node scripts/parse-usdtwd.mjs [輸入檔] [輸出檔]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inPath = path.resolve(root, process.argv[2] || "data/USD_TWD_Historical_Data.csv");
const outPath = path.resolve(root, process.argv[3] || "src/data/usdtwd.json");

const text = fs.readFileSync(inPath, "utf8").replace(/^﻿/, "");
const rows = [];
for (const line of text.trim().split(/\r?\n/).slice(1)) {
  const cells = line.match(/"([^"]*)"/g)?.map((s) => s.slice(1, -1));
  if (!cells || cells.length < 2) continue;
  const m = cells[0].match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const px = Number(cells[1].replace(/,/g, ""));
  if (!m || !Number.isFinite(px) || px <= 0) continue;
  rows.push([`${m[3]}-${m[1]}-${m[2]}`, px]);
}
rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
const out = { dates: rows.map((r) => r[0]), close: rows.map((r) => r[1]) };
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`USDTWD ${rows.length} 筆：${out.dates[0]} ~ ${out.dates[out.dates.length - 1]} → ${path.relative(root, outPath)}`);
