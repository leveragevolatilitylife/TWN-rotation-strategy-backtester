# 研究分支：台指權 Cash VIX Oscillator × 輪動策略

> 測試用分支，**不改動** `src/` 與正式回測引擎；腳本直接抽取 `src/App.jsx` 內的引擎函式執行。
> 資料來源：[tw-vix-term-structure](https://github.com/leveragevolatilitylife/tw-vix-term-structure)（自編 TXO VIX9D/1M/3M/6M，2015-01 起）。

`CashVIXOsc = VIX3M + VIX6M − VIX9D − VIX1M`（低 = 壓力）。對齊 TW 交易日，缺值以前值填補；訊號起點 2019-02-15（1000 日窗口）。

## 重現
```bash
python3 research/tw-cash-vix-osc/build_osc_aligned.py
cd research/tw-cash-vix-osc && node 05_reverse_gate_wf_placebo.mjs   # 其餘 01–04 同理
```
輸出存於 `results/`。

## 結論摘要（2019-02-15 起；00631L / 00635U；手續費 0.1425%、證交稅 0.1%）
| 實驗 | 腳本 | 結果 |
|---|---|---|
| 以 Osc 取代 VX30 Roll Yield（同參數 28/1/0.5） | 01 | VIX Rotation+BTD：46.3%/Sh1.27/MDD-43% → 19.0%/0.65/-60%。Hybrid(HOLD) 幾乎不變（均線主導）；Hybrid II 57.6%→36.6% |
| Osc 作附加濾網（AND/HOLD/OR） | 02 | AND 降回撤、報酬減少；HOLD 的 h15 事後最佳，OR 變差 |
| 濾網 walk-forward | 03 | 無穩定樣本外增益（Hybrid 基準 Sharpe 1.28；WF 1.13–1.28） |
| 閘門：壓力區用 Hybrid、其餘用 Hybrid II | 04 | 所有門檻皆輸給單一策略；WF Sharpe 1.16 |
| **反向閘門**：壓力區用 Hybrid II、其餘用 Hybrid | 04/05 | 全門檻 Sharpe 1.43–1.47；WF(2021–26) 54.5%/1.31/-38%，Hybrid 47.6%/1.28/-36%、Hybrid II 52.2%/1.25/-41%；隨機安慰劑檢驗僅勝 81% |

## 判讀與限制
- Osc 為同步的「壓力水準」指標，不適合取代 Roll Yield 這類基差斜率訊號；較適合當風險閘門。
- 反向閘門是**看過結果後**才測的方向，含多重比較偏誤；安慰劑 81% 分位未達顯著，視為待觀察假設。
- 台指權 2015–2022 缺週選擇權，9D 約 26–33% 天數缺值（前值填補）；有效樣本約 7.7 年。
- 參數 28/1/0.5 為 Roll Yield 調出，對 Osc 不公平。
- 各組合間切換未計入額外交易成本（walk-forward 變體選擇處）。
