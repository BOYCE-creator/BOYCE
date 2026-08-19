const PROXY = 'https://lingering-mountain-1e41.swc4876.workers.dev/?url=';

const EXCHANGES = {
  NASDAQ: { param: 'NASDAQ', label: 'NASDAQ' },
  NYSE:   { param: 'NYSE',   label: 'NYSE'   },
  AMEX:   { param: 'AMEX',   label: 'AMEX'   },
};

const HISTORY_RANGE = '1y';
const HISTORY_INTERVAL = '1d';
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_KEY_PREFIX = 'scanner_cache_universe_v4_';

let IS_SCANNING = false;
let CONCURRENCY = 6;
let failCount = 0;
let passCount = 0;
let dropCount = 0;
let lastHudRenderTime = 0;

const INDICATORS = [
  { key: 'cmf',         label: 'CMF 자금 유입 강도',            category: 'vol',   weight: 10 },
  { key: 'obv',         label: 'OBV 추세 상승 전환',            category: 'vol',   weight: 8  },
  { key: 'rvol',        label: 'RVOL 3D 상대 거래량',           category: 'vol',   weight: 7  },
  { key: 'bollinger',   label: 'BB 수축 후 팽창 상방돌파',      category: 'trend', weight: 8  },
  { key: 'ma_trend',    label: 'MA 20/60/200 추세 정렬안정',    category: 'trend', weight: 7  },
  { key: 'rsi',         label: 'RSI 단기 모멘텀 전환',          category: 'trend', weight: 5  },
  { key: 'shakeout',    label: 'Shakeout (Swing Low 반등)',     category: 'mom',   weight: 7  },
  { key: 'macd',        label: 'MACD 골든크로스/수렴',          category: 'mom',   weight: 3  },
  { key: 'social_buzz', label: 'Social & Volume Velocity',      category: 'buzz',  weight: 5  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(v) {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return NaN;
  return parseFloat(String(v).replace(/[$,%]/g, ''));
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function toYahooSymbol(symbol) {
  return (symbol || '').trim().replace(/\./g, '-').toUpperCase();
}

async function fetchViaProxy(targetUrl, { tries = 3, label = '' } = {}) {
  const url = PROXY + encodeURIComponent(targetUrl);
  let lastErr;
  for (let i = 0; i < tries; i++) {
    if (!IS_SCANNING) throw new Error('SCAN_ABORTED');
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        await sleep(1000 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(300 * Math.pow(2, i));
    }
  }
  failCount++;
  throw new Error(`${label || targetUrl} 실패: ${lastErr ? lastErr.message : 'unknown'}`);
}

function isCommonStock(item) {
  const code = (item.code || '').trim().toUpperCase();
  const name = (item.name || '').toLowerCase();

  if (/[.\-+/^](WS|WT|W|U|RT|PR|UN|R|CV|CL[A-Z]?|PFD|PF)$/i.test(code)) return false;
  if (/\.(WS|WT|U|RT|PR|UN|R|PF)$/i.test(code)) return false;

  const excludeKeywords = [
    'preferred', 'pref ', 'pref.', ' etf', 'etn', 'depositary', 'warrant',
    'spdr', 'ishares', 'vanguard', 'invesco', 'schwab', 'direxion',
    'proshares', 'wisdomtree', 'debenture', 'rights', 'trust preferred',
    '% notes', 'senior notes', 'due 20', 'fund', 'closed-end', 'income fund',
    'term trust', 'municipal', 'high yield fund', 'global dividend',
    'real estate fund', 'index fund', 'etp', 'adr', 'ads', 'subordinated'
  ];
  if (excludeKeywords.some((kw) => name.includes(kw))) return false;

  const spacPatterns = [
    /blank check/, /\bspac\b/, /acquisition corp/, /acquisition co\b/,
    /acquisition trust/, /special purpose acquisition/, /acquisition ltd/
  ];
  if (spacPatterns.some((re) => re.test(name))) return false;

  return true;
}

function getCachedUniverse(exchangeParam) {
  try {
    const raw = localStorage.getItem(CACHE_KEY_PREFIX + exchangeParam);
    if (!raw) return null;
    const { ts, rows } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL_MS) {
      localStorage.removeItem(CACHE_KEY_PREFIX + exchangeParam);
      return null;
    }
    return rows;
  } catch (e) {
    return null;
  }
}

function setCachedUniverse(exchangeParam, rows) {
  try {
    localStorage.setItem(CACHE_KEY_PREFIX + exchangeParam, JSON.stringify({ ts: Date.now(), rows }));
  } catch (e) {}
}

async function fetchExchangeList(exchangeParam) {
  const target = `https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=6000&exchange=${exchangeParam}`;
  const json = await fetchViaProxy(target, { label: `${exchangeParam} 유니버스` });
  const rows = json?.data?.table?.rows && Array.isArray(json.data.table.rows) ? json.data.table.rows : [];
  return rows.map((r) => ({
    code: r.symbol,
    name: r.name || r.companyName || r.symbol,
    price: num(r.lastsale),
    changeRate: num(r.pctchange),
  })).filter((r) => r.code && !Number.isNaN(r.price) && r.price > 0 && isCommonStock(r));
}

async function fetchHistory(symbol) {
  const cleanSymbol = toYahooSymbol(symbol);
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cleanSymbol)}?range=${HISTORY_RANGE}&interval=${HISTORY_INTERVAL}`;
  const json = await fetchViaProxy(target, { label: `${symbol} 히스토리` });
  const result = json?.chart?.result?.[0];
  if (!result) return null;

  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close ? q.close[i] : null;
    if (close === null || close === undefined || !Number.isFinite(close)) continue;
    bars.push({
      date: ts[i],
      open: q.open ? (q.open[i] ?? close) : close,
      high: q.high ? (q.high[i] ?? close) : close,
      low: q.low ? (q.low[i] ?? close) : close,
      close,
      volume: q.volume ? (q.volume[i] || 0) : 0,
    });
  }
  return bars;
}

function sma(values, period) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(NaN);
  const k = 2 / (period + 1);
  let prev;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) {
      prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
      out[i] = prev;
    } else if (i >= period) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

function macdCalc(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) => {
    if (!Number.isFinite(emaFast[i]) || !Number.isFinite(emaSlow[i])) return NaN;
    return emaFast[i] - emaSlow[i];
  });
  const signal = new Array(closes.length).fill(NaN);
  const valids = macdLine.map((v, i) => ({ v, i })).filter((x) => Number.isFinite(x.v));
  if (valids.length >= signalPeriod) {
    const emaSig = ema(valids.map((x) => x.v), signalPeriod);
    emaSig.forEach((val, idx) => {
      if (Number.isFinite(val)) signal[valids[idx].i] = val;
    });
  }
  return { macdLine, signal };
}

function rsiCalc(closes, period = 14) {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff; else lossSum += -diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff >= 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return out;
}

function cmfCalc(highs, lows, closes, volumes, period = 20) {
  const out = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    let sumVol = 0, sumMfv = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const hl = highs[j] - lows[j];
      const mfv = hl === 0 ? 0 : (((closes[j] - lows[j]) - (highs[j] - closes[j])) / hl) * volumes[j];
      sumMfv += mfv;
      sumVol += volumes[j];
    }
    out[i] = sumVol === 0 ? 0 : sumMfv / sumVol;
  }
  return out;
}

function rvolCalc(volumes, period = 20) {
  const volMa = sma(volumes, period);
  return volumes.map((v, i) => (!Number.isFinite(volMa[i]) || volMa[i] === 0 ? 1 : v / volMa[i]));
}

function normalizedObvCalc(closes, volumes) {
  const obv = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) obv[i] = obv[i - 1] + volumes[i];
    else if (closes[i] < closes[i - 1]) obv[i] = obv[i - 1] - volumes[i];
    else obv[i] = obv[i - 1];
  }
  const obvMa20 = sma(obv, 20);
  const vol20Sum = sma(volumes, 20).map(v => v * 20);
  const normObvDiffPct = obv.map((v, i) => {
    const denom = vol20Sum[i] || 1;
    return !Number.isFinite(obvMa20[i]) ? 0 : ((v - obvMa20[i]) / denom) * 100;
  });
  return { obv, obvMa20, normObvDiffPct };
}

function bollingerCalc(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(NaN);
  const lower = new Array(closes.length).fill(NaN);
  const bandwidth = new Array(closes.length).fill(NaN);

  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = mid[i];
    if (!Number.isFinite(mean)) continue;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
    bandwidth[i] = (upper[i] - lower[i]) / (mean || 1);
  }
  return { mid, upper, lower, bandwidth };
}

// -------------------------------------------------------------
// [M-W 복합 순환 지그재그 파동 & 지지 바닥 연산 엔진]
// -------------------------------------------------------------
function analyzeZigzagAccumulationWave(bars, closes, lastPrice) {
  const n = closes.length;
  if (n < 50) return { isWavePattern: false, waveBonusScore: 0, waveRatio: 0, pivots: [], desc: '데이터 부족' };

  const testLen = Math.min(180, n);
  const sliceBars = bars.slice(n - testLen);
  const offset = n - testLen;

  // 1. 피벗 고점/저점(스윙 포인트) 추출
  const swingWindow = 4;
  const rawPivots = [];

  for (let i = swingWindow; i < sliceBars.length - swingWindow; i++) {
    const b = sliceBars[i];
    let isHigh = true;
    let isLow = true;

    for (let k = i - swingWindow; k <= i + swingWindow; k++) {
      if (k === i) continue;
      if (sliceBars[k].high >= b.high) isHigh = false;
      if (sliceBars[k].low <= b.low) isLow = false;
    }

    if (isHigh) rawPivots.push({ index: offset + i, type: 'H', price: b.high });
    else if (isLow) rawPivots.push({ index: offset + i, type: 'L', price: b.low });
  }

  // 지그재그 피벗 교차 정리
  const zigzagPivots = [];
  for (const p of rawPivots) {
    if (!zigzagPivots.length) {
      zigzagPivots.push(p);
      continue;
    }
    const lastP = zigzagPivots[zigzagPivots.length - 1];
    if (lastP.type === p.type) {
      if (p.type === 'H' && p.price > lastP.price) zigzagPivots[zigzagPivots.length - 1] = p;
      else if (p.type === 'L' && p.price < lastP.price) zigzagPivots[zigzagPivots.length - 1] = p;
    } else {
      zigzagPivots.push(p);
    }
  }

  const lowPivots = zigzagPivots.filter(p => p.type === 'L');
  const highPivots = zigzagPivots.filter(p => p.type === 'H');

  // 지지 바닥선 클러스터링
  let solidFloor = Math.min(...sliceBars.map(b => b.low));
  let bottomSupportCount = 0;

  if (lowPivots.length >= 2) {
    const sortedLows = lowPivots.map(p => p.price).sort((a, b) => a - b);
    const minLow = sortedLows[0];
    const clustered = sortedLows.filter(lp => (lp - minLow) / (minLow || 1) <= 0.12);
    bottomSupportCount = clustered.length;
    solidFloor = clustered.reduce((a, b) => a + b, 0) / clustered.length;
  }

  const recentHigh = highPivots.length ? Math.max(...highPivots.map(p => p.price)) : Math.max(...sliceBars.map(b => b.high));
  const channelHeight = recentHigh - solidFloor;

  if (channelHeight <= 0) {
    return { isWavePattern: false, waveBonusScore: 0, waveRatio: 0, pivots: zigzagPivots, desc: '채널 미수렴' };
  }

  const waveRatio = clamp((lastPrice - solidFloor) / channelHeight, 0, 1);
  const zigzagCycleCount = Math.floor(zigzagPivots.length / 2);

  let waveBonusScore = 0;
  let wavePosDesc = '';

  // 지그재그 횟수 + 바닥 다중 지지(Double/Triple/Quadruple Bottom) 가산
  if (zigzagCycleCount >= 2 && bottomSupportCount >= 2) {
    if (waveRatio <= 0.28) {
      waveBonusScore = 15;
      wavePosDesc = `M-W 파동 바닥권 ${(waveRatio * 100).toFixed(0)}% (만점 지지)`;
    } else if (waveRatio <= 0.42) {
      waveBonusScore = 12;
      wavePosDesc = `M-W 파동 저점 지지 ${(waveRatio * 100).toFixed(0)}% (우수)`;
    } else if (waveRatio <= 0.58) {
      waveBonusScore = 7;
      wavePosDesc = `M-W 파동 중심 넥라인 ${(waveRatio * 100).toFixed(0)}% (중립)`;
    } else {
      waveBonusScore = 2;
      wavePosDesc = `M-W 파동 상단권 ${(waveRatio * 100).toFixed(0)}%`;
    }
  } else if (zigzagCycleCount >= 1) {
    if (waveRatio <= 0.35) {
      waveBonusScore = 8;
      wavePosDesc = `지그재그 저점 반등권 ${(waveRatio * 100).toFixed(0)}%`;
    } else {
      waveBonusScore = 3;
      wavePosDesc = `지그재그 파동 진행 중 ${(waveRatio * 100).toFixed(0)}%`;
    }
  }

  return {
    isWavePattern: zigzagCycleCount >= 2 && bottomSupportCount >= 2,
    pivots: zigzagPivots,
    zigzagCycleCount,
    bottomSupportCount,
    waveBonusScore,
    waveRatio: waveRatio * 100,
    waveFloor: solidFloor,
    waveCeil: recentHigh,
    wavePosDesc,
    desc: `M-W 지그재그 ${zigzagCycleCount}회 순환 · 바닥 ${bottomSupportCount}중 지지 · ${wavePosDesc}`
  };
}

// -------------------------------------------------------------
// [펌프앤덤프 악성 차트 필터링]
// -------------------------------------------------------------
function detectPumpAndDumpDeadChart(bars, closes, lastPrice, waveInfo) {
  const n = closes.length;
  if (n < 60) return { isDead: false };

  const allHighs = bars.map(b => b.high);
  const maxHigh1Y = Math.max(...allHighs);
  const dropFrom1YHigh = (lastPrice - maxHigh1Y) / (maxHigh1Y || 1);

  // M-W 파동 바닥 지지가 확인된 경우 필터 기준 완화
  const isHealthyWave = waveInfo && waveInfo.isWavePattern && waveInfo.waveRatio <= 45;

  if (dropFrom1YHigh <= -0.75 && !isHealthyWave) {
    return {
      isDead: true,
      reason: `1년 최고점($${maxHigh1Y.toFixed(2)}) 대비 ${(dropFrom1YHigh * 100).toFixed(1)}% 하락 (바닥 지지 미형성)`
    };
  }

  const lookbackRecent = Math.min(80, n);
  const recentSlice = bars.slice(n - lookbackRecent);
  const recentHigh = Math.max(...recentSlice.map(b => b.high));
  const recentLow = Math.min(...recentSlice.map(b => b.low));
  const recentHighIdx = recentSlice.findIndex(b => b.high === recentHigh);
  const barsSincePeak = recentSlice.length - 1 - recentHighIdx;

  const spikeRatio = recentHigh / Math.max(recentLow, 0.01);
  const dropFromRecentPeak = (lastPrice - recentHigh) / (recentHigh || 1);

  if (spikeRatio >= 3.0 && dropFromRecentPeak <= -0.65 && barsSincePeak <= 45 && !isHealthyWave) {
    return {
      isDead: true,
      reason: `단기 급등 후 수직 폭락 (${(dropFromRecentPeak * 100).toFixed(1)}% 낙하 설거지)`
    };
  }

  return { isDead: false };
}

function calculateTargetPriceAndBonus(bars, closes, lastPrice) {
  const n = closes.length;
  const lookback = Math.min(90, n);
  const recentSlice = bars.slice(n - lookback);

  const ret5D = n >= 6 ? (lastPrice - closes[n - 6]) / closes[n - 6] : 0;
  const isOverheatedTop = (ret5D >= 0.20);

  const swingHighs = [];
  for (let i = 2; i < recentSlice.length - 2; i++) {
    const b = recentSlice[i];
    if (
      b.high >= recentSlice[i - 1].high &&
      b.high >= recentSlice[i - 2].high &&
      b.high >= recentSlice[i + 1].high &&
      b.high >= recentSlice[i + 2].high
    ) {
      if (b.high >= lastPrice * 1.03 && b.high <= lastPrice * 3.0) {
        swingHighs.push({
          price: b.high,
          barsAgo: recentSlice.length - 1 - i,
          volume: b.volume || 1
        });
      }
    }
  }

  if (swingHighs.length === 0) {
    const validHighs = recentSlice.map(b => b.high).filter(h => h <= lastPrice * 2.5);
    const maxHigh90 = validHighs.length ? Math.max(...validHighs) : lastPrice * 1.1;
    const upside = Math.max(0, ((maxHigh90 - lastPrice) / lastPrice) * 100);
    return {
      targetPrice: maxHigh90,
      targetZoneHigh: maxHigh90 * 1.02,
      upsidePct: upside,
      targetBonusScore: 0,
      isOverheatedTop,
      clusterCount: 0,
      zoneDesc: `단기 유효 고점권 ($${maxHigh90.toFixed(2)})`
    };
  }

  swingHighs.sort((a, b) => a.price - b.price);
  const clusters = [];

  for (const sh of swingHighs) {
    let matchedCluster = clusters.find(c => Math.abs((sh.price - c.avgPrice) / c.avgPrice) <= 0.035);
    if (matchedCluster) {
      matchedCluster.items.push(sh);
      matchedCluster.prices.push(sh.price);
      matchedCluster.avgPrice = matchedCluster.prices.reduce((a, b) => a + b, 0) / matchedCluster.prices.length;
    } else {
      clusters.push({
        items: [sh],
        prices: [sh.price],
        avgPrice: sh.price
      });
    }
  }

  clusters.sort((a, b) => a.avgPrice - b.avgPrice);
  const targetCluster = clusters[0];

  const targetPrice = targetCluster.avgPrice;
  const targetZoneHigh = Math.max(...targetCluster.prices);
  const upsidePct = Math.max(0, ((targetPrice - lastPrice) / lastPrice) * 100);

  let targetBonusScore = 0;
  if (!isOverheatedTop) {
    if (upsidePct >= 35) targetBonusScore = 15;
    else if (upsidePct >= 20) targetBonusScore = 11;
    else if (upsidePct >= 12) targetBonusScore = 8;
    else if (upsidePct >= 6) targetBonusScore = 4;
    else if (upsidePct >= 3) targetBonusScore = 2;

    if (targetCluster.items.length >= 2 && targetBonusScore > 0) {
      targetBonusScore = Math.min(15, targetBonusScore + 1);
    }
  }

  const zoneDesc = targetCluster.items.length >= 2
    ? `주요 저항 매물대 $${targetPrice.toFixed(2)} (${targetCluster.items.length}회 중첩)`
    : `스윙 저항선 $${targetPrice.toFixed(2)}`;

  return {
    targetPrice,
    targetZoneHigh,
    upsidePct,
    targetBonusScore,
    isOverheatedTop,
    clusterCount: targetCluster.items.length,
    zoneDesc
  };
}

function detectChoppyNoiseChart(bars, closes) {
  const n = closes.length;
  if (n < 30) return false;

  const testBars = bars.slice(-25);
  let smallBodyCount = 0;
  let totalRangePct = 0;

  for (const b of testBars) {
    const range = b.high - b.low;
    const body = Math.abs(b.close - b.open);
    const rangePct = b.low > 0 ? (range / b.low) * 100 : 0;
    totalRangePct += rangePct;

    if (range > 0 && (body / range < 0.30 || rangePct < 0.9)) {
      smallBodyCount++;
    }
  }

  const avgRangePct = totalRangePct / testBars.length;
  return (smallBodyCount >= 20 || avgRangePct < 1.0);
}

function detectBadChartPatterns(bars, closes, ma20, ma60, ma200, waveInfo) {
  const n = closes.length;
  const last = closes[n - 1];

  if (waveInfo && waveInfo.isWavePattern && waveInfo.waveRatio <= 45) {
    return { bad: false };
  }

  if (n >= 60) {
    const cMa20 = ma20[n - 1] || last;
    const cMa60 = ma60[n - 1] || last;
    const cMa200 = Number.isFinite(ma200[n - 1]) ? ma200[n - 1] : cMa60;

    const isFullBearishMA = (cMa20 < cMa60) && (cMa60 < cMa200) && (last < cMa60 * 0.93);
    const ma60Prev20 = ma60[Math.max(0, n - 20)] || cMa60;
    const ma60Slope = (cMa60 - ma60Prev20) / (ma60Prev20 || 1);

    if (isFullBearishMA && ma60Slope < -0.05) {
      return { bad: true, reason: `장기 우하향 역배열 (MA60 기울기 ${(ma60Slope * 100).toFixed(1)}%)` };
    }
  }

  return { bad: false };
}

function crossState4Tier(shortArr, longArr, lookback = 3, imminentGapPct = 2.0, approachingGapPct = 4.0) {
  const n = shortArr.length;
  const diff = shortArr.map((v, i) => v - longArr[i]);
  for (let back = 0; back < lookback; back++) {
    const i = n - 1 - back;
    const p = i - 1;
    if (p < 0) break;
    if (!Number.isFinite(diff[i]) || !Number.isFinite(diff[p])) continue;
    if (diff[p] <= 0 && diff[i] > 0) return { status: 'crossed', barsAgo: back };
  }
  const last = diff[n - 1], prev = diff[n - 2];
  if (Number.isFinite(last) && Number.isFinite(prev)) {
    const converging = last > prev;
    const gapPct = Math.abs(last) / Math.max(Math.abs(longArr[n - 1]), 1e-6) * 100;
    if (last < 0 && converging) {
      if (gapPct <= imminentGapPct) return { status: 'imminent', gapPct };
      if (gapPct <= approachingGapPct) return { status: 'approaching', gapPct };
    }
  }
  return { status: 'none' };
}

function macdState4Tier(macd, signal, lookback = 3) {
  const n = macd.length;
  for (let back = 0; back < lookback; back++) {
    const i = n - 1 - back;
    const p = i - 1;
    if (p < 0) break;
    if (Number.isFinite(macd[i]) && Number.isFinite(signal[i]) && Number.isFinite(macd[p]) && Number.isFinite(signal[p])) {
      if (macd[p] <= signal[p] && macd[i] > signal[i]) return { status: 'crossed', barsAgo: back };
    }
  }
  const lastDiff = macd[n - 1] - signal[n - 1];
  const prevDiff = macd[n - 2] - signal[n - 2];
  if (!Number.isFinite(lastDiff) || !Number.isFinite(prevDiff)) return { status: 'none' };

  if (lastDiff < 0 && lastDiff > prevDiff) {
    const scale = Math.max(Math.abs(macd[n - 1]), Math.abs(signal[n - 1]), 0.01);
    const gapPct = (Math.abs(lastDiff) / scale) * 100;
    if (gapPct <= 10) return { status: 'imminent', gapPct };
    if (gapPct <= 25) return { status: 'approaching', gapPct };
  }
  return { status: 'none' };
}

function rsiState4Tier(shortArr, longArr, lookback = 3) {
  const n = shortArr.length;
  for (let back = 0; back < lookback; back++) {
    const i = n - 1 - back;
    const p = i - 1;
    if (p < 0) break;
    if (Number.isFinite(shortArr[i]) && Number.isFinite(longArr[i]) && Number.isFinite(shortArr[p]) && Number.isFinite(longArr[p])) {
      if (shortArr[p] <= longArr[p] && shortArr[i] > longArr[i]) return { status: 'crossed', barsAgo: back };
    }
  }
  const diff = shortArr[n - 1] - longArr[n - 1];
  const prevDiff = shortArr[n - 2] - longArr[n - 2];
  if (!Number.isFinite(diff) || !Number.isFinite(prevDiff)) return { status: 'none' };

  if (diff < 0 && diff > prevDiff) {
    const absGap = Math.abs(diff);
    if (absGap <= 1.5) return { status: 'imminent' };
    if (absGap <= 3.0) return { status: 'approaching' };
  }
  return { status: 'none' };
}

function detectMultiBarShakeout(bars, n) {
  const last = bars[n - 1].close;
  const priorLows = bars.slice(Math.max(0, n - 25), Math.max(1, n - 6)).map(b => b.low);
  if (!priorLows.length) return { status: 'none' };
  const priorBaseSupport = Math.min(...priorLows);

  const distFromBase = (last - priorBaseSupport) / (priorBaseSupport || 1);
  if (distFromBase > 0.08 || distFromBase < -0.02) return { status: 'none' };

  for (let i = n - 5; i < n; i++) {
    if (i < 1) continue;
    const b = bars[i];
    const prevB = bars[i - 1];
    const range = b.high - b.low;
    const lowerTail = Math.min(b.open, b.close) - b.low;

    const undercutSupport = (b.low < priorBaseSupport * 0.998);
    const reclaimedSupport = (b.close >= priorBaseSupport * 0.995);
    const hasLongTail = range > 0 && (lowerTail / range >= 0.48);
    const volSurge = b.volume >= prevB.volume * 1.15;

    if (undercutSupport && reclaimedSupport && (hasLongTail || volSurge)) {
      const isDefended = (i === n - 1) ? true : (bars[n - 1].low >= b.low * 0.995);
      if (isDefended) {
        return {
          status: 'crossed',
          barsAgo: n - 1 - i,
          shakeoutIndex: i,
          shakeoutPrice: b.low,
          type: hasLongTail ? '밑꼬리 반등 지지' : '지지선 회복 반등'
        };
      }
    }
  }

  if (distFromBase >= 0.005 && distFromBase <= 0.03) return { status: 'imminent' };
  else if (distFromBase > 0.03 && distFromBase <= 0.055) return { status: 'approaching' };

  return { status: 'none' };
}

function calculateVolumeBuzzProxy(bars, n, avgRvol3) {
  const volumes = bars.map(b => b.volume);
  const recent3Vol = sma(volumes, 3)[n - 1] || 1;
  const prior15Vol = sma(volumes, 15)[Math.max(0, n - 4)] || 1;
  const volSurge = recent3Vol / Math.max(prior15Vol, 1);
  const proxyIndex = (volSurge * 0.65) + (avgRvol3 * 0.35);
  const pctStr = `+${Math.max(0, (proxyIndex - 1) * 100).toFixed(0)}%`;

  if (proxyIndex >= 2.0) {
    return { isRealSource: false, status: 'crossed', buzzScore: 5.0, labelText: `거래 가속도 급증 (${pctStr})` };
  } else if (proxyIndex >= 1.5) {
    return { isRealSource: false, status: 'imminent', buzzScore: 3.0, labelText: `거래 수급 집중 (${pctStr})` };
  } else if (proxyIndex >= 1.2) {
    return { isRealSource: false, status: 'approaching', buzzScore: 1.5, labelText: `거래 수급 증가 (${pctStr})` };
  }
  return { isRealSource: false, status: 'none', buzzScore: 0, labelText: `거래량 평이` };
}

async function fetchRealStockTwitsBuzz(symbol, fallbackProxy) {
  try {
    const target = `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol)}.json`;
    const json = await fetchViaProxy(target, { tries: 1, label: `${symbol} StockTwits` });
    const messages = json?.messages || [];

    if (messages && messages.length >= 5) {
      const timestamps = messages.map(m => new Date(m.created_at).getTime()).sort((a, b) => b - a);
      const recentSpans = [];
      for (let i = 0; i < Math.min(4, timestamps.length - 1); i++) {
        recentSpans.push(timestamps[i] - timestamps[i + 1]);
      }
      const priorSpans = [];
      for (let i = 4; i < Math.min(15, timestamps.length - 1); i++) {
        priorSpans.push(timestamps[i] - timestamps[i + 1]);
      }

      const avgRecentSpan = recentSpans.length ? (recentSpans.reduce((a, b) => a + b, 0) / recentSpans.length) : 3600000;
      const avgPriorSpan = priorSpans.length ? (priorSpans.reduce((a, b) => a + b, 0) / priorSpans.length) : 3600000;
      const velocitySurge = avgRecentSpan > 0 ? (avgPriorSpan / avgRecentSpan) : 1.0;

      let bullish = 0, bearish = 0;
      messages.forEach(m => {
        const sentiment = m.entities?.sentiment?.basic;
        if (sentiment === 'Bullish') bullish++;
        if (sentiment === 'Bearish') bearish++;
      });
      const bullishRatio = (bullish + bearish) > 0 ? (bullish / (bullish + bearish)) * 100 : 50;
      const speedPct = `+${Math.max(0, (velocitySurge - 1) * 100).toFixed(0)}%`;

      if (velocitySurge >= 2.2 && bullishRatio >= 50) {
        return { isRealSource: true, status: 'crossed', buzzScore: 5.0, labelText: `StockTwits 가속 ${speedPct} (Bull ${bullishRatio.toFixed(0)}%)` };
      } else if (velocitySurge >= 1.5) {
        return { isRealSource: true, status: 'imminent', buzzScore: 3.0, labelText: `StockTwits 언급 증가 (${speedPct})` };
      } else if (velocitySurge >= 1.2) {
        return { isRealSource: true, status: 'approaching', buzzScore: 1.5, labelText: `StockTwits 유입 초기 (${speedPct})` };
      }
      return { isRealSource: true, status: 'none', buzzScore: 0, labelText: `소셜 활동 평이` };
    }
  } catch (e) {}
  return fallbackProxy;
}

function renderHudSvgChart(bars, ma20, ma60, ma200, bbUpper, bbLower, recentLow, targetPrice, shakeoutInfo, macdLine, rsi9, waveInfo) {
  if (!bars || bars.length < 20 || !els.hudDynamicSvg) return;
  const W = 480, H = 145, PAD_X = 8;
  const P_TOP = 6, P_BOTTOM = 92;
  const S_TOP = 100, S_BOTTOM = 140;

  const sliceBars = bars.slice(-40);
  const n = sliceBars.length;
  const closes = sliceBars.map((b) => b.close);
  const volumes = sliceBars.map((b) => b.volume);

  const startIdx = bars.length - n;
  const sliceMa20 = (ma20 || []).slice(startIdx);
  const sliceMa60 = (ma60 || []).slice(startIdx);
  const sliceBbU = (bbUpper || []).slice(startIdx);
  const sliceBbL = (bbLower || []).slice(startIdx);

  const validVals = [...closes, ...sliceMa20, ...sliceMa60, ...sliceBbU, ...sliceBbL, recentLow, targetPrice].filter(v => Number.isFinite(v) && v > 0);
  const minVal = Math.min(...validVals);
  const maxVal = Math.max(...validVals);
  const range = maxVal - minVal || 1;

  const getX = (i) => PAD_X + (i / (n - 1)) * (W - PAD_X * 2);
  const getYPrice = (val) => P_BOTTOM - ((val - minVal) / range) * (P_BOTTOM - P_TOP);

  const maxVol = Math.max(...volumes) || 1;
  const volBars = sliceBars.map((b, i) => {
    const vH = (b.volume / maxVol) * 22;
    const x = getX(i) - 2;
    const y = P_BOTTOM - vH;
    const isUp = b.close >= b.open;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="4" height="${vH.toFixed(1)}" fill="${isUp ? 'rgba(255,30,60,0.25)' : 'rgba(71,85,105,0.25)'}" />`;
  }).join('');

  const pricePts = closes.map((c, i) => `${getX(i).toFixed(1)},${getYPrice(c).toFixed(1)}`).join(' ');
  const ma20Pts = sliceMa20.map((m, i) => !Number.isFinite(m) ? null : `${getX(i).toFixed(1)},${getYPrice(m).toFixed(1)}`).filter(Boolean).join(' ');
  const ma60Pts = sliceMa60.map((m, i) => !Number.isFinite(m) ? null : `${getX(i).toFixed(1)},${getYPrice(m).toFixed(1)}`).filter(Boolean).join(' ');

  const baseLineY = getYPrice(recentLow).toFixed(1);
  const targetLineY = targetPrice ? getYPrice(targetPrice).toFixed(1) : null;

  // 지그재그 피벗 라인 그리기
  let zigzagPolyline = '';
  if (waveInfo && waveInfo.pivots && waveInfo.pivots.length) {
    const visiblePivots = waveInfo.pivots
      .map(p => ({ ...p, localIdx: p.index - startIdx }))
      .filter(p => p.localIdx >= 0 && p.localIdx < n);

    if (visiblePivots.length >= 2) {
      const zPts = visiblePivots.map(p => `${getX(p.localIdx).toFixed(1)},${getYPrice(p.price).toFixed(1)}`).join(' ');
      zigzagPolyline = `<polyline fill="none" stroke="var(--wave-amber)" stroke-width="1.8" stroke-dasharray="3,3" opacity="0.9" points="${zPts}" />`;
    }
  }

  let shakeoutMarker = '';
  if (shakeoutInfo && shakeoutInfo.status === 'crossed' && shakeoutInfo.shakeoutIndex !== undefined) {
    const localIdx = shakeoutInfo.shakeoutIndex - startIdx;
    if (localIdx >= 0 && localIdx < n) {
      const sX = getX(localIdx).toFixed(1);
      const sY = getYPrice(shakeoutInfo.shakeoutPrice).toFixed(1);
      shakeoutMarker = `
        <circle cx="${sX}" cy="${sY}" r="4.5" fill="none" stroke="#10b981" stroke-width="1.8" />
        <text x="${sX}" y="${Number(sY) + 11}" fill="#10b981" font-family="JetBrains Mono" font-size="7.5" font-weight="700" text-anchor="middle">SHAKEOUT</text>
      `;
    }
  }

  const sliceRsi = (rsi9 || []).slice(startIdx);
  const rsiPts = sliceRsi.map((v, i) => {
    if (!Number.isFinite(v)) return null;
    const y = S_BOTTOM - (v / 100) * (S_BOTTOM - S_TOP);
    return `${getX(i).toFixed(1)},${y.toFixed(1)}`;
  }).filter(Boolean).join(' ');

  const sliceMacd = (macdLine || []).slice(startIdx);
  const validMacd = sliceMacd.filter(x => Number.isFinite(x));
  const macdMin = Math.min(...validMacd, -0.1);
  const macdMax = Math.max(...validMacd, 0.1);
  const macdRange = macdMax - macdMin || 1;
  const macdPts = sliceMacd.map((v, i) => {
    if (!Number.isFinite(v)) return null;
    const y = S_BOTTOM - ((v - macdMin) / macdRange) * (S_BOTTOM - S_TOP);
    return `${getX(i).toFixed(1)},${y.toFixed(1)}`;
  }).filter(Boolean).join(' ');

  const rsiMidY = (S_TOP + (S_BOTTOM - S_TOP) * 0.5).toFixed(1);

  els.hudDynamicSvg.innerHTML = `
    <g class="hud-vol-layer">${volBars}</g>
    <line x1="${PAD_X}" y1="${baseLineY}" x2="${W-PAD_X}" y2="${baseLineY}" stroke="#10b981" stroke-width="1.2" stroke-dasharray="3,3" />
    <text x="${W-PAD_X-4}" y="${baseLineY - 3}" fill="#10b981" font-family="JetBrains Mono" font-size="8" text-anchor="end">SUPPORT $${recentLow.toFixed(2)}</text>
    
    ${targetLineY ? `
      <line x1="${PAD_X}" y1="${targetLineY}" x2="${W-PAD_X}" y2="${targetLineY}" stroke="#06b6d4" stroke-width="1.2" stroke-dasharray="4,2" />
      <text x="${PAD_X + 4}" y="${Number(targetLineY) - 3}" fill="#06b6d4" font-family="JetBrains Mono" font-size="8" font-weight="700">TARGET $${targetPrice.toFixed(2)}</text>
    ` : ''}

    ${zigzagPolyline}
    ${ma60Pts ? `<polyline fill="none" stroke="var(--purple)" stroke-width="1.2" opacity="0.8" points="${ma60Pts}" />` : ''}
    ${ma20Pts ? `<polyline fill="none" stroke="var(--red)" stroke-width="1.5" points="${ma20Pts}" />` : ''}
    <polyline fill="none" stroke="var(--text)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" points="${pricePts}" />
    ${shakeoutMarker}
    <circle cx="${getX(n-1)}" cy="${getYPrice(closes[n-1])}" r="3" fill="var(--red)" />

    <line x1="${PAD_X}" y1="${S_TOP - 4}" x2="${W-PAD_X}" y2="${S_TOP - 4}" stroke="rgba(255,255,255,0.08)" stroke-width="1" />
    <line x1="${PAD_X}" y1="${rsiMidY}" x2="${W-PAD_X}" y2="${rsiMidY}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="2,2" />
    <text x="${PAD_X + 2}" y="${S_TOP + 8}" fill="var(--text-faint)" font-family="JetBrains Mono" font-size="7">RSI / MACD</text>
    ${macdPts ? `<polyline fill="none" stroke="rgba(255,30,60,0.6)" stroke-width="1" stroke-dasharray="2,2" points="${macdPts}" />` : ''}
    ${rsiPts ? `<polyline fill="none" stroke="rgba(192,38,211,0.7)" stroke-width="1.2" points="${rsiPts}" />` : ''}
  `;
}

