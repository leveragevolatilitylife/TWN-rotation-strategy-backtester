import React, { useState, useMemo, useCallback } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { Trash2, Plus, TrendingUp, TrendingDown, Activity, FlaskConical } from "lucide-react";
import RAW_DATA from "./data/twn_data.json";

const ASSET_KEYS = ["00631L", "00635U", "0050", "CASH"];
const ASSET_LABELS = {
  "00631L": "00631L・台灣50正2（槓桿多）",
  "00635U": "00635U・VIX期貨ER（避險／防禦）",
  "0050": "0050・台灣50（現貨）",
  CASH: "現金（0% 報酬）",
};
const ASSET_SHORT = {
  "00631L": "00631L",
  "00635U": "00635U",
  "0050": "0050",
  CASH: "現金",
};

// 手動新增策略使用的色盤：刻意避開下方 5 個預設策略各自固定的顏色，避免圖表撞色
const RUN_COLORS = ["#f2d675", "#4fd1c5", "#ff9f6b", "#8ee6c5", "#6bc5ff", "#d488c9"];
const BENCH_COLORS = { "00631L": "#5c6b78", "0050": "#8b98a5", "00635U": "#7a5c66" };
const MAX_RUNS = 10; // 5 個預設策略 + 最多 5 組自訂比較
const DEFAULT_RANGE_START = "2014-11-03"; // 回測期間預設起始日（00631L/00635U/VIX資料齊備的起點）

const THEME = {
  bg: "#0b0f14",
  panel: "#121922",
  panelAlt: "#161f2a",
  border: "#232e3a",
  borderSoft: "#1b2530",
  text: "#e6edf3",
  textMuted: "#8b98a5",
  textFaint: "#5b6672",
  teal: "#3ddc97",
  rose: "#ff6b6b",
  gold: "#e0a458",
};

/* ---------- 資料前處理 ---------- */
function buildDataset(rawRows) {
  // rawRows: [date, close0050, open0050, close631L, open631L, close635U, open635U, rollYield, vix][]
  const dates = [];
  const c0050 = [], o0050 = [];
  const c631L = [], o631L = [];
  const c635U = [], o635U = [];
  const rollYield = [];
  const vix = [];
  for (const row of rawRows) {
    dates.push(row[0]);
    c0050.push(row[1]); o0050.push(row[2]);
    c631L.push(row[3]); o631L.push(row[4]);
    c635U.push(row[5]); o635U.push(row[6]);
    rollYield.push(row[7]);
    vix.push(row[8]);
  }
  const n = dates.length;
  const retOf = (arr) => {
    const r = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      r[i] = arr[i - 1] > 0 ? (arr[i] - arr[i - 1]) / arr[i - 1] : 0;
    }
    return r;
  };
  const prices = { "0050": c0050, "00631L": c631L, "00635U": c635U };
  const opens = { "0050": o0050, "00631L": o631L, "00635U": o635U };
  const returns = {
    "0050": retOf(c0050),
    "00631L": retOf(c631L),
    "00635U": retOf(c635U),
    CASH: new Array(n).fill(0),
  };
  return { dates, prices, opens, rollYield, vix, returns, n };
}

// 模組層級只計算一次，供元件初始 state（含開機自動載入的預設策略）共用
const INITIAL_DATASET = buildDataset(RAW_DATA);

/* ---------- 訊號計算 ---------- */
function computeSMA(arr, period) {
  const n = arr.length;
  const out = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function computeMASignal(closePrices, openPrices, period, biasPctThreshold, priceBasis) {
  const n = closePrices.length;
  const biasThresh = biasPctThreshold / 100;
  const sig = new Array(n).fill(null);
  if (priceBasis === "open") {
    // 對應「MA Rotation II」：以「當日開盤價」與「當日開盤 + 前(period-1)日收盤」的均線比較，
    // 可在當日開盤時就取得訊號（不需等到當日收盤）。
    for (let t = period - 1; t < n; t++) {
      let sum = openPrices[t];
      for (let k = 1; k <= period - 1; k++) sum += closePrices[t - k];
      const ma = sum / period;
      if (ma === 0) continue;
      const price = openPrices[t];
      const bias = (price - ma) / ma;
      sig[t] = price > ma ? (bias < biasThresh ? "BULL" : "BEAR") : "BEAR";
    }
  } else {
    // 對應「MA Rotation」：標準以收盤價計算的簡單移動平均
    const ma = computeSMA(closePrices, period);
    for (let i = 0; i < n; i++) {
      if (ma[i] == null) continue;
      const bias = (closePrices[i] - ma[i]) / ma[i];
      sig[i] = closePrices[i] > ma[i] ? (bias < biasThresh ? "BULL" : "BEAR") : "BEAR";
    }
  }
  return sig;
}

function percentileLinear(sortedArr, pct) {
  const n = sortedArr.length;
  if (n === 0) return null;
  if (n === 1) return sortedArr[0];
  const idx = (pct / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * frac;
}

function computeRollingSortedWindows(rollYield, lookback) {
  // 昂貴的排序步驟獨立出來，供同一 lookback 的不同門檻設定重複利用（PBO 網格搜尋時大幅加速）
  const n = rollYield.length;
  const windows = new Array(n).fill(null);
  for (let i = lookback - 1; i < n; i++) {
    windows[i] = rollYield.slice(i - lookback + 1, i + 1).sort((a, b) => a - b);
  }
  return windows;
}

function computeVixSignalFromSorted(rollYield, sortedWindows, lookback, mode, highPct, lowPct, extremeLowPct) {
  const n = rollYield.length;
  const raw = new Array(n).fill(null);
  for (let i = lookback - 1; i < n; i++) {
    const window = sortedWindows[i];
    const high = percentileLinear(window, highPct);
    const value = rollYield[i];
    if (value > high) {
      raw[i] = "BULL";
    } else if (mode === "advanced") {
      const extremeLow = percentileLinear(window, extremeLowPct);
      const low = percentileLinear(window, lowPct);
      if (value < extremeLow) raw[i] = "BULL";
      else if (value < low) raw[i] = "INERTIA";
      else raw[i] = "BEAR";
    } else {
      raw[i] = "BEAR";
    }
  }
  // 慣性區(INERTIA)：沿用前一天已解析出的訊號
  const sig = new Array(n).fill(null);
  let prevResolved = null;
  for (let i = 0; i < n; i++) {
    if (raw[i] == null) continue;
    if (raw[i] === "INERTIA") {
      sig[i] = prevResolved != null ? prevResolved : "BEAR";
    } else {
      sig[i] = raw[i];
    }
    prevResolved = sig[i];
  }
  return sig;
}

function computeVixSignal(rollYield, lookback, mode, highPct, lowPct, extremeLowPct) {
  const sortedWindows = computeRollingSortedWindows(rollYield, lookback);
  return computeVixSignalFromSorted(rollYield, sortedWindows, lookback, mode, highPct, lowPct, extremeLowPct);
}

function combineSignals(sigA, sigB, mode) {
  const n = sigA.length;
  const out = new Array(n).fill(null);
  let prevResolved = null;
  for (let i = 0; i < n; i++) {
    if (sigA[i] == null || sigB[i] == null) continue;
    if (mode === "AND") {
      out[i] = sigA[i] === "BULL" && sigB[i] === "BULL" ? "BULL" : "BEAR";
    } else if (mode === "OR") {
      out[i] = sigA[i] === "BULL" || sigB[i] === "BULL" ? "BULL" : "BEAR";
    } else {
      // HOLD：訊號相同時採用該訊號；訊號分歧時維持前一日已解析出的訊號（不輪動）
      if (sigA[i] === sigB[i]) {
        out[i] = sigA[i];
      } else {
        out[i] = prevResolved != null ? prevResolved : "BEAR";
      }
    }
    prevResolved = out[i];
  }
  return out;
}

/* ---------- 回測執行 ----------
   輪動發生時（持有標的與前一日不同）以「開盤價」進場：
     equity = 前日equity
              × (1+隔夜報酬：舊標的 前日收盤→今日開盤)
              × (1-賣出成本：手續費+證交稅，若舊標的非現金)
              × (1-買進成本：手續費，若新標的非現金)
              × (1+盤中報酬：新標的 今日開盤→今日收盤)
   未輪動時沿用一般收盤對收盤報酬，不產生交易成本。
   同時記錄每一段「持倉區間」（trades）：從某次輪動買進到下次輪動賣出視為一筆交易，
   進出場equity皆已扣除當次手續費/證交稅，可直接算出該筆交易的真實報酬率。
------------------------------------------------------------ */
function runBacktest(dataset, signal, bullAsset, bearAsset, costConfig) {
  const { n, dates, returns, prices, opens } = dataset;
  const commissionRate = (costConfig?.commissionRate ?? 0) / 100;
  const taxRate = (costConfig?.taxRate ?? 0) / 100;
  const equity = new Array(n).fill(1);
  const appliedAsset = new Array(n).fill("CASH");
  let trades = 0;
  let totalCostDrag = 0; // 累計因交易成本損失的權益（相對值，粗估）

  const tradeList = [];
  let openTrade = null; // { asset, entryDate, entryIdx, entryEquity }

  for (let i = 1; i < n; i++) {
    const prevAsset = appliedAsset[i - 1];
    const prevSignal = signal[i - 1];
    const requiredAsset = prevSignal == null ? "CASH" : prevSignal === "BULL" ? bullAsset : bearAsset;

    if (requiredAsset === prevAsset) {
      const ret = requiredAsset === "CASH" ? 0 : returns[requiredAsset][i];
      equity[i] = equity[i - 1] * (1 + ret);
    } else {
      const overnightRet =
        prevAsset === "CASH" ? 0 : (opens[prevAsset][i] - prices[prevAsset][i - 1]) / prices[prevAsset][i - 1];
      const intradayRet =
        requiredAsset === "CASH" ? 0 : (prices[requiredAsset][i] - opens[requiredAsset][i]) / opens[requiredAsset][i];
      const sellCost = prevAsset === "CASH" ? 0 : commissionRate + taxRate;
      const buyCost = requiredAsset === "CASH" ? 0 : commissionRate;

      let eq = equity[i - 1] * (1 + overnightRet);
      const eqAfterOvernight = eq;
      eq = eq * (1 - sellCost); // 賣出舊倉（若有）
      const eqAfterSell = eq;

      if (prevAsset !== "CASH" && openTrade) {
        tradeList.push({
          asset: openTrade.asset,
          entryDate: openTrade.entryDate,
          exitDate: dates[i],
          entryEquity: openTrade.entryEquity,
          exitEquity: eqAfterSell,
          returnPct: eqAfterSell / openTrade.entryEquity - 1,
          holdingDays: i - openTrade.entryIdx,
          open: false,
        });
        openTrade = null;
      }

      eq = eq * (1 - buyCost); // 買進新倉（若有）
      totalCostDrag += eqAfterOvernight - eq;

      if (requiredAsset !== "CASH") {
        openTrade = { asset: requiredAsset, entryDate: dates[i], entryIdx: i, entryEquity: eq };
      }

      eq = eq * (1 + intradayRet);
      equity[i] = eq;
      trades += 1;
    }
    appliedAsset[i] = requiredAsset;
  }

  // 資料結尾時若仍持有部位，列為「未平倉」交易（以最後一天equity作為暫估出場值）
  if (openTrade) {
    tradeList.push({
      asset: openTrade.asset,
      entryDate: openTrade.entryDate,
      exitDate: dates[n - 1],
      entryEquity: openTrade.entryEquity,
      exitEquity: equity[n - 1],
      returnPct: equity[n - 1] / openTrade.entryEquity - 1,
      holdingDays: n - 1 - openTrade.entryIdx,
      open: true,
    });
  }

  return { equity, appliedAsset, trades, totalCostDrag, tradeList };
}

function buyHoldCurve(dataset, asset) {
  const { n, returns } = dataset;
  const equity = new Array(n).fill(1);
  for (let i = 1; i < n; i++) {
    equity[i] = equity[i - 1] * (1 + returns[asset][i]);
  }
  return equity;
}

function sliceAndNormalize(equity, startIdx, endIdx) {
  const base = equity[startIdx];
  const out = [];
  for (let i = startIdx; i <= endIdx; i++) out.push(equity[i] / base);
  return out;
}

function computeStats(equitySlice, tradesInRange, riskFreeRatePct) {
  const n = equitySlice.length;
  const totalReturn = equitySlice[n - 1] / equitySlice[0] - 1;
  const tradingDays = n - 1;
  const years = tradingDays / 252;
  const cagr = years > 0 ? Math.pow(equitySlice[n - 1] / equitySlice[0], 252 / tradingDays) - 1 : 0;
  const dailyReturns = [];
  for (let i = 1; i < n; i++) dailyReturns.push(equitySlice[i] / equitySlice[i - 1] - 1);
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / (dailyReturns.length || 1);
  const variance =
    dailyReturns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (dailyReturns.length || 1);
  const dailyStd = Math.sqrt(variance);
  const annualVol = dailyStd * Math.sqrt(252);
  const annualRet = mean * 252;
  const rf = riskFreeRatePct / 100;
  const sharpe = annualVol > 0 ? (annualRet - rf) / annualVol : 0;

  // Sortino ratio：以日化無風險利率為 MAR，只取下方（低於 MAR）的波動
  const dailyMAR = rf / 252;
  const downsideSqSum = dailyReturns.reduce((a, r) => {
    const d = Math.min(r - dailyMAR, 0);
    return a + d * d;
  }, 0);
  const downsideDeviation = Math.sqrt(downsideSqSum / (dailyReturns.length || 1)) * Math.sqrt(252);
  const sortino = downsideDeviation > 0 ? (annualRet - rf) / downsideDeviation : null;

  let peak = equitySlice[0];
  let maxDD = 0;
  let ulcerSqSum = 0;
  for (const e of equitySlice) {
    if (e > peak) peak = e;
    const dd = (e - peak) / peak;
    if (dd < maxDD) maxDD = dd;
    ulcerSqSum += (dd * 100) * (dd * 100);
  }
  const ulcerIndex = Math.sqrt(ulcerSqSum / n); // 以「%」為單位的均方根回撤深度
  const upi = ulcerIndex > 0 ? (cagr * 100 - riskFreeRatePct) / ulcerIndex : null; // Ulcer Performance Index (Martin Ratio)

  const winRate =
    dailyReturns.length > 0 ? dailyReturns.filter((r) => r > 0).length / dailyReturns.length : 0;
  const calmar = maxDD !== 0 ? cagr / Math.abs(maxDD) : null;
  return { totalReturn, cagr, annualVol, sharpe, sortino, maxDD, ulcerIndex, upi, winRate, calmar, trades: tradesInRange };
}

/* ---------- 交易區間分析（依每次輪動的持倉區間）---------- */
function computeTradeStats(trades) {
  const closed = trades.filter((t) => !t.open);
  if (closed.length === 0) {
    return { tradeCount: 0, winRate: null, avgWin: null, avgLoss: null, plRatio: null, expectancy: null };
  }
  const wins = closed.filter((t) => t.returnPct > 0);
  const losses = closed.filter((t) => t.returnPct <= 0);
  const winRate = wins.length / closed.length;
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.returnPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, t) => a + t.returnPct, 0) / losses.length : 0;
  const plRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : null;
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;
  return { tradeCount: closed.length, winRate, avgWin, avgLoss, plRatio, expectancy };
}

