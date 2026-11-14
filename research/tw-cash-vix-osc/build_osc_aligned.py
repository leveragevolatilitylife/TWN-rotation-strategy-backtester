"""把台指權 CashVIXOsc 對齊 market_data.json 的 TW 日期（缺值以前值填補）。
用法: python3 build_osc_aligned.py   -> data/osc_aligned.json"""
import json, pathlib
import numpy as np, pandas as pd
here = pathlib.Path(__file__).parent
m = json.load(open(here / '../../src/data/market_data.json'))['TW']
dates = pd.to_datetime(m['dates'])
v = pd.read_csv(here / 'data/tw_vix_term.csv', parse_dates=['date']).set_index('date')
osc = v['CashVIXOsc']; first = osc.first_valid_index()
s = osc.reindex(osc.index.union(dates)).sort_index().ffill().reindex(dates)
s[dates < first] = np.nan
json.dump({'dates': m['dates'], 'osc': [None if pd.isna(x) else float(x) for x in s]}, open(here / 'data/osc_aligned.json', 'w'))
print('first', first.date(), 'rows', len(dates))