function analyzeStockPhase1(meta, bars, filterOpts, isCustomMode, onHudUpdate) {
  if (!bars || bars.length < 20) return null;

  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const volumes = bars.map((b) => b.volume);
  const n = closes.length;
  const last = closes[n - 1];

  if (!isCustomMode && (last < filterOpts.minPrice || last > filterOpts.maxPrice)) {
    return { dropped: true, reason: `주가 불일치 ($${last.toFixed(2)})` };
  }

  // 1. M-W 지그재그 파동 먼저 연산
  const waveInfo = analyzeZigzagAccumulationWave(bars, closes, last);

  // 2. 펌프앤덤프 검증 (바닥 지지 여부 연계)
  const deadCheck = detectPumpAndDumpDeadChart(bars, closes, last, waveInfo);
  if (deadCheck.isDead && !isCustomMode) {
    return { dropped: true, reason: deadCheck.reason };
  }

  const vol20Arr = sma(volumes, 20);
  const avgVol20 = vol20Arr[n - 1] || 1;
  const avgDollarVol20 = avgVol20 * last;

  const win = Math.min(20, n - 1);
  const recentHigh = Math.max(...highs.slice(n - win));
  const recentLow = Math.min(...lows.slice(n - win));
  const rangeRecent = (recentHigh - recentLow) / (recentLow || 1);

  if (!isCustomMode && rangeRecent < 0.01) {
    return { dropped: true, reason: `20일 변동폭 비정상 (${(rangeRecent * 100).toFixed(2)}% < 1.0%)` };
  }

  if (!isCustomMode && (Number.isNaN(avgDollarVol20) || avgDollarVol20 < filterOpts.minDollarVol)) {
    return { dropped: true, reason: `거래대금 미달 ($${(avgDollarVol20 / 1000).toFixed(0)}K)` };
  }

  if (!isCustomMode && detectChoppyNoiseChart(bars, closes)) {
    return { dropped: true, reason: `짜잘한 노이즈 캔들 차트 (추세 효율성 미달)` };
  }

  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const ma200 = sma(closes, 200);

  const badCheck = detectBadChartPatterns(bars, closes, ma20, ma60, ma200, waveInfo);
  if (badCheck.bad && !isCustomMode) {
    return { dropped: true, reason: badCheck.reason };
  }

  const curMa20 = ma20[n - 1] || last;
  const curMa60 = ma60[n - 1] || last;
  const curMa200 = ma200[n - 1] || curMa60;
  const ma20GapPct = ((last / curMa20) - 1) * 100;

  let ma20TrendPenalty = 0;
  if (ma20GapPct < -12) {
    if (!isCustomMode && !waveInfo.isWavePattern) return { dropped: true, reason: `20일선 과도한 이탈 (${ma20GapPct.toFixed(1)}%)` };
    ma20TrendPenalty = 6;
  } else if (ma20GapPct < -6) {
    ma20TrendPenalty = 3;
  }

  const targetInfo = calculateTargetPriceAndBonus(bars, closes, last);
  if (!isCustomMode && targetInfo.upsidePct < filterOpts.minUpsidePct) {
    return { dropped: true, reason: `상승 여력 미달 (+${targetInfo.upsidePct.toFixed(1)}% < ${filterOpts.minUpsidePct}%)` };
  }

  const isHealthyLongTrend = curMa200 > 0 && last >= curMa200 * 0.90;
  const maTrendState = crossState4Tier(ma20, ma60, 3, 1.5, 3.0);

  const { macdLine, signal: macdSig } = macdCalc(closes);
  const rsi14 = rsiCalc(closes, 14);
  const rsi9 = rsiCalc(closes, 9);
  const cmf = cmfCalc(highs, lows, closes, volumes, 20);
  const rvol = rvolCalc(volumes, 20);
  const { normObvDiffPct } = normalizedObvCalc(closes, volumes);
  const { mid: bbMid, upper: bbUpper, lower: bbLower, bandwidth } = bollingerCalc(closes);

  const curCmf = cmf[n - 1] || 0;
  const rvol3 = rvol.slice(-3).filter(Number.isFinite);
  const avgRvol3 = rvol3.length ? (rvol3.reduce((a, b) => a + b, 0) / rvol3.length) : (rvol[n - 1] || 1);
  const curMacd = (macdLine[n - 1] || 0) - (macdSig[n - 1] || 0);
  const curRsi = rsi9[n - 1] || 50;
  const curNormObv = normObvDiffPct[n - 1] || 0;

  const volumeBuzzProxy = calculateVolumeBuzzProxy(bars, n, avgRvol3);
  const shakeoutInfo = detectMultiBarShakeout(bars, n);

  const validBw60 = bandwidth.slice(Math.max(0, n - 60)).filter(Number.isFinite);
  const recentBw5Slice = bandwidth.slice(-5).filter(Number.isFinite);
  const recentBw5Avg = recentBw5Slice.length
    ? recentBw5Slice.reduce((a, b) => a + b, 0) / recentBw5Slice.length
    : (bandwidth[n - 1] || 0.1);

  const sortedBw60 = [...validBw60].sort((a, b) => a - b);
  const rankIdx = sortedBw60.findIndex(v => v >= recentBw5Avg);
  const bbPercentile = sortedBw60.length ? ((rankIdx === -1 ? sortedBw60.length : rankIdx) / sortedBw60.length) * 100 : 50;
  const isExpanding = (bandwidth[n - 1] || 0) > (bandwidth[Math.max(0, n - 3)] || 0) * 1.04;

  if (onHudUpdate) {
    onHudUpdate({
      ticker: meta.code, name: meta.name, price: last, avgVol: avgVol20, dVol: avgDollarVol20,
      bars, ma20, ma60, ma200, bbUpper, bbLower, recentLow, targetPrice: targetInfo.targetPrice, upsidePct: targetInfo.upsidePct, shakeoutInfo, macdLine, macdSig, rsi9, rsi14,
      curCmf, curRvol: avgRvol3, curMacd, curRsi, curNormObv, isHealthyLongTrend, volumeBuzz: volumeBuzzProxy, bbPercentile, waveInfo
    });
  }

  const signals = {};
  signals.cmf = curCmf >= 0.10 ? { status: 'crossed', barsAgo: 0 } : curCmf >= 0.05 ? { status: 'imminent' } : curCmf >= 0.01 ? { status: 'approaching' } : { status: 'none' };
  signals.obv = curNormObv >= 6.0 ? { status: 'crossed', barsAgo: 0 } : curNormObv >= 2.5 ? { status: 'imminent' } : curNormObv >= 0.5 ? { status: 'approaching' } : { status: 'none' };
  signals.rvol = avgRvol3 >= 1.5 ? { status: 'crossed', barsAgo: 0 } : avgRvol3 >= 1.25 ? { status: 'imminent' } : avgRvol3 >= 1.1 ? { status: 'approaching' } : { status: 'none' };
  
  signals.ma_trend = maTrendState.status === 'crossed' && isHealthyLongTrend
    ? { status: 'crossed', barsAgo: maTrendState.barsAgo }
    : isHealthyLongTrend && maTrendState.status !== 'none'
    ? { status: maTrendState.status }
    : { status: 'none' };

  signals.bollinger = (() => {
    const crossedMid = (closes[n - 2] || last) <= (bbMid[n - 2] || last) && closes[n - 1] > (bbMid[n - 1] || last);
    if (bbPercentile <= 25 && crossedMid && isExpanding) return { status: 'crossed', barsAgo: 0, percentile: bbPercentile };
    if (bbPercentile <= 25 && crossedMid) return { status: 'imminent', percentile: bbPercentile };
    if (bbPercentile <= 35) return { status: 'approaching', percentile: bbPercentile };
    return { status: 'none', percentile: bbPercentile };
  })();

  signals.rsi = rsiState4Tier(rsi9, rsi14, 3);
  signals.shakeout = shakeoutInfo;
  signals.macd = macdState4Tier(macdLine, macdSig, 3);
  signals.social_buzz = volumeBuzzProxy;

  let rawVolScore = 0;
  let rawTrendScore = 0;
  let rawReboundScore = 0;
  let rawSocialScore = 0;
  const triggered = [];

  for (const ind of INDICATORS) {
    const s = signals[ind.key];
    let pts = 0;
    if (s?.status === 'crossed') {
      pts = ind.weight;
      triggered.push({ ...ind, ...s });
    } else if (s?.status === 'imminent') {
      pts = ind.weight * 0.5;
      triggered.push({ ...ind, ...s });
    } else if (s?.status === 'approaching') {
      pts = ind.weight * 0.25;
      triggered.push({ ...ind, ...s });
    }

    if (ind.category === 'vol') rawVolScore += pts;
    else if (ind.category === 'trend') rawTrendScore += pts;
    else if (ind.category === 'mom') rawReboundScore += pts;
    else if (ind.category === 'buzz') rawSocialScore += pts;
  }

  const reversalScore = clamp(rawTrendScore - ma20TrendPenalty, 0, 20);
  const accumulationScore = clamp(rawVolScore, 0, 25);
  const reboundScore = clamp(rawReboundScore, 0, 10);
  const socialScore = clamp(rawSocialScore, 0, 5);
  const indicatorScore = accumulationScore + reversalScore + reboundScore + socialScore;

  const baseTightness = clamp(1 - rangeRecent / 0.18, 0, 1);
  const distFromLow = (last - recentLow) / (recentLow || 1);
  const proximityScore = clamp(1 - Math.max(distFromLow, 0) / 0.08, 0, 1);

  const vol5 = sma(volumes, 5)[n - 1] || 1;
  const volDraughtMult = (vol5 / Math.max(avgVol20, 1)) < 0.35 ? 0.75 : 1.0;
  const bottomScore = clamp(
    40 * (0.50 * baseTightness + 0.50 * proximityScore) * volDraughtMult,
    0, 40
  );

  const ret5 = (last - (closes[n - 6] || last)) / (closes[n - 6] || last || 1);
  let overboughtPenalty = 0;
  if (ret5 > 0.18 || targetInfo.isOverheatedTop) {
    overboughtPenalty = 15;
  }

  const totalScore = clamp(
    bottomScore + indicatorScore + targetInfo.targetBonusScore + waveInfo.waveBonusScore - overboughtPenalty,
    0, 130
  );

  let archetype = '매집 탐색';
  if (waveInfo.waveBonusScore >= 12) {
    archetype = '🌊 M-W 지그재그 바닥형';
  } else if (shakeoutInfo.status === 'crossed') {
    archetype = '⚡ 저점 반등형';
  } else if (bottomScore >= 24 && bbPercentile <= 25) {
    archetype = '🏛️ 바닥 매집형';
  } else if (indicatorScore >= 16 && (signals.cmf.status === 'crossed' || signals.bollinger.status === 'crossed')) {
    archetype = '🚀 돌파 임박형';
  }

  const hudStart = Math.max(0, n - 60);

  return {
    dropped: false,
    meta, last, changeRate: meta.changeRate || 0,
    avgDollarVol20,
    signals, triggered,
    hasShakeout: shakeoutInfo.status === 'crossed',
    hasBuzzSurge: (volumeBuzzProxy.status === 'crossed'),
    isRealBuzz: false,
    volumeBuzzProxy,
    archetype,
    bottomScore,
    accumulationScore,
    reversalScore,
    reboundScore,
    socialScore,
    indicatorScore,
    targetPrice: targetInfo.targetPrice,
    targetZoneHigh: targetInfo.targetZoneHigh,
    upsidePct: targetInfo.upsidePct,
    targetBonusScore: targetInfo.targetBonusScore,
    zoneDesc: targetInfo.zoneDesc,
    waveInfo,
    overboughtPenalty,
    totalScore,
    rangeRecentPct: rangeRecent * 100,
    distFromLowPct: distFromLow * 100,
    bbPercentile,
    triggeredCount: triggered.length,

    bars: bars.slice(hudStart),
    ma20: ma20.slice(hudStart),
    ma60: ma60.slice(hudStart),
    ma200: ma200.slice(hudStart),
    bbUpper: bbUpper.slice(hudStart),
    bbLower: bbLower.slice(hudStart),
    recentLow,
    shakeoutInfo,
    macdLine: macdLine.slice(hudStart),
    rsi9: rsi9.slice(hudStart)
  };
}