/* ============================================================
   資訊係數 (IC) / 資訊比率 (IR) 分析
   IC：以「策略持倉方向訊號」(多方=+1／空方=-1) 與「隔日多空資產報酬價差」
        的皮爾森相關係數，衡量訊號對後續相對表現的預測力。
   ============================================================ */
function pearsonCorr(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  let sumX = 0, sumY = 0;
  for (let i = 0; i < n; i++) { sumX += xs[i]; sumY += ys[i]; }
  const meanX = sumX / n, meanY = sumY / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX, dy = ys[i] - meanY;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function rollingCorr(xs, ys, window) {
  const n = xs.length;
  const out = new Array(n).fill(null);
  for (let i = window - 1; i < n; i++) {
    out[i] = pearsonCorr(xs.slice(i - window + 1, i + 1), ys.slice(i - window + 1, i + 1));
  }
  return out;
}

function expandingCorr(xs, ys, minPeriods) {
  const n = xs.length;
  const out = new Array(n).fill(null);
  for (let i = minPeriods - 1; i < n; i++) {
    out[i] = pearsonCorr(xs.slice(0, i + 1), ys.slice(0, i + 1));
  }
  return out;
}

function sliceRaw(arr, startIdx, endIdx) {
  return arr.slice(startIdx, endIdx + 1);
}

/* 由最終合併訊號＋多空資產報酬，計算逐日「訊號 vs. 隔日多空價差報酬」的滾動/累計IC（對齊回原始日期索引） */
function computeICSeries(dataset, finalSignal, bullAsset, bearAsset, icWindow) {
  const n = dataset.n;
  const spreadReturn = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    spreadReturn[i] = dataset.returns[bullAsset][i] - dataset.returns[bearAsset][i];
  }
  const signalNumeric = finalSignal.map((s) => (s == null ? null : s === "BULL" ? 1 : -1));
  const validIdx = [];
  for (let k = 0; k < n - 1; k++) {
    if (signalNumeric[k] != null) validIdx.push(k);
  }
  const xs = validIdx.map((k) => signalNumeric[k]);
  const ys = validIdx.map((k) => spreadReturn[k + 1]);
  const rollingCompact = rollingCorr(xs, ys, icWindow);
  const expandingCompact = expandingCorr(xs, ys, Math.max(20, Math.floor(icWindow / 3)));
  const icRolling = new Array(n).fill(null);
  const icExpanding = new Array(n).fill(null);
  validIdx.forEach((k, j) => {
    icRolling[k] = rollingCompact[j];
    icExpanding[k] = expandingCompact[j];
  });
  return { icRolling, icExpanding };
}

/* ============================================================
   共用：由一組完整設定(cfg)建立一個可加入比較清單的 run 物件。
   handleAddRun（手動加入）與預設策略（開機自動載入／按鈕載入）皆呼叫此函式，
   確保計算邏輯（含交易明細、IC序列）完全一致。
   ============================================================ */
function buildRunFromConfig(dataset, cfg, name, color, lastAssetEndIdx) {
  let sigA = null;
  let sigB = null;
  if (cfg.maEnabled) sigA = computeMASignal(dataset.prices["0050"], dataset.opens["0050"], cfg.maPeriod, cfg.maBias, cfg.maPriceBasis || "close");
  if (cfg.vixEnabled) sigB = computeVixSignal(dataset.rollYield, cfg.vixLookback, cfg.vixMode, cfg.vixHigh, cfg.vixLow, cfg.vixExtremeLow);
  const finalSignal = cfg.maEnabled && cfg.vixEnabled ? combineSignals(sigA, sigB, cfg.combineMode) : cfg.maEnabled ? sigA : sigB;

  const { equity, appliedAsset, trades, tradeList } = runBacktest(dataset, finalSignal, cfg.bullAsset, cfg.bearAsset, {
    commissionRate: cfg.commissionRate,
    taxRate: cfg.taxRate,
  });
  const { icRolling, icExpanding } = computeICSeries(dataset, finalSignal, cfg.bullAsset, cfg.bearAsset, cfg.icWindow);

  const endIdx = lastAssetEndIdx == null ? dataset.n - 1 : lastAssetEndIdx;
  let lastAsset = null;
  for (let i = endIdx; i >= 0; i--) {
    if (appliedAsset[i]) {
      lastAsset = appliedAsset[i];
      break;
    }
  }

  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    color,
    config: { ...cfg },
    equity,
    appliedAsset,
    trades,
    tradeList,
    icRolling,
    icExpanding,
    lastAsset,
  };
}

/* ============================================================
   預設策略：對應「台股波動率輪換策略儀表板」每日追蹤的 5 種策略
   （來源：00631L_00635U_MARS_VRS_Hybrid.xlsx 之公式解析）
   ============================================================ */
const PRESET_BASE = {
  bullAsset: "00631L",
  bearAsset: "00635U",
  riskFreeRate: 1.5,
  commissionRate: 0.1425, // 標準（未折扣）手續費率；如有broker折扣可自行調整
  taxRate: 0.1,
  icWindow: 60,
};
const PRESETS = [
  {
    id: "ma_rotation",
    name: "MA Rotation (0050 60MA+BIAS)",
    color: "#5b9bd5",
    config: {
      ...PRESET_BASE,
      maEnabled: true,
      maPeriod: 60,
      maBias: 20,
      maPriceBasis: "close",
      vixEnabled: false,
      vixLookback: 1000,
      vixMode: "advanced",
      vixHigh: 28,
      vixLow: 1,
      vixExtremeLow: 0.5,
      combineMode: "AND",
    },
  },
  {
    id: "ma_rotation_ii",
    name: "MA Rotation II (0050 60MA+BIAS)",
    color: "#c792ea",
    config: {
      ...PRESET_BASE,
      maEnabled: true,
      maPeriod: 60,
      maBias: 20,
      maPriceBasis: "open",
      vixEnabled: false,
      vixLookback: 1000,
      vixMode: "advanced",
      vixHigh: 28,
      vixLow: 1,
      vixExtremeLow: 0.5,
      combineMode: "AND",
    },
  },
  {
    id: "vix_btd",
    name: "VIX Rotation+BTD (R4Y28_4Y.5)",
    color: "#e0a458",
    config: {
      ...PRESET_BASE,
      maEnabled: false,
      maPeriod: 60,
      maBias: 20,
      maPriceBasis: "close",
      vixEnabled: true,
      vixLookback: 1000,
      vixMode: "advanced",
      vixHigh: 28,
      vixLow: 1,
      vixExtremeLow: 0.5,
      combineMode: "AND",
    },
  },
  {
    id: "hybrid",
    name: "MARS+VRS Hybrid",
    color: "#3ddc97",
    config: {
      ...PRESET_BASE,
      maEnabled: true,
      maPeriod: 60,
      maBias: 20,
      maPriceBasis: "open",
      vixEnabled: true,
      vixLookback: 1000,
      vixMode: "advanced",
      vixHigh: 28,
      vixLow: 1,
      vixExtremeLow: 0.5,
      combineMode: "HOLD",
    },
  },
  {
    id: "hybrid_ii",
    name: "MARS+VRS Hybrid II",
    color: "#ff6b6b",
    config: {
      ...PRESET_BASE,
      maEnabled: true,
      maPeriod: 60,
      maBias: 20,
      maPriceBasis: "open",
      vixEnabled: true,
      vixLookback: 1000,
      vixMode: "advanced",
      vixHigh: 28,
      vixLow: 1,
      vixExtremeLow: 0.5,
      combineMode: "OR",
    },
  },
];