const candleList = [];
const MAX_CANDLES = 14;
let candleTickCount = 0;
let currentPrice = 50;
let currentTrend = 1;
let trendDuration = 3;

function initMiniCandles() {
  candleList.length = 0;
  currentPrice = 50;
  candleTickCount = 0;
  currentTrend = Math.random() > 0.5 ? 1 : -1;
  trendDuration = Math.floor(Math.random() * 4) + 2;

  candleList.push({
    open: currentPrice,
    close: currentPrice,
    high: currentPrice,
    low: currentPrice
  });

  renderMiniCandles();
}

function updateMiniCandleTick() {
  if (!els.topMiniCandleSvg || candleList.length === 0) return;

  candleTickCount++;
  const activeCandle = candleList[candleList.length - 1];

  const tickDelta = (Math.random() - 0.48) * 3.5 + (currentTrend * 0.8);
  activeCandle.close = Math.max(10, activeCandle.close + tickDelta);
  activeCandle.high = Math.max(activeCandle.high, activeCandle.close + Math.random() * 1.8);
  activeCandle.low = Math.max(5, Math.min(activeCandle.low, activeCandle.close - Math.random() * 1.8));

  if (candleTickCount >= 12) {
    candleTickCount = 0;
    
    if (candleList.length >= MAX_CANDLES) {
      candleList.shift();
    }

    trendDuration--;
    if (trendDuration <= 0) {
      currentTrend = Math.random() > 0.5 ? 1 : -1;
      trendDuration = Math.floor(Math.random() * 4) + 2;
    }

    const newOpen = activeCandle.close;
    candleList.push({
      open: newOpen,
      close: newOpen,
      high: newOpen,
      low: newOpen
    });
  }

  renderMiniCandles();
}

function renderMiniCandles() {
  if (!els.topMiniCandleSvg) return;

  const W = 110;
  const H = 24;
  const candleW = 4.5;
  const gap = W / MAX_CANDLES;
  const padY = 2.5;

  let minP = Infinity;
  let maxP = -Infinity;
  for (const c of candleList) {
    if (c.low < minP) minP = c.low;
    if (c.high > maxP) maxP = c.high;
  }
  
  if (maxP === minP) {
    maxP += 5;
    minP -= 5;
  }
  const range = (maxP - minP) || 1;

  const getY = (val) => (H - padY) - ((val - minP) / range) * (H - padY * 2);

  const svgInner = candleList.map((c, i) => {
    const isUp = c.close >= c.open;
    const color = isUp ? 'var(--candle-up)' : 'var(--candle-down)';
    const glow = isUp ? '0 0 3px rgba(255,30,60,0.7)' : '0 0 3px rgba(59,130,246,0.7)';
    const x = i * gap + 1.5;

    const yOpen = getY(c.open);
    const yClose = getY(c.close);
    const yHigh = getY(c.high);
    const yLow = getY(c.low);

    const bodyTop = Math.min(yOpen, yClose);
    const bodyHeight = Math.max(1.5, Math.abs(yOpen - yClose));
    const centerX = x + candleW / 2;

    return `
      <line x1="${centerX.toFixed(1)}" y1="${yHigh.toFixed(1)}" x2="${centerX.toFixed(1)}" y2="${yLow.toFixed(1)}" stroke="${color}" stroke-width="1" opacity="0.9" />
      <rect x="${x.toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${candleW}" height="${bodyHeight.toFixed(1)}" rx="0.5" fill="${color}" style="filter: drop-shadow(${glow});" />
    `;
  }).join('');

  els.topMiniCandleSvg.innerHTML = svgInner;
}