/* ============================================================
   回測過擬合機率 (PBO) — Combinatorially Symmetric Cross-Validation
   參考：Bailey, Borwein, López de Prado, Zhu (2015)
   ============================================================ */
function getAvailableParams(draft) {
  const opts = [];
  if (draft.maEnabled) {
    opts.push({ key: "maPeriod", label: "均線天數", isInt: true, defMin: 20, defMax: 120 });
    opts.push({ key: "maBias", label: "乖離率門檻(%)", isInt: false, defMin: 5, defMax: 40 });
  }
  if (draft.vixEnabled) {
    opts.push({ key: "vixLookback", label: "VIX滾動視窗(天)", isInt: true, defMin: 504, defMax: 1512 });
    opts.push({ key: "vixHigh", label: "VIX高分位門檻(%)", isInt: false, defMin: 15, defMax: 45 });
    if (draft.vixMode === "advanced") {
      opts.push({ key: "vixLow", label: "VIX低分位門檻(%)", isInt: false, defMin: 0.5, defMax: 5 });
      opts.push({ key: "vixExtremeLow", label: "VIX極低分位門檻(%)", isInt: false, defMin: 0.1, defMax: 2 });
    }
  }
  return opts;
}

function linspace(min, max, steps, isInt) {
  const s = Math.max(1, Math.round(steps));
  if (s === 1) return [isInt ? Math.round(min) : min];
  const out = [];
  for (let i = 0; i < s; i++) {
    let v = min + ((max - min) * i) / (s - 1);
    if (isInt) v = Math.round(v);
    out.push(v);
  }
  return Array.from(new Set(out));
}

function sharpeLike(returns) {
  const n = returns.length;
  if (n === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const std = Math.sqrt(variance);
  if (std === 0) return mean === 0 ? 0 : mean > 0 ? 1e9 : -1e9;
  return mean / std;
}

function kCombinations(n, k) {
  const result = [];
  const combo = new Array(k);
  function backtrack(start, depth) {
    if (depth === k) { result.push(combo.slice()); return; }
    for (let i = start; i <= n - (k - depth); i++) {
      combo[depth] = i;
      backtrack(i + 1, depth + 1);
    }
  }
  backtrack(0, 0);
  return result;
}

function histogram(values, bins = 14) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [{ bin: min, count: values.length }];
  const width = (max - min) / bins;
  const counts = new Array(bins).fill(0);
  for (const v of values) {
    let idx = Math.floor((v - min) / width);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    counts[idx]++;
  }
  return counts.map((c, i) => ({ bin: min + i * width, label: (min + i * width).toFixed(2), count: c }));
}

function cartesianProduct(paramDefs) {
  let combos = [{}];
  for (const p of paramDefs) {
    const next = [];
    for (const c of combos) {
      for (const v of p.values) next.push({ ...c, [p.key]: v });
    }
    combos = next;
  }
  return combos;
}

/* ---------- 常態分布輔助函式（供 Deflated Sharpe Ratio 使用） ---------- */
function normCDF(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

function invNormCDF(p) {
  // Acklam 有理逼近法，誤差約 1e-9
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

function computeSkewKurtosis(returns) {
  const n = returns.length;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  let m2 = 0, m3 = 0, m4 = 0;
  for (const r of returns) {
    const d = r - mean;
    m2 += d * d; m3 += d * d * d; m4 += d * d * d * d;
  }
  m2 /= n; m3 /= n; m4 /= n;
  const std = Math.sqrt(m2);
  const skew = std > 0 ? m3 / (std * std * std) : 0;
  const kurt = std > 0 ? m4 / (std * std * std * std) : 3;
  return { skew, kurt };
}

/* 候選策略間平均報酬相關係數：N 較大時以隨機抽樣估計，避免 O(N^2) 全配對造成運算爆炸 */
function estimateAvgPairwiseCorr(returnsMatrix, maxSamples = 3000) {
  const N = returnsMatrix.length;
  if (N < 2) return null;
  const totalPairs = (N * (N - 1)) / 2;
  let sum = 0, cnt = 0;
  if (totalPairs <= maxSamples) {
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const c = pearsonCorr(returnsMatrix[i], returnsMatrix[j]);
        if (c != null) { sum += c; cnt++; }
      }
    }
  } else {
    for (let k = 0; k < maxSamples; k++) {
      const i = Math.floor(Math.random() * N);
      let j = Math.floor(Math.random() * N);
      if (j === i) j = (j + 1) % N;
      const c = pearsonCorr(returnsMatrix[i], returnsMatrix[j]);
      if (c != null) { sum += c; cnt++; }
    }
  }
  return cnt > 0 ? sum / cnt : null;
}

/* ---------- Deflated Sharpe Ratio (Bailey & López de Prado, 2014) ----------
   針對「N組候選策略中挑出樣本內Sharpe最高者」這個搜索過程本身做多重檢定修正：
   估計「純靠運氣、搜索N次後預期能挑到的最大Sharpe」，並用該最佳策略報酬的
   偏態/峰態調整標準誤，換算成一個 0~1 的機率（DSR），代表其真實Sharpe
   高於「搜索所致最大值」的信心程度。
------------------------------------------------------------ */
function computeDeflatedSharpe(returnsMatrix) {
  const N = returnsMatrix.length;
  const sharpes = returnsMatrix.map((rets) => {
    const n = rets.length;
    const mean = rets.reduce((a, b) => a + b, 0) / n;
    const variance = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
    const std = Math.sqrt(variance);
    return std > 0 ? mean / std : 0;
  });
  let bestIdx = 0;
  for (let i = 1; i < N; i++) if (sharpes[i] > sharpes[bestIdx]) bestIdx = i;
  const srHat = sharpes[bestIdx];
  const meanSR = sharpes.reduce((a, b) => a + b, 0) / N;
  const varSR = sharpes.reduce((a, b) => a + (b - meanSR) * (b - meanSR), 0) / N;
  const sigmaSR = Math.sqrt(varSR);
  const gamma = 0.5772156649015329; // Euler-Mascheroni 常數
  const expectedMaxSR =
    N > 1 ? sigmaSR * ((1 - gamma) * invNormCDF(1 - 1 / N) + gamma * invNormCDF(1 - 1 / (N * Math.E))) : 0;
  const bestReturns = returnsMatrix[bestIdx];
  const T = bestReturns.length;
  const { skew, kurt } = computeSkewKurtosis(bestReturns);
  const denom = 1 - skew * srHat + ((kurt - 1) / 4) * srHat * srHat;
  const dsr = denom > 0 && T > 1 ? normCDF(((srHat - expectedMaxSR) * Math.sqrt(T - 1)) / Math.sqrt(denom)) : null;
  return { dsr, srHat, expectedMaxSR, sigmaSR, bestIdx, skew, kurt, T };
}

function runPBOAnalysis(dataset, baseDraft, paramDefs, S, rangeIdx) {
  const { startIdx, endIdx } = rangeIdx;
  const variants = cartesianProduct(paramDefs); // 每個元素為 {參數key: 值, ...} 的組合
  const N = variants.length;

  // 快取：均線訊號與 VIX 排序視窗／訊號皆按實際用到的參數組合快取，
  // 避免在網格搜尋中對同一 lookback 重複做昂貴的排序運算。
  const maCache = new Map();
  const vixWindowCache = new Map();
  const vixSignalCache = new Map();

  const getMASignal = (cfg) => {
    const k = `${cfg.maPeriod}|${cfg.maBias}|${cfg.maPriceBasis || "close"}`;
    if (!maCache.has(k))
      maCache.set(k, computeMASignal(dataset.prices["0050"], dataset.opens["0050"], cfg.maPeriod, cfg.maBias, cfg.maPriceBasis || "close"));
    return maCache.get(k);
  };
  const getVixSignal = (cfg) => {
    const k = `${cfg.vixLookback}|${cfg.vixMode}|${cfg.vixHigh}|${cfg.vixLow}|${cfg.vixExtremeLow}`;
    if (!vixSignalCache.has(k)) {
      if (!vixWindowCache.has(cfg.vixLookback)) {
        vixWindowCache.set(cfg.vixLookback, computeRollingSortedWindows(dataset.rollYield, cfg.vixLookback));
      }
      const windows = vixWindowCache.get(cfg.vixLookback);
      vixSignalCache.set(
        k,
        computeVixSignalFromSorted(dataset.rollYield, windows, cfg.vixLookback, cfg.vixMode, cfg.vixHigh, cfg.vixLow, cfg.vixExtremeLow)
      );
    }
    return vixSignalCache.get(k);
  };

  const returnsMatrix = variants.map((v) => {
    const cfg = { ...baseDraft, ...v };
    const sigA = cfg.maEnabled ? getMASignal(cfg) : null;
    const sigB = cfg.vixEnabled ? getVixSignal(cfg) : null;
    const finalSignal = cfg.maEnabled && cfg.vixEnabled ? combineSignals(sigA, sigB, cfg.combineMode) : cfg.maEnabled ? sigA : sigB;
    const { equity } = runBacktest(dataset, finalSignal, cfg.bullAsset, cfg.bearAsset, {
      commissionRate: cfg.commissionRate,
      taxRate: cfg.taxRate,
    });
    const rets = [];
    for (let i = Math.max(startIdx, 1); i <= endIdx; i++) rets.push(equity[i] / equity[i - 1] - 1);
    return rets;
  });

  const avgPairwiseCorr = estimateAvgPairwiseCorr(returnsMatrix);
  const dsrResult = computeDeflatedSharpe(returnsMatrix);
  const bestParams = variants[dsrResult.bestIdx];

  const T = returnsMatrix[0].length;
  const blockLen = Math.floor(T / S);
  if (blockLen < 5) {
    throw new Error("所選期間過短，不足以切成足夠區塊，請延長回測期間或減少區塊數 S。");
  }
  const blocks = [];
  for (let b = 0; b < S; b++) {
    const s = b * blockLen;
    const e = b === S - 1 ? T : s + blockLen;
    blocks.push([s, e]);
  }
  const isCombos = kCombinations(S, S / 2);
  let overfitCount = 0;
  const logits = [];
  for (const isBlockIdx of isCombos) {
    const isSet = new Set(isBlockIdx);
    const isSharpe = new Array(N);
    const osSharpe = new Array(N);
    for (let vI = 0; vI < N; vI++) {
      const rets = returnsMatrix[vI];
      const isRets = [];
      const osRets = [];
      for (let b = 0; b < S; b++) {
        const [s, e] = blocks[b];
        const target = isSet.has(b) ? isRets : osRets;
        for (let t = s; t < e; t++) target.push(rets[t]);
      }
      isSharpe[vI] = sharpeLike(isRets);
      osSharpe[vI] = sharpeLike(osRets);
    }
    let bestIdx = 0;
    for (let vI = 1; vI < N; vI++) if (isSharpe[vI] > isSharpe[bestIdx]) bestIdx = vI;
    const bestOS = osSharpe[bestIdx];
    let rank = 1;
    for (let vI = 0; vI < N; vI++) if (osSharpe[vI] < bestOS) rank++;
    const omega = rank / (N + 1);
    const logit = Math.log(omega / (1 - omega));
    logits.push(logit);
    if (logit <= 0) overfitCount++;
  }
  const pbo = overfitCount / isCombos.length;
  return { N, combos: isCombos.length, S, T, pbo, logits, avgPairwiseCorr, dsr: dsrResult, bestParams };
}