const els = {};
function cacheEls() {
  [
    'minPrice','maxPrice','minDollarVol','mktNasdaq','mktNyse','mktAmex','modeAuto','modeCustom',
    'customTickerRow','customTickers','extraTickerRow','extraTickers','concurrencySel','useCache',
    'minIndicatorScore','minBottom','minUpsidePct','scanBtn','resultsEmpty','resultsList','resultsCount','legendList','clock',
    'topMiniCandleSvg',
    'scannerOverlay','overlayStopBtn','overlayProgressBar','overlayProgressPct','overlayProgressCount',
    'hudPassCount','hudDropCount','hudFailBanner','hudFailText','hudCurrentTicker','hudCurrentName','hudCurrentMeta',
    'hudDynamicSvg','hudArchetypeTag','hudCmfVal','hudObvVal','hudTargetVal','hudRvolVal','hudWaveVal','hudBuzzVal',
    'hudLogContainer','hudEtaText','hudSpeedText'
  ].forEach((id) => (els[id] = document.getElementById(id)));
}

function renderLegend() {
  els.legendList.innerHTML = [
    `<li><b>🏛️ 바닥 구조 안정성</b><span>40점</span></li>`,
    ...INDICATORS.map(i => `<li><b>${i.label}</b><span>${i.weight}점</span></li>`),
    `<li><b style="color:var(--target-cyan)">🎯 정밀 매물대 목표가 괴리율</b><span style="color:var(--target-cyan)">최대 +15점</span></li>`,
    `<li><b style="color:var(--wave-amber)">🌊 M-W 지그재그 바닥 다중지지</b><span style="color:var(--wave-amber)">최대 +15점</span></li>`
  ].join('');
}

function fmtUsd(v) {
  return '$' + (v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDollarVol(v) {
  if (!v || Number.isNaN(v)) return '$0/일';
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M/일`;
  return `$${(v / 1e3).toFixed(0)}K/일`;
}

function appendHudLog(msg, type = 'normal') {
  if (!els.hudLogContainer) return;
  const line = document.createElement('div');
  line.className = `hud-log ${
    type === 'wave' ? 'hud-log--wave' :
    type === 'pass' ? 'hud-log--pass' :
    type === 'drop' ? 'hud-log--drop' :
    type === 'buzz' ? 'hud-log--buzz' :
    type === 'error' ? 'hud-log--error' : ''
  }`;
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  line.textContent = `[${timeStr}] ${msg}`;
  els.hudLogContainer.prepend(line);
  if (els.hudLogContainer.children.length > 35) {
    els.hudLogContainer.removeChild(els.hudLogContainer.lastChild);
  }
}

function updateFailBanner() {
  if (!els.hudFailBanner) return;
  if (failCount === 0) {
    els.hudFailBanner.style.display = 'none';
    return;
  }
  els.hudFailBanner.style.display = 'block';
  els.hudFailText.textContent = `요청 지연/실패 ${failCount}건 발생 (자동 재시도 적용)`;
}

function renderResults(list) {
  els.resultsList.innerHTML = '';
  const top24List = list.slice(0, 24);
  els.resultsCount.textContent = `${top24List.length}개 포착 (상위 24선)`;

  if (!top24List.length) {
    els.resultsEmpty.style.display = 'block';
    els.resultsEmpty.textContent = failCount > 0
      ? `조건을 만족하는 종목을 찾지 못했습니다. (지연/실패 ${failCount}건)`
      : '조건에 부합하는 종목을 찾지 못했습니다. 기술 점수, 바닥 점수 또는 목표가 여력 슬라이더를 조정해보세요.';
    return;
  }
  els.resultsEmpty.style.display = 'none';

  top24List.forEach((r, idx) => {
    const rank = idx + 1;
    const chgClass = r.changeRate > 0 ? 'up' : r.changeRate < 0 ? 'down' : '';
    const chgSign = r.changeRate > 0 ? '+' : '';
    const isReal = !!r.signals.social_buzz?.isRealSource;
    
    const statusPriority = { 'crossed': 3, 'imminent': 2, 'approaching': 1, 'none': 0 };
    const sortedTriggered = [...r.triggered].sort((a, b) => {
      const pDiff = (statusPriority[b.status] || 0) - (statusPriority[a.status] || 0);
      if (pDiff !== 0) return pDiff;
      return b.weight - a.weight;
    });

    const tags = sortedTriggered.map((t) => {
      const isShake = t.key === 'shakeout' && t.status === 'crossed';
      const isBuzz = t.key === 'social_buzz';
      let tagClass = t.status === 'crossed' ? 'tag--crossed' : t.status === 'imminent' ? 'tag--imminent' : 'tag--approaching';
      
      if (isShake) tagClass = 'tag--shake';
      else if (isBuzz) tagClass = isReal ? 'tag--buzz-real' : 'tag--buzz-proxy';

      const statusLabel = t.status === 'crossed' ? (t.barsAgo ? ` · ${t.barsAgo}D전 전환` : ' · 포착') : t.status === 'imminent' ? ' · 임박' : ' · 접근';
      return `<span class="tag ${tagClass}">${t.label}${statusLabel}</span>`;
    });

    if (r.targetBonusScore > 0) {
      tags.unshift(`<span class="tag tag--target">🎯 목표가 ${fmtUsd(r.targetPrice)} (+${r.upsidePct.toFixed(0)}%)</span>`);
    }
    if (r.waveInfo?.waveBonusScore > 0) {
      tags.unshift(`<span class="tag tag--wave">🌊 M-W지그재그 (${r.waveInfo.waveRatio.toFixed(0)}%) +${r.waveInfo.waveBonusScore}점</span>`);
    }

    const reasons = [];
    if (r.waveInfo?.waveBonusScore > 0) {
      reasons.push(`<b style="color:var(--wave-amber)">[🌊 M-W 지그재그 가산 +${r.waveInfo.waveBonusScore}점]</b> ${r.waveInfo.desc}`);
    }
    if (r.targetBonusScore > 0) {
      reasons.push(`<b style="color:var(--target-cyan)">[🎯 목표가 괴리 가산 +${r.targetBonusScore}점]</b> ${r.zoneDesc}까지 <b>+${r.upsidePct.toFixed(1)}%</b> 상승 여력`);
    }
    reasons.push(`<b style="color:var(--red)">[${r.archetype}]</b> 포착 조건 충족`);
    if (r.signals.social_buzz && r.signals.social_buzz.status !== 'none') {
      reasons.push(`<b style="color:var(--red)">[${isReal ? '💬 실시간 소셜' : '⚡ 거래 가속'}]</b> ${r.signals.social_buzz.labelText}`);
    }
    if (r.hasShakeout) {
      reasons.push(`<b style="color:#10b981">[⚡ Shakeout]</b> 저점 지지 회복 및 Swing 반등 (+${r.distFromLowPct.toFixed(1)}%)`);
    }
    reasons.push(`볼린저 밴드 60일 <b>하위 ${r.bbPercentile.toFixed(0)}% 수축</b> 후 확장 진입`);
    reasons.push(`20일 변동폭 <b>${r.rangeRecentPct.toFixed(1)}%</b> 수렴 (바닥 안정)`);

    const card = document.createElement('li');
    card.className = 'card' + (rank <= 3 ? ' card--top' : '');
    card.innerHTML = `
      <div class="card__top-row">
        <div class="card__main-info">
          <span class="card__rank">${String(rank).padStart(2, '0')}</span>
          <span class="card__name" title="${r.meta.name}">${r.meta.name}</span>
          <span class="card__code">${r.meta.code}</span>
          <span class="card__archetype">${r.archetype}</span>
          <span class="card__market">${r.meta.market}</span>
          <span class="card__dvol">${fmtDollarVol(r.avgDollarVol20)}</span>
        </div>
        <div class="card__stats">
          <div class="card__price-row">
            <span class="card__price">${fmtUsd(r.last)}</span>
            <span class="card__chg ${chgClass}">${chgSign}${r.changeRate.toFixed(2)}%</span>
          </div>
          <div class="card__score-badge">종합 <b>${r.totalScore.toFixed(1)}</b>점</div>
        </div>
      </div>

      <div class="card__score-grid">
        <span class="score-pill" title="바닥 지지력">바닥 <b>${r.bottomScore.toFixed(0)}</b>/40</span>
        <span class="score-pill" title="자금 수급">수급 <b>${r.accumulationScore.toFixed(0)}</b>/25</span>
        <span class="score-pill" title="추세 전환">추세 <b>${r.reversalScore.toFixed(0)}</b>/20</span>
        <span class="score-pill" title="반등 모멘텀">반등 <b>${r.reboundScore.toFixed(0)}</b>/10</span>
        <span class="score-pill score-pill--target" title="목표가 괴리 가산점">목표가 <b>+${r.targetBonusScore}</b></span>
        <span class="score-pill score-pill--wave" title="M-W 지그재그 가산점">지그재그 <b>+${r.waveInfo?.waveBonusScore || 0}</b></span>
      </div>

      <div class="card__tags">${tags.join('') || '<span class="tag">신호 수렴 대기</span>'}</div>
      
      <ul class="card__reasons">
        ${reasons.map((x) => `<li>${x}</li>`).join('')}
      </ul>
    `;

    card.addEventListener('click', () => {
      els.hudCurrentTicker.textContent = r.meta.code;
      els.hudCurrentName.textContent = r.meta.name;
      els.hudCurrentMeta.textContent = `PRICE: $${r.last.toFixed(2)} | TARGET: $${r.targetPrice.toFixed(2)} (+${r.upsidePct.toFixed(0)}%) | D-VOL: ${fmtDollarVol(r.avgDollarVol20)}`;
      els.hudArchetypeTag.textContent = `ARCHETYPE: ${r.archetype}`;
      
      els.hudCmfVal.textContent = r.signals.cmf?.status !== 'none' ? `+${(r.accumulationScore*0.01).toFixed(2)}` : '0.00';
      els.hudObvVal.textContent = `${r.accumulationScore >= 10 ? '+' : ''}${(r.accumulationScore * 0.8).toFixed(1)}%`;
      els.hudTargetVal.textContent = `$${r.targetPrice.toFixed(2)} (+${r.upsidePct.toFixed(0)}%)`;
      els.hudRvolVal.textContent = `${(1 + r.accumulationScore * 0.05).toFixed(1)}x`;
      els.hudWaveVal.textContent = `+${r.waveInfo?.waveBonusScore || 0}점 (${r.waveInfo?.waveRatio.toFixed(0)}%)`;
      els.hudBuzzVal.textContent = r.signals.social_buzz?.labelText || '평이';

      renderHudSvgChart(r.bars, r.ma20, r.ma60, r.ma200, r.bbUpper, r.bbLower, r.recentLow, r.targetPrice, r.shakeoutInfo, r.macdLine, r.rsi9, r.waveInfo);
      els.scannerOverlay.classList.add('is-active');
    });

    els.resultsList.appendChild(card);
  });
}

function parseExtraTickers(raw) {
  if (!raw || !raw.trim()) return null;
  const set = new Set(raw.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean));
  return set.size ? set : null;
}

async function buildUniverse() {
  if (els.modeCustom.checked) {
    const raw = els.customTickers.value || '';
    const codes = raw.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    return codes.map((code) => ({ code, name: code, market: 'CUSTOM', price: null, changeRate: 0 }));
  }

  const wanted = [];
  if (els.mktNasdaq.checked) wanted.push('NASDAQ');
  if (els.mktNyse.checked) wanted.push('NYSE');
  if (els.mktAmex.checked) wanted.push('AMEX');
  if (!wanted.length) throw new Error('거래소를 최소 하나 이상 선택하세요.');

  const useCache = els.useCache.checked;
  let universe = [];
  for (const ex of wanted) {
    if (!IS_SCANNING) return [];

    if (useCache) {
      const cached = getCachedUniverse(EXCHANGES[ex].param);
      if (cached) {
        cached.forEach((r) => (r.market = ex));
        appendHudLog(`${EXCHANGES[ex].label} 로컬 캐시 로드 (${cached.length}개 보통주)`);
        universe = universe.concat(cached);
        continue;
      }
    }

    appendHudLog(`${EXCHANGES[ex].label} 보통주 유니버스 다운로드 중...`);
    try {
      const rows = await fetchExchangeList(EXCHANGES[ex].param);
      rows.forEach((r) => (r.market = ex));
      universe = universe.concat(rows);
      if (useCache) setCachedUniverse(EXCHANGES[ex].param, rows);
    } catch (e) {
      appendHudLog(`[오류] ${EXCHANGES[ex].label} 로드 실패 — ${e.message}`, 'error');
    }
  }

  const extraSet = parseExtraTickers(els.extraTickers?.value);
  if (!els.modeCustom.checked && extraSet) {
    let added = 0;
    extraSet.forEach((code) => {
      if (!universe.some(r => r.code === code)) {
        universe.push({ code, name: code, market: 'EXTRA', price: null, changeRate: 0 });
        added++;
      }
    });
    if (added > 0) appendHudLog(`강제 분석 관심 종목 유니버스 삽입: ${added}개`);
  }

  const uniqueMap = new Map();
  universe.forEach((r) => {
    const key = r.code.toUpperCase();
    if (!uniqueMap.has(key)) uniqueMap.set(key, r);
  });
  return Array.from(uniqueMap.values());
}

async function runScan() {
  IS_SCANNING = true;
  failCount = 0;
  passCount = 0;
  dropCount = 0;

  const isCustomMode = els.modeCustom.checked;
  const filterOpts = {
    minPrice: num(els.minPrice.value) || 0,
    maxPrice: num(els.maxPrice.value) || Infinity,
    minDollarVol: num(els.minDollarVol.value) || 0,
    minUpsidePct: parseFloat(els.minUpsidePct?.value || 4.0)
  };
  const minIndicatorScore = parseFloat(els.minIndicatorScore.value) || 0;
  const minBottom = parseInt(els.minBottom.value, 10) || 0;
  CONCURRENCY = parseInt(els.concurrencySel.value, 10) || 6;

  const extraSet = parseExtraTickers(els.extraTickers?.value);

  els.scannerOverlay.classList.add('is-active');
  els.hudLogContainer.innerHTML = '';
  els.overlayProgressBar.style.width = '0%';
  els.overlayProgressPct.textContent = '0.0%';
  els.hudPassCount.textContent = '0';
  els.hudDropCount.textContent = '0';
  els.hudEtaText.textContent = '계산 중…';
  els.scanBtn.disabled = true;
  updateFailBanner();

  appendHudLog(`Phase 1: 펌프앤덤프 검증 및 M-W 지그재그 피벗 퀀트 엔진 가동`);

  try {
    const candidates = await buildUniverse();

    if (!candidates.length) {
      appendHudLog('스캔 대상 티커가 없습니다. 티커명을 확인해주세요.', 'drop');
      await sleep(800);
      renderResults([]);
      return;
    }

    appendHudLog(`유니버스 로드 완료: ${candidates.length}개 보통주 분석 (동시 ${CONCURRENCY}스레드)`);

    const analyzedPhase1 = [];
    let queueIndex = 0;
    let completedCount = 0;
    const startTime = Date.now();

    const worker = async () => {
      while (IS_SCANNING) {
        if (queueIndex >= candidates.length) break;
        const c = candidates[queueIndex++];
        
        const isExtra = (!isCustomMode && extraSet && extraSet.has(c.code));

        try {
          const bars = await fetchHistory(c.code);
          if (bars && bars.length) {
            const res = analyzeStockPhase1(
              { code: c.code, name: c.name, market: c.market, changeRate: c.changeRate || 0 },
              bars,
              filterOpts,
              isCustomMode || isExtra,
              (info) => {
                const now = Date.now();
                if (now - lastHudRenderTime > 100) {
                  lastHudRenderTime = now;
                  requestAnimationFrame(() => {
                    els.hudCurrentTicker.textContent = info.ticker;
                    els.hudCurrentName.textContent = info.name;
                    els.hudCurrentMeta.textContent = `PRICE: $${info.price.toFixed(2)} | VOL: ${(info.avgVol/1000).toFixed(0)}K | TARGET: $${info.targetPrice.toFixed(2)} (+${info.upsidePct.toFixed(0)}%)`;
                    els.hudArchetypeTag.textContent = `WAVE: +${info.waveInfo?.waveBonusScore || 0}점`;

                    renderHudSvgChart(
                      info.bars, info.ma20, info.ma60, info.ma200, info.bbUpper, info.bbLower, info.recentLow, info.targetPrice,
                      info.shakeoutInfo, info.macdLine, info.rsi9, info.waveInfo
                    );

                    els.hudCmfVal.textContent = info.curCmf >= 0 ? `+${info.curCmf.toFixed(2)}` : info.curCmf.toFixed(2);
                    els.hudCmfVal.className = `sub-metric-val ${info.curCmf >= 0.1 ? 'is-gc' : ''}`;

                    els.hudObvVal.textContent = info.curNormObv >= 0 ? `+${info.curNormObv.toFixed(1)}%` : `${info.curNormObv.toFixed(1)}%`;
                    els.hudObvVal.className = `sub-metric-val ${info.curNormObv >= 3.0 ? 'is-gc' : ''}`;

                    els.hudTargetVal.textContent = `$${info.targetPrice.toFixed(2)} (+${info.upsidePct.toFixed(0)}%)`;

                    els.hudRvolVal.textContent = `${info.curRvol.toFixed(1)}x`;
                    els.hudRvolVal.className = `sub-metric-val ${info.curRvol >= 1.4 ? 'is-hot' : ''}`;

                    els.hudWaveVal.textContent = `+${info.waveInfo?.waveBonusScore || 0}점 (${info.waveInfo?.waveRatio.toFixed(0)}%)`;
                    els.hudWaveVal.className = `sub-metric-val ${info.waveInfo?.waveBonusScore >= 12 ? 'is-wave' : ''}`;

                    els.hudBuzzVal.textContent = info.volumeBuzz.labelText;
                    els.hudBuzzVal.className = `sub-metric-val ${info.volumeBuzz.status === 'crossed' ? 'is-proxy' : ''}`;
                  });
                }
              }
            );

            if (res && !res.dropped) {
              passCount++;
              els.hudPassCount.textContent = passCount;
              analyzedPhase1.push(res);
              if (res.waveInfo?.waveBonusScore >= 12) {
                appendHudLog(`[🌊지그재그] ${c.code} (${c.name}) - 바닥 ${res.waveInfo.bottomSupportCount}중 지지 (+${res.waveInfo.waveBonusScore}점)`, 'wave');
              } else {
                appendHudLog(`[포착] ${c.code} (${c.name}) - 종합: ${res.totalScore.toFixed(0)}점 (목표가 +${res.upsidePct.toFixed(0)}%)`, 'pass');
              }
            } else if (res && res.dropped) {
              dropCount++;
              els.hudDropCount.textContent = dropCount;
              appendHudLog(`[제외] ${c.code} - ${res.reason}`, 'drop');
            }
          } else {
            dropCount++;
            els.hudDropCount.textContent = dropCount;
            appendHudLog(`[제외] ${c.code} - 시세 데이터 없음`, 'drop');
          }
        } catch (e) {
          if (e.message !== 'SCAN_ABORTED') {
            dropCount++;
            els.hudDropCount.textContent = dropCount;
            appendHudLog(`[제외] ${c.code} 분석 실패 - ${e.message}`, 'error');
          }
        }

        completedCount++;
        const pct = (completedCount / candidates.length) * 100;
        els.overlayProgressBar.style.width = pct.toFixed(1) + '%';
        els.overlayProgressPct.textContent = pct.toFixed(1) + '%';
        els.overlayProgressCount.textContent = `${completedCount} / ${candidates.length} 종목`;
        updateFailBanner();

        const elapsedSec = (Date.now() - startTime) / 1000;
        const speed = completedCount / Math.max(elapsedSec, 0.1);
        const remSec = Math.max(0, Math.round((candidates.length - completedCount) / Math.max(speed, 0.1)));

        els.hudSpeedText.textContent = `속도: ${speed.toFixed(1)} ops/s`;
        if (remSec > 60) {
          const m = Math.floor(remSec / 60);
          const s = remSec % 60;
          els.hudEtaText.textContent = `약 ${m}분 ${s}초 남음`;
        } else {
          els.hudEtaText.textContent = `약 ${remSec}초 남음`;
        }
      }
    };

    const workers = Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker());
    await Promise.all(workers);

    if (!IS_SCANNING) return;

    const topCandidates = isCustomMode
      ? analyzedPhase1
      : analyzedPhase1
          .slice()
          .sort((a, b) => b.totalScore - a.totalScore)
          .slice(0, 40);

    if (topCandidates.length > 0) {
      appendHudLog(`Phase 2: ${topCandidates.length}개 대상 실시간 Social Velocity 검증 중...`);
      for (const item of topCandidates) {
        if (!IS_SCANNING) break;
        const buzzResult = await fetchRealStockTwitsBuzz(item.meta.code, item.volumeBuzzProxy);
        if (buzzResult) {
          item.signals.social_buzz = buzzResult;
          item.isRealBuzz = buzzResult.isRealSource;
          item.hasBuzzSurge = (buzzResult.status === 'crossed');
          item.socialScore = buzzResult.buzzScore;

          item.indicatorScore = item.accumulationScore + item.reversalScore + item.reboundScore + item.socialScore;
          item.totalScore = clamp(
            item.bottomScore + item.indicatorScore + item.targetBonusScore + (item.waveInfo?.waveBonusScore || 0) - (item.overboughtPenalty || 0),
            0, 130
          );

          if (buzzResult.isRealSource) {
            appendHudLog(`[💬StockTwits] ${item.meta.code} - ${buzzResult.labelText}`, 'buzz');
          }
        }
      }
    }

    appendHudLog(`스캔 완료 (포착: ${passCount}건, 제외: ${dropCount}건, 지연: ${failCount}건) — 상위 24선 렌더링`);
    await sleep(250);

    analyzedPhase1.sort((a, b) => b.totalScore - a.totalScore);

    let qualified = isCustomMode
      ? analyzedPhase1
      : analyzedPhase1.filter((r) => 
          (r.indicatorScore >= minIndicatorScore && r.bottomScore >= minBottom) || 
          (extraSet && extraSet.has(r.meta.code))
        );

    let finalTop24 = qualified.slice(0, 24);
    if (finalTop24.length < 24 && analyzedPhase1.length > 0) {
      const remaining = analyzedPhase1.filter(r => !finalTop24.some(q => q.meta.code === r.meta.code));
      finalTop24 = finalTop24.concat(remaining.slice(0, 24 - finalTop24.length));
    }

    renderResults(finalTop24);

  } catch (e) {
    if (e.message !== 'SCAN_ABORTED') {
      console.error(e);
      appendHudLog(`[오류] ${e.message}`, 'error');
      alert('스캔 중 문제가 발생했습니다: ' + e.message);
    }
  } finally {
    IS_SCANNING = false;
    els.scanBtn.disabled = false;
    els.scannerOverlay.classList.remove('is-active');
  }
}

function tickClock() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  if (els.clock) els.clock.textContent = `${h}:${m}:${s}`;
}

document.addEventListener('DOMContentLoaded', () => {
  cacheEls();
  renderLegend();
  initMiniCandles();
  tickClock();
  
  setInterval(tickClock, 1000);
  setInterval(updateMiniCandleTick, 500);

  els.scanBtn.addEventListener('click', runScan);
  els.overlayStopBtn.addEventListener('click', () => {
    IS_SCANNING = false;
    els.scannerOverlay.classList.remove('is-active');
  });

  const toggleCustom = () => {
    const isCustom = els.modeCustom.checked;
    if (els.customTickerRow) {
      els.customTickerRow.style.display = isCustom ? 'flex' : 'none';
    }
    if (els.extraTickerRow) {
      els.extraTickerRow.style.display = isCustom ? 'none' : 'flex';
    }
  };
  els.modeAuto.addEventListener('change', toggleCustom);
  els.modeCustom.addEventListener('change', toggleCustom);
  toggleCustom();
});