/* ---------- 小工具 ---------- */
const pct = (x, digits = 1) => (x == null || Number.isNaN(x) ? "—" : `${(x * 100).toFixed(digits)}%`);
const num = (x, digits = 2) => (x == null || Number.isNaN(x) ? "—" : x.toFixed(digits));
const fmtMultiple = (x) => `${x.toFixed(3)}x`;

function downsampleForChart(points, target = 480) {
  if (points.length <= target) return points;
  const stride = Math.ceil(points.length / target);
  const out = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

function computeDrawdownPct(equitySlice) {
  let peak = equitySlice[0];
  const dd = new Array(equitySlice.length);
  for (let i = 0; i < equitySlice.length; i++) {
    if (equitySlice[i] > peak) peak = equitySlice[i];
    dd[i] = ((equitySlice[i] - peak) / peak) * 100;
  }
  return dd;
}

/* ============================================================
   主元件
   ============================================================ */
export default function App() {
  // 資料為靜態內建資料（不再提供瀏覽器端上傳更新，資料更新請透過 GitHub repo 的
  // data/Stock_data_collection.xlsx + GitHub Actions 自動重新部署）
  const dataset = INITIAL_DATASET;
  const dataMeta = { source: "內建資料（Stock_data_collection.xlsx）", rowCount: RAW_DATA.length };

  const minDate = dataset.dates[0];
  const maxDate = dataset.dates[dataset.n - 1];
  // 可選擇的最早回測起始日：資料集本身可能為了讓VIX滾動視窗有足夠暖身資料而往前延伸
  // （00631L/00635U等ETF在真正上市前是佔位資料），因此「可選擇」的起始日仍鎖定在
  // DEFAULT_RANGE_START，避免使用者手動選到佔位資料那段、得出失真的權益曲線。
  const earliestSelectableDate = DEFAULT_RANGE_START >= minDate ? DEFAULT_RANGE_START : minDate;
  const [rangeStart, setRangeStart] = useState(earliestSelectableDate);
  const [rangeEnd, setRangeEnd] = useState(maxDate);

  // 草稿設定（尚未加入比較）
  const [draft, setDraft] = useState({
    name: "",
    maEnabled: true,
    maPeriod: 60,
    maBias: 20,
    maPriceBasis: "close",
    vixEnabled: true,
    vixLookback: 1000,
    vixMode: "advanced",
    vixHigh: 28,
    vixLow: 1,
    vixExtremeLow: 0.5,
    combineMode: "AND",
    bullAsset: "00631L",
    bearAsset: "00635U",
    riskFreeRate: 1.5,
    commissionRate: 0.1425,
    taxRate: 0.1,
    icWindow: 60,
  });

  const [runs, setRuns] = useState(() =>
    PRESETS.map((p) => buildRunFromConfig(INITIAL_DATASET, p.config, p.name, p.color))
  );
  const [runSeq, setRunSeq] = useState(1);
  const [benchOn, setBenchOn] = useState({ "00631L": true, "0050": true, "00635U": false });
  const [logScale, setLogScale] = useState(false);
  const [configError, setConfigError] = useState(null);

  // PBO（過擬合機率）設定與結果：可自由新增／移除多個參數維度
  const [pboParams, setPboParams] = useState([
    { key: "maPeriod", min: 20, max: 120, steps: 6 },
    { key: "vixHigh", min: 15, max: 45, steps: 6 },
  ]);
  const [pboBlocks, setPboBlocks] = useState(8);
  const [pboMaxCombos, setPboMaxCombos] = useState(200);
  const [pboResult, setPboResult] = useState(null);
  const [pboError, setPboError] = useState(null);
  const [pboRunning, setPboRunning] = useState(false);

  const rangeIdx = useMemo(() => {
    let startIdx = dataset.dates.findIndex((d) => d >= rangeStart);
    if (startIdx < 0) startIdx = 0;
    let endIdx = dataset.n - 1;
    for (let i = dataset.n - 1; i >= 0; i--) {
      if (dataset.dates[i] <= rangeEnd) {
        endIdx = i;
        break;
      }
    }
    if (endIdx < startIdx) endIdx = startIdx;
    return { startIdx, endIdx };
  }, [dataset, rangeStart, rangeEnd]);

  const handleAddRun = useCallback(() => {
    setConfigError(null);
    if (!draft.maEnabled && !draft.vixEnabled) {
      setConfigError("請至少啟用一種輪動邏輯（均線輪動 或 VIX Roll Yield 輪動）。");
      return;
    }
    if (runs.length >= MAX_RUNS) {
      setConfigError(`最多同時比較 ${MAX_RUNS} 組策略，請先刪除一組再新增。`);
      return;
    }
    const color = RUN_COLORS[runSeq % RUN_COLORS.length];
    const name = draft.name.trim() || `策略 ${runSeq}`;
    const run = buildRunFromConfig(dataset, draft, name, color, rangeIdx.endIdx);
    setRuns((prev) => [...prev, run]);
    setRunSeq((s) => s + 1);
    setDraft((d) => ({ ...d, name: "" }));
  }, [draft, dataset, runs.length, runSeq, rangeIdx]);

  const removeRun = (id) => setRuns((prev) => prev.filter((r) => r.id !== id));
  const clearAllRuns = () => { setRuns([]); setConfigError(null); };

  const addPresetRun = useCallback(
    (preset) => {
      setConfigError(null);
      if (runs.length >= MAX_RUNS) {
        setConfigError(`最多同時比較 ${MAX_RUNS} 組策略，請先刪除一組再新增。`);
        return;
      }
      const run = buildRunFromConfig(dataset, preset.config, preset.name, preset.color, rangeIdx.endIdx);
      setRuns((prev) => [...prev, run]);
    },
    [dataset, runs.length, rangeIdx]
  );

  const addAllPresets = useCallback(() => {
    setConfigError(null);
    const room = MAX_RUNS - runs.length;
    if (room <= 0) {
      setConfigError(`最多同時比較 ${MAX_RUNS} 組策略，請先刪除幾組再載入。`);
      return;
    }
    const toAdd = PRESETS.slice(0, room).map((p) => buildRunFromConfig(dataset, p.config, p.name, p.color, rangeIdx.endIdx));
    setRuns((prev) => [...prev, ...toAdd]);
  }, [dataset, runs.length, rangeIdx]);

  const addPboParam = useCallback(() => {
    const avail = getAvailableParams(draft);
    const usedKeys = new Set(pboParams.map((p) => p.key));
    const next = avail.find((p) => !usedKeys.has(p.key));
    if (!next) return;
    setPboParams((rows) => [...rows, { key: next.key, min: next.defMin, max: next.defMax, steps: 5 }]);
  }, [draft, pboParams]);

  const removePboParam = (idx) => setPboParams((rows) => rows.filter((_, i) => i !== idx));
  const updatePboParam = (idx, patch) => setPboParams((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const handlePboRun = useCallback(() => {
    setPboError(null);
    setPboResult(null);
    if (pboParams.length === 0) {
      setPboError("請至少新增一個參數。");
      return;
    }
    const keys = pboParams.map((p) => p.key);
    if (new Set(keys).size !== keys.length) {
      setPboError("參數不可重複選擇，請調整後再試一次。");
      return;
    }
    const avail = getAvailableParams(draft);
    const paramDefs = [];
    for (const row of pboParams) {
      const meta = avail.find((p) => p.key === row.key);
      if (!meta) {
        setPboError(`「${row.key}」在目前設定下不可用（例如未啟用對應的輪動邏輯），請重新選擇。`);
        return;
      }
      const values = linspace(row.min, row.max, row.steps, meta.isInt);
      paramDefs.push({ key: row.key, label: meta.label, values });
    }
    const total = paramDefs.reduce((a, p) => a * p.values.length, 1);
    const hardCap = Math.min(2000, Math.max(4, pboMaxCombos));
    if (total > hardCap) {
      setPboError(`組合數過多（目前 ${total} 組，上限 ${hardCap} 組），請減少參數數量或步數，或調高左側的組合數上限（最多 2000）。`);
      return;
    }
    if (total < 4) {
      setPboError(`候選策略數太少（目前 ${total} 組，至少需要 4 組），請增加步數、擴大範圍或新增參數。`);
      return;
    }
    setPboRunning(true);
    setTimeout(() => {
      try {
        const result = runPBOAnalysis(dataset, draft, paramDefs, pboBlocks, rangeIdx);
        setPboResult({
          ...result,
          paramLabels: paramDefs.map((p) => p.label),
          paramLabelMap: Object.fromEntries(paramDefs.map((p) => [p.key, p.label])),
        });
      } catch (err) {
        setPboError(err.message || "PBO 分析失敗，請調整設定後再試一次。");
      } finally {
        setPboRunning(false);
      }
    }, 30);
  }, [draft, pboParams, pboBlocks, pboMaxCombos, dataset, rangeIdx]);

  /* ---- 依目前日期範圍，切片＋重新正規化每個 run ＋ benchmark ---- */
  const { chartData, drawdownChartData, icChartData, tableRows, tradeTableRows, icTableRows } = useMemo(() => {
    const { startIdx, endIdx } = rangeIdx;
    const slicedDates = dataset.dates.slice(startIdx, endIdx + 1);
    const rangeStartDate = slicedDates[0];
    const rangeEndDate = slicedDates[slicedDates.length - 1];

    const series = [];
    const ddSeries = [];
    const icRollSeries = [];
    const icExpSeries = [];
    const table = [];
    const tradeTable = [];
    const icTable = [];

    for (const run of runs) {
      const sliced = sliceAndNormalize(run.equity, startIdx, endIdx);
      const ddData = computeDrawdownPct(sliced);
      let tradesInRange = 0;
      let prevAsset = null;
      for (let i = startIdx; i <= endIdx; i++) {
        const a = run.appliedAsset[i];
        if (a && prevAsset && a !== prevAsset) tradesInRange += 1;
        if (a) prevAsset = a;
      }
      const stats = computeStats(sliced, tradesInRange, run.config.riskFreeRate);
      series.push({ key: run.id, name: run.name, color: run.color, dash: false, data: sliced });
      ddSeries.push({ key: run.id, name: run.name, color: run.color, dash: false, data: ddData });
      table.push({
        id: run.id,
        name: run.name,
        color: run.color,
        isBench: false,
        lastAsset: run.lastAsset,
        ...stats,
      });

      // 交易區間分析：僅計入完整落於所選日期範圍內的持倉區間
      const tradesInWindow = run.tradeList.filter(
        (t) => t.entryDate >= rangeStartDate && t.exitDate <= rangeEndDate
      );
      const tstats = computeTradeStats(tradesInWindow);
      tradeTable.push({ id: run.id, name: run.name, color: run.color, ...tstats });

      // IC / IR 分析
      const icRollSliced = sliceRaw(run.icRolling, startIdx, endIdx);
      const icExpSliced = sliceRaw(run.icExpanding, startIdx, endIdx);
      icRollSeries.push({ key: run.id, name: run.name, color: run.color, dash: false, data: icRollSliced });
      icExpSeries.push({ key: run.id, name: run.name, color: run.color, dash: false, data: icExpSliced });
      const validIC = icRollSliced.filter((v) => v != null);
      let icMean = null, icStd = null, ir = null;
      if (validIC.length > 1) {
        icMean = validIC.reduce((a, b) => a + b, 0) / validIC.length;
        const icVar = validIC.reduce((a, b) => a + (b - icMean) * (b - icMean), 0) / validIC.length;
        icStd = Math.sqrt(icVar);
        ir = icStd > 0 ? icMean / icStd : null;
      }
      let icExpFinal = null;
      for (let i = icExpSliced.length - 1; i >= 0; i--) {
        if (icExpSliced[i] != null) { icExpFinal = icExpSliced[i]; break; }
      }
      icTable.push({ id: run.id, name: run.name, color: run.color, icMean, icStd, ir, icExpFinal });
    }

    for (const assetKey of Object.keys(benchOn)) {
      if (!benchOn[assetKey]) continue;
      const bh = buyHoldCurve(dataset, assetKey);
      const sliced = sliceAndNormalize(bh, startIdx, endIdx);
      const ddData = computeDrawdownPct(sliced);
      const stats = computeStats(sliced, 0, 1.5);
      series.push({
        key: `bh_${assetKey}`,
        name: `Buy & Hold ${ASSET_SHORT[assetKey]}`,
        color: BENCH_COLORS[assetKey],
        dash: true,
        data: sliced,
      });
      ddSeries.push({
        key: `bh_${assetKey}`,
        name: `Buy & Hold ${ASSET_SHORT[assetKey]}`,
        color: BENCH_COLORS[assetKey],
        dash: true,
        data: ddData,
      });
      table.push({
        id: `bh_${assetKey}`,
        name: `Buy & Hold ${ASSET_SHORT[assetKey]}`,
        color: BENCH_COLORS[assetKey],
        isBench: true,
        lastAsset: assetKey,
        ...stats,
      });
    }

    // 組合成 recharts 需要的格式：[{date, seriesKey1: v, seriesKey2: v, ...}]
    const buildPoints = (seriesArr) =>
      slicedDates.map((d, i) => {
        const point = { date: d };
        for (const s of seriesArr) point[s.key] = s.data[i];
        return point;
      });
    const chartPoints = downsampleForChart(buildPoints(series), 480);
    const ddPoints = downsampleForChart(buildPoints(ddSeries), 480);
    const icRollPoints = downsampleForChart(buildPoints(icRollSeries), 480);
    const icExpPoints = downsampleForChart(buildPoints(icExpSeries), 480);

    return {
      chartData: { points: chartPoints, series },
      drawdownChartData: { points: ddPoints, series: ddSeries },
      icChartData: {
        rollingPoints: icRollPoints,
        rollingSeries: icRollSeries,
        expandingPoints: icExpPoints,
        expandingSeries: icExpSeries,
      },
      tableRows: table,
      tradeTableRows: tradeTable,
      icTableRows: icTable,
    };
  }, [runs, benchOn, dataset, rangeIdx]);


  const S = THEME;

  return (
    <div style={{ background: S.bg, color: S.text, minHeight: "100%", fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif" }}>
      <style>{`
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.6); }
        input[type="number"], input[type="date"], input[type="text"] {
          background: ${S.panelAlt}; border: 1px solid ${S.border}; color: ${S.text};
          border-radius: 4px; padding: 5px 8px; font-size: 13px; width: 100%;
          font-variant-numeric: tabular-nums;
        }
        input[type="number"]:focus, input[type="date"]:focus, input[type="text"]:focus {
          outline: none; border-color: ${S.teal};
        }
        .mono { font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace; font-variant-numeric: tabular-nums; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background: ${S.border}; border-radius: 4px; }
        .chk { accent-color: ${S.teal}; }
        button:focus-visible, input:focus-visible { outline: 2px solid ${S.teal}; outline-offset: 1px; }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: `1px solid ${S.border}`, padding: "18px 24px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
              台股輪動策略回測工作台 <span style={{ fontSize: 12, fontWeight: 500, color: S.textFaint }}>v2</span>
            </h1>
            <p style={{ fontSize: 13, color: S.textMuted, margin: "4px 0 0" }}>
              VIX Roll Yield ／ 0050 均線乖離率 輪動邏輯・可自由調參數並排比較・已預載 5 組每日追蹤儀表板預設策略
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="mono" style={{ fontSize: 12, color: S.textMuted }}>
              {dataMeta.source}
            </div>
            <div className="mono" style={{ fontSize: 12, color: S.textFaint }}>
              {dataset.dates[0]} ～ {dataset.dates[dataset.n - 1]} ・ {dataMeta.rowCount} 個交易日
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 0 }} className="lg-row">
        <div style={{ display: "flex", flexWrap: "wrap" }}>
          {/* 側邊參數面板 */}
          <div style={{ width: 340, maxWidth: "100%", borderRight: `1px solid ${S.border}`, padding: 20 }}>
            <SectionLabel text="預設策略（每日追蹤儀表板）" />
            <HintText text="對應「台股波動率輪換策略儀表板」每日追蹤的 5 種持倉策略，開啟頁面時已自動載入下方比較清單；可個別刪除，或用下方按鈕重新套用單一策略／全部套用。" />
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8, marginBottom: 8 }}>
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => addPresetRun(p)}
                  disabled={runs.length >= MAX_RUNS}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    background: S.panelAlt,
                    border: `1px solid ${S.border}`,
                    borderRadius: 4,
                    padding: "7px 10px",
                    fontSize: 12,
                    color: S.text,
                    textAlign: "left",
                    cursor: runs.length >= MAX_RUNS ? "default" : "pointer",
                    opacity: runs.length >= MAX_RUNS ? 0.5 : 1,
                  }}
                >
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: p.color, flexShrink: 0 }} />
                  {p.name}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
              <button
                onClick={addAllPresets}
                style={{
                  flex: 1,
                  background: "transparent",
                  border: `1px solid ${S.border}`,
                  color: S.textMuted,
                  borderRadius: 4,
                  padding: "6px 8px",
                  fontSize: 11.5,
                  cursor: "pointer",
                }}
              >
                全部套用
              </button>
              <button
                onClick={clearAllRuns}
                style={{
                  flex: 1,
                  background: "transparent",
                  border: `1px solid ${S.border}`,
                  color: S.textMuted,
                  borderRadius: 4,
                  padding: "6px 8px",
                  fontSize: 11.5,
                  cursor: "pointer",
                }}
              >
                清空比較清單
              </button>
            </div>

            <SectionLabel text="回測期間" />
            <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
              <div style={{ flex: 1 }}>
                <FieldLabel text="起" />
                <input type="date" value={rangeStart} min={earliestSelectableDate} max={rangeEnd} onChange={(e) => setRangeStart(e.target.value)} />
              </div>
              <div style={{ flex: 1 }}>
                <FieldLabel text="迄" />
                <input type="date" value={rangeEnd} min={rangeStart} max={maxDate} onChange={(e) => setRangeEnd(e.target.value)} />
              </div>
            </div>

            <SectionLabel text="① 均線輪動（0050 SMA + 乖離率）" />
            <ToggleRow
              checked={draft.maEnabled}
              onChange={(v) => setDraft((d) => ({ ...d, maEnabled: v }))}
              label="啟用均線輪動"
            />
            {draft.maEnabled && (
              <div style={{ marginBottom: 18, paddingLeft: 2 }}>
                <TwoCol>
                  <div>
                    <FieldLabel text="均線天數" />
                    <input type="number" value={draft.maPeriod} min={5} max={240} onChange={(e) => setDraft((d) => ({ ...d, maPeriod: Number(e.target.value) }))} />
                  </div>
                  <div>
                    <FieldLabel text="乖離率門檻 (%)" />
                    <input type="number" value={draft.maBias} min={0} max={100} step={1} onChange={(e) => setDraft((d) => ({ ...d, maBias: Number(e.target.value) }))} />
                  </div>
                </TwoCol>
                <div style={{ marginTop: 8 }}>
                  <FieldLabel text="均線計算基準" />
                  <div style={{ display: "flex", gap: 14, marginTop: 4 }}>
                    <RadioLabel
                      checked={draft.maPriceBasis === "close"}
                      onChange={() => setDraft((d) => ({ ...d, maPriceBasis: "close" }))}
                      label="收盤價（MA Rotation）"
                    />
                    <RadioLabel
                      checked={draft.maPriceBasis === "open"}
                      onChange={() => setDraft((d) => ({ ...d, maPriceBasis: "open" }))}
                      label="當日開盤價（MA Rotation II）"
                    />
                  </div>
                </div>
                <HintText
                  text={
                    draft.maPriceBasis === "open"
                      ? `規則：均線＝(當日開盤 + 前${draft.maPeriod - 1}日收盤)/${draft.maPeriod}；當日開盤 > 均線 且 乖離 < ${draft.maBias}% → 多方；其餘 → 空方（可於當日開盤時即取得訊號）`
                      : `規則：收盤 > ${draft.maPeriod}日均線 且 乖離 < ${draft.maBias}% → 多方；其餘 → 空方`
                  }
                />
              </div>
            )}

            <SectionLabel text="② VIX Roll Yield 輪動（VX30:VIX）" />
            <ToggleRow
              checked={draft.vixEnabled}
              onChange={(v) => setDraft((d) => ({ ...d, vixEnabled: v }))}
              label="啟用 VIX 輪動"
            />
            {draft.vixEnabled && (
              <div style={{ marginBottom: 18, paddingLeft: 2 }}>
                <FieldLabel text="滾動視窗（交易日，約 4 年 = 1008）" />
                <input type="number" value={draft.vixLookback} min={60} max={2500} step={10} onChange={(e) => setDraft((d) => ({ ...d, vixLookback: Number(e.target.value) }))} />
                <div style={{ marginTop: 10 }}>
                  <FieldLabel text="門檻模式" />
                  <div style={{ display: "flex", gap: 14, marginTop: 4 }}>
                    <RadioLabel
                      checked={draft.vixMode === "advanced"}
                      onChange={() => setDraft((d) => ({ ...d, vixMode: "advanced" }))}
                      label="進階（三門檻＋慣性區）"
                    />
                    <RadioLabel
                      checked={draft.vixMode === "simple"}
                      onChange={() => setDraft((d) => ({ ...d, vixMode: "simple" }))}
                      label="簡單（單一門檻）"
                    />
                  </div>
                </div>
                <div style={{ marginTop: 10 }}>
                  <FieldLabel text="高分位門檻（%）— 高於此 → 多方" />
                  <input type="number" value={draft.vixHigh} min={0} max={100} step={0.5} onChange={(e) => setDraft((d) => ({ ...d, vixHigh: Number(e.target.value) }))} />
                </div>
                {draft.vixMode === "advanced" && (
                  <>
                    <TwoCol>
                      <div>
                        <FieldLabel text="低分位（慣性起點）%" />
                        <input type="number" value={draft.vixLow} min={0} max={100} step={0.1} onChange={(e) => setDraft((d) => ({ ...d, vixLow: Number(e.target.value) }))} />
                      </div>
                      <div>
                        <FieldLabel text="極低分位（谷底翻多）%" />
                        <input type="number" value={draft.vixExtremeLow} min={0} max={100} step={0.1} onChange={(e) => setDraft((d) => ({ ...d, vixExtremeLow: Number(e.target.value) }))} />
                      </div>
                    </TwoCol>
                    <HintText text={`規則：RollYield > 高分位 → 多方；< 極低分位 → 多方（谷底反轉）；介於極低～低分位 → 沿用前日；其餘 → 空方`} />
                  </>
                )}
                {draft.vixMode === "simple" && <HintText text={`規則：RollYield > 高分位 → 多方；其餘 → 空方`} />}
              </div>
            )}

            {draft.maEnabled && draft.vixEnabled && (
              <>
                <SectionLabel text="訊號合併方式" />
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8 }}>
                  <RadioLabel checked={draft.combineMode === "AND"} onChange={() => setDraft((d) => ({ ...d, combineMode: "AND" }))} label="AND（同時多方才多）" />
                  <RadioLabel checked={draft.combineMode === "OR"} onChange={() => setDraft((d) => ({ ...d, combineMode: "OR" }))} label="OR（任一多方即多）" />
                  <RadioLabel checked={draft.combineMode === "HOLD"} onChange={() => setDraft((d) => ({ ...d, combineMode: "HOLD" }))} label="訊號一致才切換，分歧則維持前一日訊號（不輪動）" />
                </div>
                {draft.combineMode === "HOLD" && (
                  <HintText text="規則：均線與VIX訊號相同 → 採用該訊號；兩者不同 → 沿用前一日已解析出的最終訊號，當日不換倉（回測起點若一開始就分歧，預設以空方起始）。" />
                )}
                <div style={{ marginBottom: 10 }} />
              </>
            )}

            <SectionLabel text="資產配對" />
            <TwoCol>
              <div>
                <FieldLabel text="多方持有" />
                <select value={draft.bullAsset} onChange={(e) => setDraft((d) => ({ ...d, bullAsset: e.target.value }))} style={selectStyle(S)}>
                  {ASSET_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {ASSET_SHORT[k]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <FieldLabel text="空方持有" />
                <select value={draft.bearAsset} onChange={(e) => setDraft((d) => ({ ...d, bearAsset: e.target.value }))} style={selectStyle(S)}>
                  {ASSET_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {ASSET_SHORT[k]}
                    </option>
                  ))}
                </select>
              </div>
            </TwoCol>
            <SectionLabel text="交易成本（輪動時以開盤價成交）" />
            <TwoCol>
              <div>
                <FieldLabel text="手續費率（%，買賣各計一次）" />
                <input type="number" value={draft.commissionRate} min={0} max={5} step={0.01} onChange={(e) => setDraft((d) => ({ ...d, commissionRate: Number(e.target.value) }))} />
              </div>
              <div>
                <FieldLabel text="證交稅率（%，僅賣出計）" />
                <input type="number" value={draft.taxRate} min={0} max={5} step={0.01} onChange={(e) => setDraft((d) => ({ ...d, taxRate: Number(e.target.value) }))} />
              </div>
            </TwoCol>
            <HintText text="輪動當天：舊標的以「前收→當日開盤」計隔夜報酬並於開盤扣賣出成本，新標的於開盤買進扣手續費後，計「開盤→當日收盤」報酬；未輪動的日子維持一般收盤對收盤報酬、不產生成本。" />

            <div style={{ marginTop: 14, marginBottom: 18 }}>
              <FieldLabel text="無風險利率（年化 %，供 Sharpe/Sortino 使用）" />
              <input type="number" value={draft.riskFreeRate} step={0.1} onChange={(e) => setDraft((d) => ({ ...d, riskFreeRate: Number(e.target.value) }))} />
            </div>

            <div style={{ marginBottom: 18 }}>
              <FieldLabel text="IC 滾動視窗（交易日，供資訊係數分析使用）" />
              <input type="number" value={draft.icWindow} min={20} max={500} step={5} onChange={(e) => setDraft((d) => ({ ...d, icWindow: Number(e.target.value) }))} />
            </div>

            <SectionLabel text="策略名稱（選填）" />
            <input
              type="text"
              placeholder={`策略 ${runSeq}`}
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              style={{ marginBottom: 12 }}
            />

            {configError && <div style={{ color: S.rose, fontSize: 12, marginBottom: 10 }}>{configError}</div>}

            <button
              onClick={handleAddRun}
              style={{
                width: "100%",
                background: S.teal,
                color: "#08130f",
                border: "none",
                borderRadius: 4,
                padding: "9px 12px",
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <Plus size={15} /> 加入比較
            </button>

            {runs.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <SectionLabel text={`已加入策略（${runs.length}/${MAX_RUNS}）`} />
                {runs.map((r) => (
                  <div
                    key={r.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "6px 8px",
                      background: S.panelAlt,
                      border: `1px solid ${S.border}`,
                      borderRadius: 4,
                      marginBottom: 6,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 2, background: r.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
                    </div>
                    <button
                      onClick={() => removeRun(r.id)}
                      style={{ background: "transparent", border: "none", color: S.textFaint, cursor: "pointer", padding: 2 }}
                      aria-label={`刪除 ${r.name}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 18 }}>
              <SectionLabel text="對照組（Buy & Hold）" />
              {Object.keys(benchOn).map((k) => (
                <label key={k} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, marginBottom: 6, cursor: "pointer", color: S.textMuted }}>
                  <input className="chk" type="checkbox" checked={benchOn[k]} onChange={(e) => setBenchOn((b) => ({ ...b, [k]: e.target.checked }))} />
                  {ASSET_SHORT[k]}
                </label>
              ))}
            </div>

            <div style={{ marginTop: 22, paddingTop: 16, borderTop: `1px solid ${S.border}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                <FlaskConical size={13} color={S.textMuted} />
                <SectionLabel text="過擬合機率分析 (PBO)" />
              </div>
              <HintText text="以目前左側設定為基礎，自動變動所選參數產生一組候選策略網格，用 Combinatorially Symmetric Cross-Validation（CSCV）估計回測過擬合機率。網格總組合數上限可自行調整（最多 2000），數字越大運算越久。" />
              {pboParams.map((row, idx) => {
                const avail = getAvailableParams(draft);
                const usedElsewhere = new Set(pboParams.filter((_, i) => i !== idx).map((r) => r.key));
                const options = avail.filter((p) => !usedElsewhere.has(p.key) || p.key === row.key);
                return (
                  <div key={idx} style={{ marginTop: 10, padding: 8, background: S.panelAlt, border: `1px solid ${S.border}`, borderRadius: 4 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                      <FieldLabel text={`參數 ${idx + 1}`} />
                      {pboParams.length > 1 && (
                        <button
                          onClick={() => removePboParam(idx)}
                          style={{ background: "transparent", border: "none", color: S.textFaint, cursor: "pointer", padding: 2 }}
                          aria-label="移除參數"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                    <select
                      value={row.key}
                      onChange={(e) => {
                        const meta = avail.find((p) => p.key === e.target.value);
                        updatePboParam(idx, { key: e.target.value, min: meta?.defMin ?? row.min, max: meta?.defMax ?? row.max });
                      }}
                      style={selectStyle(S)}
                    >
                      {options.map((p) => (
                        <option key={p.key} value={p.key}>{p.label}</option>
                      ))}
                    </select>
                    <TwoCol>
                      <div>
                        <FieldLabel text="最小值" />
                        <input type="number" value={row.min} onChange={(e) => updatePboParam(idx, { min: Number(e.target.value) })} />
                      </div>
                      <div>
                        <FieldLabel text="最大值" />
                        <input type="number" value={row.max} onChange={(e) => updatePboParam(idx, { max: Number(e.target.value) })} />
                      </div>
                      <div>
                        <FieldLabel text="步數" />
                        <input type="number" value={row.steps} min={2} max={20} onChange={(e) => updatePboParam(idx, { steps: Number(e.target.value) })} />
                      </div>
                    </TwoCol>
                  </div>
                );
              })}
              <button
                onClick={addPboParam}
                disabled={pboParams.length >= 6 || pboParams.length >= getAvailableParams(draft).length}
                style={{
                  marginTop: 8,
                  width: "100%",
                  background: "transparent",
                  border: `1px dashed ${S.border}`,
                  color: S.textMuted,
                  borderRadius: 4,
                  padding: "6px 10px",
                  fontSize: 12,
                  cursor: pboParams.length >= 6 ? "default" : "pointer",
                  opacity: pboParams.length >= 6 || pboParams.length >= getAvailableParams(draft).length ? 0.5 : 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                <Plus size={12} /> 新增參數
              </button>
              <div style={{ marginTop: 14, marginBottom: 10 }}>
                <FieldLabel text="區塊數 S（CSCV 切分數，須為偶數）" />
                <select value={pboBlocks} onChange={(e) => setPboBlocks(Number(e.target.value))} style={selectStyle(S)}>
                  <option value={6}>6（C(6,3)=20 組合）</option>
                  <option value={8}>8（C(8,4)=70 組合）</option>
                  <option value={10}>10（C(10,5)=252 組合）</option>
                  <option value={12}>12（C(12,6)=924 組合）</option>
                </select>
              </div>
              <div style={{ marginBottom: 10 }}>
                <FieldLabel text="組合數上限（可自行調整，最多 2000）" />
                <input
                  type="number"
                  value={pboMaxCombos}
                  min={4}
                  max={2000}
                  step={10}
                  onChange={(e) => setPboMaxCombos(Math.min(2000, Math.max(4, Number(e.target.value))))}
                />
              </div>
              {(() => {
                const estN = pboParams.reduce((a, p) => a * Math.max(1, Math.round(p.steps)), 1);
                const comboMap = { 6: 20, 8: 70, 10: 252, 12: 924 };
                const estSplits = comboMap[pboBlocks] || 70;
                const estSeconds = 2.5 + (estN * estSplits) / 46000;
                const warn = estSeconds > 8;
                return (
                  <div style={{ fontSize: 11, color: warn ? S.rose : S.textFaint, marginBottom: 12, lineHeight: 1.5 }}>
                    預估候選策略數 ≈ {estN} 組（實際值依步數取整與去重而定）・CSCV 切分數 = {estSplits}・
                    預估運算時間 ≈ {estSeconds < 1 ? "< 1" : Math.ceil(estSeconds)} 秒
                    {warn ? "（組合數較大，運算期間畫面會暫時無法互動，請耐心等候）" : ""}
                  </div>
                );
              })()}
              {pboError && <div style={{ color: S.rose, fontSize: 12, marginBottom: 10 }}>{pboError}</div>}
              <button
                onClick={handlePboRun}
                disabled={pboRunning}
                style={{
                  width: "100%",
                  background: pboRunning ? S.panelAlt : S.gold,
                  color: pboRunning ? S.textMuted : "#241a0a",
                  border: pboRunning ? `1px solid ${S.border}` : "none",
                  borderRadius: 4,
                  padding: "9px 12px",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: pboRunning ? "default" : "pointer",
                }}
              >
                {pboRunning ? "運算中…（依網格大小可能需要數秒）" : "執行 PBO 分析"}
              </button>
            </div>
          </div>

          {/* 主內容區 */}
          <div style={{ flex: 1, minWidth: 320, padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <TrendingUp size={15} color={S.textMuted} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>權益曲線（期初 = 1.0）</span>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: S.textMuted, cursor: "pointer" }}>
                <input className="chk" type="checkbox" checked={logScale} onChange={(e) => setLogScale(e.target.checked)} />
                對數座標
              </label>
            </div>

            <div style={{ background: S.panel, border: `1px solid ${S.border}`, borderRadius: 6, padding: "12px 8px 4px" }}>
              {chartData.series.length === 0 ? (
                <EmptyState S={S} />
              ) : (
                <ResponsiveContainer width="100%" height={420}>
                  <LineChart data={chartData.points} margin={{ top: 6, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={S.borderSoft} vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: S.textFaint }}
                      minTickGap={40}
                      stroke={S.border}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: S.textFaint }}
                      stroke={S.border}
                      scale={logScale ? "log" : "linear"}
                      domain={logScale ? ["auto", "auto"] : [0, "auto"]}
                      tickFormatter={(v) => v.toFixed(1) + "x"}
                      width={44}
                    />
                    <Tooltip
                      contentStyle={{ background: S.panelAlt, border: `1px solid ${S.border}`, borderRadius: 4, fontSize: 11 }}
                      labelStyle={{ color: S.textMuted }}
                      formatter={(v, n) => [fmtMultiple(v), n]}
                    />
                    <Legend wrapperStyle={{ fontSize: 11, color: S.textMuted }} />
                    {chartData.series.map((s) => (
                      <Line
                        key={s.key}
                        type="monotone"
                        dataKey={s.key}
                        name={s.name}
                        stroke={s.color}
                        strokeWidth={s.dash ? 1.3 : 1.8}
                        strokeDasharray={s.dash ? "4 3" : undefined}
                        dot={false}
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 22, marginBottom: 10 }}>
              <TrendingDown size={15} color={S.textMuted} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>回撤曲線（相對於歷史高點，%）</span>
            </div>
            <div style={{ background: S.panel, border: `1px solid ${S.border}`, borderRadius: 6, padding: "12px 8px 4px" }}>
              {drawdownChartData.series.length === 0 ? (
                <EmptyState S={S} />
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={drawdownChartData.points} margin={{ top: 6, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={S.borderSoft} vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: S.textFaint }} minTickGap={40} stroke={S.border} />
                    <YAxis
                      tick={{ fontSize: 10, fill: S.textFaint }}
                      stroke={S.border}
                      domain={["auto", 0]}
                      tickFormatter={(v) => v.toFixed(0) + "%"}
                      width={44}
                    />
                    <Tooltip
                      contentStyle={{ background: S.panelAlt, border: `1px solid ${S.border}`, borderRadius: 4, fontSize: 11 }}
                      labelStyle={{ color: S.textMuted }}
                      formatter={(v, n) => [`${v.toFixed(2)}%`, n]}
                    />
                    <Legend wrapperStyle={{ fontSize: 11, color: S.textMuted }} />
                    {drawdownChartData.series.map((s) => (
                      <Area
                        key={s.key}
                        type="monotone"
                        dataKey={s.key}
                        name={s.name}
                        stroke={s.color}
                        fill={s.color}
                        fillOpacity={0.14}
                        strokeWidth={s.dash ? 1.1 : 1.5}
                        strokeDasharray={s.dash ? "4 3" : undefined}
                        dot={false}
                        isAnimationActive={false}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 22, marginBottom: 10 }}>
              <Activity size={15} color={S.textMuted} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>資訊係數 (IC) 分析 — 訊號方向 vs. 隔日多空價差報酬</span>
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 320px", minWidth: 280 }}>
                <div style={{ fontSize: 11, color: S.textFaint, marginBottom: 6 }}>滾動 IC（視窗＝{draft.icWindow} 個交易日）</div>
                <div style={{ background: S.panel, border: `1px solid ${S.border}`, borderRadius: 6, padding: "10px 8px 4px" }}>
                  {icChartData.rollingSeries.length === 0 ? (
                    <EmptyState S={S} />
                  ) : (
                    <ResponsiveContainer width="100%" height={220}>
                      <LineChart data={icChartData.rollingPoints} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
                        <CartesianGrid stroke={S.borderSoft} vertical={false} />
                        <XAxis dataKey="date" tick={{ fontSize: 9, fill: S.textFaint }} minTickGap={50} stroke={S.border} />
                        <YAxis tick={{ fontSize: 9, fill: S.textFaint }} stroke={S.border} domain={[-1, 1]} width={32} />
                        <Tooltip
                          contentStyle={{ background: S.panelAlt, border: `1px solid ${S.border}`, borderRadius: 4, fontSize: 11 }}
                          labelStyle={{ color: S.textMuted }}
                          formatter={(v, n) => [v == null ? "—" : v.toFixed(3), n]}
                        />
                        {icChartData.rollingSeries.map((s) => (
                          <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={1.4} dot={false} isAnimationActive={false} connectNulls />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>
              <div style={{ flex: "1 1 320px", minWidth: 280 }}>
                <div style={{ fontSize: 11, color: S.textFaint, marginBottom: 6 }}>累計（擴張視窗）IC</div>
                <div style={{ background: S.panel, border: `1px solid ${S.border}`, borderRadius: 6, padding: "10px 8px 4px" }}>
                  {icChartData.expandingSeries.length === 0 ? (
                    <EmptyState S={S} />
                  ) : (
                    <ResponsiveContainer width="100%" height={220}>
                      <LineChart data={icChartData.expandingPoints} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
                        <CartesianGrid stroke={S.borderSoft} vertical={false} />
                        <XAxis dataKey="date" tick={{ fontSize: 9, fill: S.textFaint }} minTickGap={50} stroke={S.border} />
                        <YAxis tick={{ fontSize: 9, fill: S.textFaint }} stroke={S.border} domain={[-1, 1]} width={32} />
                        <Tooltip
                          contentStyle={{ background: S.panelAlt, border: `1px solid ${S.border}`, borderRadius: 4, fontSize: 11 }}
                          labelStyle={{ color: S.textMuted }}
                          formatter={(v, n) => [v == null ? "—" : v.toFixed(3), n]}
                        />
                        {icChartData.expandingSeries.map((s) => (
                          <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={1.4} dot={false} isAnimationActive={false} connectNulls />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>
            </div>

            <div style={{ overflowX: "auto", border: `1px solid ${S.border}`, borderRadius: 6, marginTop: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }} className="mono">
                <thead>
                  <tr style={{ background: S.panelAlt, textAlign: "right" }}>
                    <Th align="left">策略</Th>
                    <Th>平均滾動IC</Th>
                    <Th>IC標準差</Th>
                    <Th>IR (IC均值/IC標準差)</Th>
                    <Th>期末累計IC</Th>
                  </tr>
                </thead>
                <tbody>
                  {icTableRows.length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ padding: 16, textAlign: "center", color: S.textFaint, fontFamily: "ui-sans-serif" }}>
                        尚未加入任何策略。
                      </td>
                    </tr>
                  )}
                  {icTableRows.map((row) => (
                    <tr key={row.id} style={{ borderTop: `1px solid ${S.borderSoft}` }}>
                      <Td align="left">
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "ui-sans-serif" }}>
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: row.color, display: "inline-block" }} />
                          {row.name}
                        </span>
                      </Td>
                      <Td colorize value={row.icMean} S={S}>{row.icMean == null ? "—" : num(row.icMean, 3)}</Td>
                      <Td>{row.icStd == null ? "—" : num(row.icStd, 3)}</Td>
                      <Td colorize value={row.ir} S={S}>{row.ir == null ? "—" : num(row.ir, 2)}</Td>
                      <Td colorize value={row.icExpFinal} S={S}>{row.icExpFinal == null ? "—" : num(row.icExpFinal, 3)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 22, marginBottom: 8, fontSize: 13, fontWeight: 600 }}>整體績效</div>
            <div style={{ overflowX: "auto", border: `1px solid ${S.border}`, borderRadius: 6 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }} className="mono">
                <thead>
                  <tr style={{ background: S.panelAlt, textAlign: "right" }}>
                    <Th align="left">策略</Th>
                    <Th align="left">最新持倉</Th>
                    <Th>期間報酬</Th>
                    <Th>CAGR</Th>
                    <Th>年化波動</Th>
                    <Th>Sharpe</Th>
                    <Th>Sortino</Th>
                    <Th>最大回撤</Th>
                    <Th>Ulcer Index</Th>
                    <Th>UPI</Th>
                    <Th>Calmar</Th>
                    <Th>日勝率</Th>
                    <Th>換手次數</Th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.length === 0 && (
                    <tr>
                      <td colSpan={13} style={{ padding: 16, textAlign: "center", color: S.textFaint, fontFamily: "ui-sans-serif" }}>
                        尚未加入任何策略或對照組。
                      </td>
                    </tr>
                  )}
                  {tableRows.map((row) => (
                    <tr key={row.id} style={{ borderTop: `1px solid ${S.borderSoft}` }}>
                      <Td align="left">
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "ui-sans-serif" }}>
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: row.color, display: "inline-block" }} />
                          {row.name}
                        </span>
                      </Td>
                      <Td align="left">{row.isBench ? ASSET_SHORT[row.lastAsset] : row.lastAsset ? ASSET_SHORT[row.lastAsset] : "—"}</Td>
                      <Td colorize value={row.totalReturn} S={S}>
                        {pct(row.totalReturn)}
                      </Td>
                      <Td colorize value={row.cagr} S={S}>
                        {pct(row.cagr)}
                      </Td>
                      <Td>{pct(row.annualVol)}</Td>
                      <Td>{num(row.sharpe)}</Td>
                      <Td>{row.sortino == null ? "—" : num(row.sortino)}</Td>
                      <Td colorize value={row.maxDD} S={S}>
                        {pct(row.maxDD)}
                      </Td>
                      <Td>{num(row.ulcerIndex)}</Td>
                      <Td>{row.upi == null ? "—" : num(row.upi)}</Td>
                      <Td>{row.calmar == null ? "—" : num(row.calmar)}</Td>
                      <Td>{pct(row.winRate)}</Td>
                      <Td>{row.trades}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 22, marginBottom: 8, fontSize: 13, fontWeight: 600 }}>交易分析（依每次輪動的持倉區間）</div>
            <div style={{ overflowX: "auto", border: `1px solid ${S.border}`, borderRadius: 6 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }} className="mono">
                <thead>
                  <tr style={{ background: S.panelAlt, textAlign: "right" }}>
                    <Th align="left">策略</Th>
                    <Th>交易筆數</Th>
                    <Th>勝率</Th>
                    <Th>平均獲利</Th>
                    <Th>平均虧損</Th>
                    <Th>賠率(P/L)</Th>
                    <Th>期望值</Th>
                  </tr>
                </thead>
                <tbody>
                  {tradeTableRows.length === 0 && (
                    <tr>
                      <td colSpan={7} style={{ padding: 16, textAlign: "center", color: S.textFaint, fontFamily: "ui-sans-serif" }}>
                        尚未加入任何策略。
                      </td>
                    </tr>
                  )}
                  {tradeTableRows.map((row) => (
                    <tr key={row.id} style={{ borderTop: `1px solid ${S.borderSoft}` }}>
                      <Td align="left">
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "ui-sans-serif" }}>
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: row.color, display: "inline-block" }} />
                          {row.name}
                        </span>
                      </Td>
                      <Td>{row.tradeCount}</Td>
                      <Td>{pct(row.winRate)}</Td>
                      <Td colorize value={row.avgWin} S={S}>
                        {pct(row.avgWin)}
                      </Td>
                      <Td colorize value={row.avgLoss} S={S}>
                        {pct(row.avgLoss)}
                      </Td>
                      <Td>{row.plRatio == null ? "—" : num(row.plRatio)}</Td>
                      <Td colorize value={row.expectancy} S={S}>
                        {pct(row.expectancy)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {(pboResult || pboRunning) && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 22, marginBottom: 10 }}>
                  <FlaskConical size={15} color={S.textMuted} />
                  <span style={{ fontSize: 13, fontWeight: 600 }}>過擬合機率分析結果 (PBO)</span>
                </div>
                {pboRunning && (
                  <div style={{ background: S.panel, border: `1px solid ${S.border}`, borderRadius: 6, padding: 16, fontSize: 12, color: S.textFaint }}>
                    運算中…
                  </div>
                )}
                {pboResult && !pboRunning && (
                  <div style={{ background: S.panel, border: `1px solid ${S.border}`, borderRadius: 6, padding: 16 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginBottom: 14 }}>
                      <StatBlock S={S} label="PBO（過擬合機率）" value={pct(pboResult.pbo, 1)} big highlight={pboResult.pbo >= 0.5 ? "rose" : pboResult.pbo >= 0.2 ? "gold" : "teal"} />
                      <StatBlock S={S} label="候選策略數 N" value={String(pboResult.N)} />
                      <StatBlock S={S} label="CSCV 組合數" value={String(pboResult.combos)} />
                      <StatBlock S={S} label="區塊數 S" value={String(pboResult.S)} />
                      <StatBlock S={S} label="樣本長度" value={`${pboResult.T} 個交易日`} />
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginBottom: 14, paddingTop: 14, borderTop: `1px solid ${S.borderSoft}` }}>
                      <StatBlock
                        S={S}
                        label="候選策略平均相關係數"
                        value={pboResult.avgPairwiseCorr == null ? "—" : num(pboResult.avgPairwiseCorr, 3)}
                        highlight={pboResult.avgPairwiseCorr != null && pboResult.avgPairwiseCorr >= 0.85 ? "gold" : null}
                      />
                      <StatBlock
                        S={S}
                        label="DSR（Deflated Sharpe Ratio）"
                        value={pboResult.dsr.dsr == null ? "—" : pct(pboResult.dsr.dsr, 1)}
                        highlight={pboResult.dsr.dsr == null ? null : pboResult.dsr.dsr >= 0.95 ? "teal" : pboResult.dsr.dsr >= 0.5 ? "gold" : "rose"}
                      />
                      <StatBlock S={S} label="搜索後最佳 Sharpe（日）" value={num(pboResult.dsr.srHat, 3)} />
                      <StatBlock S={S} label="純運氣預期最大 Sharpe（日）" value={num(pboResult.dsr.expectedMaxSR, 3)} />
                    </div>
                    <div style={{ fontSize: 12, color: S.textMuted, marginBottom: 14 }}>
                      網格參數：{pboResult.paramLabels.join(" × ")}・最佳參數組合：
                      {Object.entries(pboResult.bestParams)
                        .map(([k, v]) => `${pboResult.paramLabelMap[k] || k}=${v}`)
                        .join("、")}
                      <br />
                      PBO 解讀：越接近 0 代表樣本內表現最佳的參數組合，在樣本外仍傾向表現良好；PBO ≥ 50% 代表樣本內最佳組合在樣本外有一半以上機率落後中位數（過擬合風險高）。
                      <br />
                      候選策略平均相關係數解讀：越接近 1，代表這組網格裡的候選策略大多是彼此高度相似的變體，此時 PBO 的高低較可能只反映候選集合本身的相關結構，未必等於真實過擬合風險的變化，建議搭配 DSR 一起判讀。
                      <br />
                      DSR 解讀：這是「扣掉搜索了 N 組參數所帶來的多重比較效應」後，該組最佳策略的真實 Sharpe 仍優於純運氣水準的機率——DSR ≥ 95% 信心較高；50%~95% 證據尚不足以排除運氣；低於 50% 代表最佳策略的表現很可能只是搜索出來的運氣，即使 PBO 本身數字不高也應提高警覺。
                    </div>
                    <div style={{ fontSize: 11, color: S.textFaint, marginBottom: 6 }}>
                      logit(λ) 分布（每個 CSCV 切分得到一個值；λ ≤ 0 記為一次「過擬合」事件，以紅色標示）
                    </div>
                    <ResponsiveContainer width="100%" height={180}>
                      <BarChart data={histogram(pboResult.logits, 14)} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
                        <CartesianGrid stroke={S.borderSoft} vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 9, fill: S.textFaint }} interval={1} stroke={S.border} />
                        <YAxis tick={{ fontSize: 9, fill: S.textFaint }} allowDecimals={false} stroke={S.border} width={28} />
                        <Tooltip
                          contentStyle={{ background: S.panelAlt, border: `1px solid ${S.border}`, borderRadius: 4, fontSize: 11 }}
                          labelStyle={{ color: S.textMuted }}
                        />
                        <Bar dataKey="count">
                          {histogram(pboResult.logits, 14).map((d, i) => (
                            <Cell key={i} fill={d.bin < 0 ? S.rose : S.teal} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </>
            )}

            <div style={{ marginTop: 16, fontSize: 11, color: S.textFaint, lineHeight: 1.7 }}>
              說明／假設：訊號以「當日收盤」計算，隔日套用（避免未來函數）・輪動當天以「開盤價」成交：舊標的計前收→開盤的隔夜報酬，新標的計開盤→收盤的盤中報酬，並依左側設定扣除手續費（買賣各一次）與證交稅（僅賣出）；未輪動的日子維持一般收盤對收盤報酬、無交易成本・
              交易成本已直接反映在權益曲線與下方所有績效指標中，未另計滑價・均線可選「收盤價」（標準SMA）或「當日開盤價」（MA Rotation II：以當日開盤+前(N-1)日收盤計算，可於當日開盤時即得訊號）兩種計算基準，乖離率 = (比較價 − 均線)/均線・
              5 組預設策略的參數（均線天數/基準、VIX滾動視窗與分位門檻、Hybrid合併模式）皆由原始試算表公式逐一比對確認；手續費率預設為標準（未折扣）費率0.1425%，原始試算表實際採用之折扣費率為0.1425%×0.6=0.0855%且每次輪動僅合併扣除一次，本工具則對賣出與買進各計一次（較符合實際交易機制），如需貼近原始試算表可將左側手續費率調整為0.0855%參考，惟仍會因計費次數不同而略有落差，非計算錯誤・
              內建資料的VX30:VIX Roll Yield回溯至2007年（讓VIX滾動視窗從回測期間一開始就有足夠暖身資料，不需等待數年才產生訊號），但00631L/00635U/0050等價格在2014/11/3之前為原始檔案回填的佔位資料（ETF尚未上市），因此「回測期間」的起始日不論資料集本身多早，UI上都鎖定最早只能選到2014/11/3，避免選到佔位資料段落、得出失真的權益曲線與績效指標。
              VIX 分位門檻採「滾動視窗」逐日重新計算，避免使用未來資料・CAGR 以 252 個交易日/年換算，Sharpe／Sortino 以日報酬年化並扣除設定之無風險利率，Sortino 僅計入低於無風險利率之下方波動・
              Ulcer Index 為回撤深度的均方根（%），UPI = (CAGR% − 無風險利率%) / Ulcer Index・回撤曲線與 Ulcer Index／最大回撤使用同一套「相對歷史高點」定義・「交易分析」表以「每次輪動買進到下次輪動賣出」為一筆交易，勝率／賠率／期望值皆以此為單位計算，僅計入完整落於所選日期範圍內、且已平倉的交易；期末仍持有中的部位不計入・
              IC 以「策略當日多空方向（多方=+1／空方=-1）」與「隔日多空資產報酬價差」的皮爾森相關係數衡量，滾動IC為固定視窗、累計IC為自資料起點展開之視窗，IR = 滾動IC序列之均值/標準差；三者皆為訊號品質的輔助診斷，非直接等於策略報酬・
              PBO 採 Bailey et al. (2015) 之 CSCV 方法：以左側「參數1×參數2」網格產生 N 組候選策略，將樣本切成 S 個等長區塊，窮舉所有「一半區塊做樣本內(IS)、另一半做樣本外(OS)」的切分，記錄每次切分中樣本內表現最佳者在樣本外的相對名次並轉換為 logit(λ)，PBO = λ≤0 的切分比例；PBO 為診斷參數搜索穩健性的統計量，樣本仍受限於歷史資料本身，無法保證未來表現・
              候選策略平均相關係數：N 較大時以隨機抽樣（最多3000對）估計，避免全配對運算過慢；係數越高代表候選策略彼此越相似，PBO數字的變化較可能只反映候選集合的相關結構・
              DSR（Deflated Sharpe Ratio, Bailey & López de Prado 2014）：用N組候選中「樣本內Sharpe最高者」的偏態、峰態與樣本長度，估計其真實Sharpe仍優於「純運氣搜索N次後預期最大值」的機率，是PBO之外，另一個明確針對「搜索次數N」做多重比較修正的互補指標，兩者建議一起判讀，不宜只看其中一個。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- 小型 UI 元件 ---------- */
function SectionLabel({ text }) {
  return (
    <div style={{ fontSize: 11.5, fontWeight: 700, color: THEME.textMuted, marginBottom: 8, marginTop: 4, letterSpacing: "0.01em" }}>
      {text}
    </div>
  );
}
function FieldLabel({ text }) {
  return <div style={{ fontSize: 11, color: THEME.textFaint, marginBottom: 3 }}>{text}</div>;
}
function HintText({ text }) {
  return <div style={{ fontSize: 10.5, color: THEME.textFaint, marginTop: 6, lineHeight: 1.5 }}>{text}</div>;
}
function TwoCol({ children }) {
  return <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>{children.map((c, i) => <div key={i} style={{ flex: 1 }}>{c}</div>)}</div>;
}
function ToggleRow({ checked, onChange, label }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, marginBottom: 10, cursor: "pointer" }}>
      <input className="chk" type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
function RadioLabel({ checked, onChange, label }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", color: THEME.textMuted }}>
      <input className="chk" type="radio" checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}
function Th({ children, align = "right" }) {
  return (
    <th style={{ padding: "8px 10px", fontSize: 11, fontWeight: 600, color: THEME.textMuted, textAlign: align, whiteSpace: "nowrap" }}>
      {children}
    </th>
  );
}
function Td({ children, align = "right", colorize = false, value = 0, S = THEME }) {
  let color = S.text;
  if (colorize) color = value > 0 ? S.teal : value < 0 ? S.rose : S.text;
  return (
    <td style={{ padding: "7px 10px", textAlign: align, whiteSpace: "nowrap", color }}>{children}</td>
  );
}
function EmptyState({ S }) {
  return (
    <div style={{ height: 420, display: "flex", alignItems: "center", justifyContent: "center", color: S.textFaint, fontSize: 13 }}>
      設定左側參數後，點擊「加入比較」開始回測
    </div>
  );
}
function StatBlock({ S, label, value, big = false, highlight = null }) {
  const color = highlight === "rose" ? S.rose : highlight === "gold" ? S.gold : highlight === "teal" ? S.teal : S.text;
  return (
    <div>
      <div style={{ fontSize: 10.5, color: S.textFaint, marginBottom: 3 }}>{label}</div>
      <div className="mono" style={{ fontSize: big ? 22 : 14, fontWeight: 700, color }}>
        {value}
      </div>
    </div>
  );
}
function selectStyle(S) {
  return {
    background: S.panelAlt,
    border: `1px solid ${S.border}`,
    color: S.text,
    borderRadius: 4,
    padding: "5px 6px",
    fontSize: 12.5,
    width: "100%",
  };
}
