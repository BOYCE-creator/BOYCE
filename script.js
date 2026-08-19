const PROXY = 'https://lingering-mountain-1e41.swc4876.workers.dev/?url=';

const EXCHANGES = {
  NASDAQ: { param: 'NASDAQ', label: 'NASDAQ' },
  NYSE:   { param: 'NYSE',   label: 'NYSE'   },
  AMEX:   { param: 'AMEX',   label: 'AMEX'   },
};

const HISTORY_RANGE  = '6mo';
const HISTORY_INTERVAL = '1d';
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_KEY_PREFIX = 'scanner_universe_cache_';

let IS_SCANNING = false;
let CONCURRENCY = 5;
let failCount = 0;

// 커뮤니티 급증(buzz_surge) 지표 추가
const INDICATORS = [
  { key: 'shakeout',    label: '⚡ 극초기 개미털기(Shakeout)', weight: 16 },
  { key: 'buzz_surge',  label: '🔥 커뮤니티 언급량 급증(버즈)', weight: 14 },
  { key: 'cmf',         label: 'CMF 자금유입 (기관매집)',    weight: 14 },
  { key: 'rvol',        label: 'RVOL 상대거래량 급증',       weight: 12 },
  { key: 'up_down_vol', label: '상승/하락 거래량 우위',     weight: 10 },
  { key: 'obv',         label: 'OBV 추세 상승 전환',         weight: 10 },
  { key: 'ma_20_60',    label: 'MA 20/60 골든크로스',       weight: 10 },
  { key: 'bollinger',   label: '볼린저밴드 수축 후 돌파',    weight: 8  },
  { key: 'macd',        label: 'MACD 골든크로스',           weight: 8  },
  { key: 'rsi',         label: 'Wilder RSI GC (9/14)',    weight: 8  },
];
const INDICATOR_WEIGHT_SUM = INDICATORS.reduce((s, i) => s + i.weight, 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(v) {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return NaN;
  return parseFloat(String(v).replace(/[$,%]/g, ''));
}

async function fetchViaProxy(targetUrl, { tries = 2, label = '' } = {}) {
  const url = PROXY + encodeURIComponent(targetUrl);
  let lastErr;
  for (let i = 0; i < tries; i++) {
    if (!IS_SCANNING) throw new Error('SCAN_ABORTED');
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        await sleep(500 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(150 * Math.pow(2, i));
    }
  }
  failCount++;
  throw new Error(`${label || targetUrl} 실패: ${lastErr ? lastErr.message : 'error'}`);
}

// 실시간 종목 커뮤니티 버즈(StockTwits 스트림 기반) 급증 분석
async function fetchCommunityBuzz(symbol) {
  try {
    const target = `https://api.stocktwits.com/api/2/streams/symbol/${symbol}.json`;
    const json = await fetchViaProxy(target, { tries: 1, label: `${symbol} 커뮤니티` });
    if (!json || !json.messages || !Array.isArray(json.messages)) return { count24h: 0, isSurge: false, ratioText: '0건' };

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const posts24h = json.messages.filter(m => new Date(m.created_at).getTime() > oneDayAgo);
    const count = posts24h.length;

    // 평소 1~2건 수준이던 종목에 24시간 내 6개 이상 메시지가 집중될 때 급증 판정
    const isSurge = count >= 6;
    return {
      count24h: count,
      isSurge,
      ratioText: `24H ${count}건${isSurge ? ' (급증)' : ''}`
    };
  } catch (e) {
    return { count24h: 0, isSurge: false, ratioText: '0건' };
  }
}

function isCommonStock(item) {
  const code = (item.code || '').trim().toUpperCase();
  const name = (item.name || '').toLowerCase();
  if (/[.\-+](WS|WT|W|U|RT|PR|UN|R|CL)$/i.test(code)) return false;
  if (code.includes('^') || code.includes('/') || code.length > 5) return false;
  const hardExclude = ['preferred', 'pref', ' etf', 'etn', 'depositary', 'warrant', 'unit', 'spdr', 'ishares', 'vanguard', 'invesco', 'direxion', 'proshares', 'class b'];
  if (hardExclude.some((kw) => name.includes(kw))) return false;
  const spacPatterns = [/blank check/, /\bspac\b/, /acquisition corp/, /special purpose acquisition/];
  if (spacPatterns.some((re) => re.test(name))) return false;
  return true;
}

async function fetchExchangeList(exchangeParam) {
  const target = `https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=8000&exchange=${exchangeParam}`;
  const json = await fetchViaProxy(target, { label: `${exchangeParam} 리스트` });
  const rows = json?.data?.table?.rows || [];
  return rows.map((r) => ({
    code: r.symbol,
    name: r.name || r.companyName || r.symbol,
    price: num(r.lastsale),
    changeRate: num(r.pctchange),
  })).filter((r) => r.code && !Number.isNaN(r.price) && r.price > 0 && isCommonStock(r));
}

function getCachedUniverse(exchangeParam) {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY_PREFIX + exchangeParam);
    if (!raw) return null;
    const { ts, rows } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL_MS) return null;
    return rows;
  } catch (e) { return null; }
}

function setCachedUniverse(exchangeParam, rows) {
  try { sessionStorage.setItem(CACHE_KEY_PREFIX + exchangeParam, JSON.stringify({ ts: Date.now(), rows })); } catch (e) {}
}

async function fetchHistory(symbol) {
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${HISTORY_RANGE}&interval=${HISTORY_INTERVAL}`;
  const json = await fetchViaProxy(target, { label: `${symbol} 히스토리` });
  const result = json?.chart?.result?.[0];
  if (!result) return null;
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close?.[i];
    if (close === null || close === undefined || Number.isNaN(close)) continue;
    bars.push({
      date: ts[i],
      open: q.open ? q.open[i] : close,
      high: q.high ? q.high[i] : close,
      low: q.low ? q.low[i] : close,
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
  const macdLine = closes.map((_, i) => (Number.isNaN(emaFast[i]) || Number.isNaN(emaSlow[i]) ? NaN : emaFast[i] - emaSlow[i]));
  const signal = new Array(closes.length).fill(NaN);
  const valids = macdLine.map((v, i) => ({ v, i })).filter((x) => !Number.isNaN(x.v));
  if (valids.length >= signalPeriod) {
    const emaSig = ema(valids.map((x) => x.v), signalPeriod);
    emaSig.forEach((val, idx) => { if (!Number.isNaN(val)) signal[valids[idx].i] = val; });
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
  let avgGain = gainSum / period, avgLoss = lossSum / period;
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
      sumMfv += mfv; sumVol += volumes[j];
    }
    out[i] = sumVol === 0 ? 0 : sumMfv / sumVol;
  }
  return out;
}

function rvolCalc(volumes, period = 20) {
  const volMa = sma(volumes, period);
  return volumes.map((v, i) => (Number.isNaN(volMa[i]) || volMa[i] === 0 ? 1 : v / volMa[i]));
}

function obvCalc(closes, volumes) {
  const out = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) out[i] = out[i - 1] + volumes[i];
    else if (closes[i] < closes[i - 1]) out[i] = out[i - 1] - volumes[i];
    else out[i] = out[i - 1];
  }
  return out;
}

function bollingerCalc(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(NaN);
  const lower = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = mid[i];
    if (Number.isNaN(mean)) continue;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + mult * sd; lower[i] = mean - mult * sd;
  }
  return { mid, upper, lower };
}

function crossState(shortArr, longArr, lookback = 3, imminentGapPct = 3) {
  const n = shortArr.length;
  const diff = shortArr.map((v, i) => v - longArr[i]);
  for (let back = 0; back < lookback; back++) {
    const i = n - 1 - back, p = i - 1;
    if (p < 0) break;
    if (Number.isNaN(diff[i]) || Number.isNaN(diff[p])) continue;
    if (diff[p] <= 0 && diff[i] > 0) return { status: 'crossed', barsAgo: back };
  }
  const last = diff[n - 1], prev = diff[n - 2];
  if (typeof last === 'number' && typeof prev === 'number' && !Number.isNaN(last) && !Number.isNaN(prev)) {
    const converging = last > prev;
    const gapPct = Math.abs(last) / Math.max(Math.abs(longArr[n - 1]), 1e-6) * 100;
    if (last < 0 && converging && gapPct <= imminentGapPct) return { status: 'imminent', gapPct };
  }
  return { status: 'none' };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function detectEarlyShakeout(bars, recentLow, n) {
  const last = bars[n - 1].close;
  const distFromLow = (last - recentLow) / recentLow;
  if (distFromLow > 0.08 || distFromLow < -0.01) return { status: 'none' };

  for (let i = n - 4; i < n; i++) {
    if (i < 0) continue;
    const b = bars[i];
    const range = b.high - b.low;
    const lowerTail = Math.min(b.open, b.close) - b.low;
    const isHammer = range > 0 && (lowerTail / range >= 0.52) && (b.close >= b.low * 1.02);
    const isSpringTrap = (b.low <= recentLow * 1.005) && (last >= recentLow * 0.995);
    if (isHammer || isSpringTrap) {
      return { status: 'crossed', barsAgo: n - 1 - i, shakeoutIndex: i, shakeoutPrice: b.low };
    }
  }
  if (distFromLow >= 0.005 && distFromLow <= 0.035) return { status: 'imminent' };
  return { status: 'none' };
}

function renderHudSvgChart(bars, ma20, ma60, bbUpper, bbLower, recentLow, shakeoutInfo) {
  if (!bars || bars.length < 20) return;
  const W = 480, H = 145, PAD_X = 8, PAD_Y = 12;
  const sliceBars = bars.slice(-40);
  const n = sliceBars.length;
  const closes = sliceBars.map((b) => b.close);
  const volumes = sliceBars.map((b) => b.volume);

  const startIdx = bars.length - n;
  const sliceMa20 = ma20.slice(startIdx);
  const sliceMa60 = ma60.slice(startIdx);
  const sliceBbU = bbUpper.slice(startIdx);
  const sliceBbL = bbLower.slice(startIdx);

  const validVals = [...closes, ...sliceMa20, ...sliceMa60, ...sliceBbU, ...sliceBbL, recentLow].filter(v => typeof v === 'number' && !Number.isNaN(v));
  const minVal = Math.min(...validVals), maxVal = Math.max(...validVals);
  const range = maxVal - minVal || 1;
  const maxVol = Math.max(...volumes) || 1;

  const getX = (i) => PAD_X + (i / (n - 1)) * (W - PAD_X * 2);
  const getY = (val) => H - PAD_Y - ((val - minVal) / range) * (H - PAD_Y * 2);

  const volBars = sliceBars.map((b, i) => {
    const vH = (b.volume / maxVol) * 26;
    return `<rect x="${(getX(i)-2).toFixed(1)}" y="${(H-vH-2).toFixed(1)}" width="4" height="${vH.toFixed(1)}" fill="${b.close >= b.open ? 'rgba(31,200,115,0.22)' : 'rgba(239,74,82,0.18)'}" />`;
  }).join('');

  const pricePts = closes.map((c, i) => `${getX(i).toFixed(1)},${getY(c).toFixed(1)}`).join(' ');
  const ma20Pts = sliceMa20.map((m, i) => Number.isNaN(m) ? null : `${getX(i).toFixed(1)},${getY(m).toFixed(1)}`).filter(Boolean).join(' ');
  const ma60Pts = sliceMa60.map((m, i) => Number.isNaN(m) ? null : `${getX(i).toFixed(1)},${getY(m).toFixed(1)}`).filter(Boolean).join(' ');
  const bbUPts = sliceBbU.map((u, i) => Number.isNaN(u) ? null : `${getX(i).toFixed(1)},${getY(u).toFixed(1)}`).filter(Boolean).join(' ');
  const bbLPts = sliceBbL.map((l, i) => Number.isNaN(l) ? null : `${getX(i).toFixed(1)},${getY(l).toFixed(1)}`).filter(Boolean).join(' ');
  const baseLineY = getY(recentLow).toFixed(1);

  els.hudDynamicSvg.innerHTML = `
    <g class="hud-vol-layer">${volBars}</g>
    <line x1="${PAD_X}" y1="${baseLineY}" x2="${W-PAD_X}" y2="${baseLineY}" stroke="var(--up)" stroke-width="1.2" stroke-dasharray="4,4" />
    <text x="${W-PAD_X-4}" y="${baseLineY - 3}" fill="var(--up)" font-family="JetBrains Mono" font-size="8.5" text-anchor="end">BASE $${recentLow.toFixed(2)}</text>
    ${bbUPts ? `<polyline fill="none" stroke="rgba(56,189,248,0.35)" stroke-width="1" stroke-dasharray="2,2" points="${bbUPts}" />` : ''}
    ${bbLPts ? `<polyline fill="none" stroke="rgba(56,189,248,0.35)" stroke-width="1" stroke-dasharray="2,2" points="${bbLPts}" />` : ''}
    ${ma60Pts ? `<polyline fill="none" stroke="var(--purple)" stroke-width="1.4" opacity="0.85" points="${ma60Pts}" />` : ''}
    ${ma20Pts ? `<polyline fill="none" stroke="var(--gold)" stroke-width="1.6" points="${ma20Pts}" />` : ''}
    <polyline fill="none" stroke="var(--cyan)" stroke-width="2" points="${pricePts}" />
    <circle cx="${getX(n-1)}" cy="${getY(closes[n-1])}" r="3.5" fill="var(--cyan)" />
  `;
}

async function analyzeStock(meta, bars, minDollarVol, onHudUpdate) {
  if (!bars || bars.length < 50) return null;

  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const volumes = bars.map((b) => b.volume);
  const n = closes.length;
  const last = closes[n - 1];

  const vol20Arr = sma(volumes, 20);
  const avgVol20 = vol20Arr[n - 1];
  const avgDollarVol20 = avgVol20 * last;

  const win = Math.min(20, n - 1);
  const recentHigh = Math.max(...highs.slice(n - win));
  const recentLow = Math.min(...lows.slice(n - win));
  const rangeRecent = (recentHigh - recentLow) / recentLow;

  if (rangeRecent < 0.015) return { dropped: true, reason: `스팩/시체주 의심 (20일 변동폭 ${(rangeRecent*100).toFixed(1)}% < 1.5%)` };
  if (Number.isNaN(avgDollarVol20) || avgDollarVol20 < minDollarVol) return { dropped: true, reason: `거래대금 미달` };

  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  if (last < ma20[n - 1] * 0.94) return { dropped: true, reason: `20일선 이탈` };

  const { macdLine, signal: macdSig } = macdCalc(closes);
  const rsi14 = rsiCalc(closes, 14);
  const rsi9 = rsiCalc(closes, 9);
  const cmf = cmfCalc(highs, lows, closes, volumes, 20);
  const rvol = rvolCalc(volumes, 20);
  const obv = obvCalc(closes, volumes);
  const obvMa = sma(obv, 20);
  const { mid: bbMid, upper: bbUpper, lower: bbLower } = bollingerCalc(closes);

  const curCmf = cmf[n - 1] || 0;
  const curRvol = rvol[n - 1] || 1;
  const curMacd = macdLine[n - 1] - macdSig[n - 1];
  const curRsi = rsi9[n - 1];
  const curObvDiff = obv[n - 1] - obvMa[n - 1];

  let upVolSum = 0, downVolSum = 0;
  for (let i = Math.max(1, n - 14); i < n; i++) {
    if (closes[i] > closes[i - 1]) upVolSum += volumes[i];
    else if (closes[i] < closes[i - 1]) downVolSum += volumes[i];
  }
  const upDownRatio = downVolSum === 0 ? 2.0 : upVolSum / downVolSum;

  const shakeoutInfo = detectEarlyShakeout(bars, recentLow, n);
  const buzzData = await fetchCommunityBuzz(meta.code);

  if (onHudUpdate) {
    onHudUpdate({
      ticker: meta.code, name: meta.name, price: last, avgVol: avgVol20, dVol: avgDollarVol20,
      bars, ma20, ma60, bbUpper, bbLower, recentLow, shakeoutInfo,
      curCmf, curRvol, curMacd, curRsi, curObvDiff, upDownRatio
    });
  }

  const signals = {};
  signals.shakeout = shakeoutInfo;
  signals.buzz_surge = buzzData.isSurge ? { status: 'crossed', barsAgo: 0, desc: buzzData.ratioText } : (buzzData.count24h >= 3 ? { status: 'imminent', desc: buzzData.ratioText } : { status: 'none' });
  signals.cmf = curCmf >= 0.12 ? { status: 'crossed', barsAgo: 0 } : curCmf >= 0.05 ? { status: 'imminent' } : { status: 'none' };
  signals.rvol = curRvol >= 1.7 ? { status: 'crossed', barsAgo: 0 } : curRvol >= 1.3 ? { status: 'imminent' } : { status: 'none' };
  signals.up_down_vol = upDownRatio >= 1.35 ? { status: 'crossed', barsAgo: 0 } : upDownRatio >= 1.15 ? { status: 'imminent' } : { status: 'none' };
  signals.obv = crossState(obv, obvMa, 3, 999);
  signals.ma_20_60 = crossState(ma20, ma60, 3, 2.5);
  signals.macd = crossState(macdLine, macdSig, 3, 999);
  signals.rsi = crossState(rsi9, rsi14, 3, 5);

  signals.bollinger = (() => {
    const bw = (i) => (bbUpper[i] - bbLower[i]) / bbMid[i];
    const recentBw = bw(n - 4), pastBw = bw(n - 20);
    const crossedMid = closes[n - 2] <= bbMid[n - 2] && closes[n - 1] > bbMid[n - 1];
    if (!Number.isNaN(recentBw) && !Number.isNaN(pastBw) && recentBw < pastBw * 0.75 && crossedMid) return { status: 'crossed', barsAgo: 0 };
    if (!Number.isNaN(recentBw) && recentBw < pastBw * 0.6) return { status: 'imminent' };
    return { status: 'none' };
  })();

  let rawIndicatorScore = 0;
  const triggered = [];
  for (const ind of INDICATORS) {
    const s = signals[ind.key];
    if (s.status === 'crossed') { rawIndicatorScore += ind.weight; triggered.push({ ...ind, ...s }); }
    else if (s.status === 'imminent') { rawIndicatorScore += ind.weight * 0.5; triggered.push({ ...ind, ...s }); }
  }
  const indicatorScore = (rawIndicatorScore / INDICATOR_WEIGHT_SUM) * 45;

  const baseTightness = clamp(1 - rangeRecent / 0.25, 0, 1);
  const distFromLow = (last - recentLow) / recentLow;
  const proximityScore = clamp(1 - Math.max(distFromLow, 0) / 0.16, 0, 1);
  const bottomScore = 40 * (0.55 * baseTightness + 0.45 * proximityScore);

  const ret5 = (last - closes[n - 6]) / closes[n - 6];
  let momentumScore = 0;
  if (ret5 > 0 && ret5 <= 0.12) momentumScore = (ret5 / 0.12) * 15;
  else if (ret5 > 0.12) momentumScore = Math.max(15 - (ret5 - 0.12) * 80, 2);

  const totalScore = bottomScore + indicatorScore + momentumScore;

  return {
    dropped: false,
    meta, last, changeRate: meta.changeRate,
    avgDollarVol20,
    signals, triggered,
    hasShakeout: shakeoutInfo.status === 'crossed',
    hasBuzz: buzzData.isSurge,
    bottomScore, indicatorScore, momentumScore, totalScore,
    rangeRecentPct: rangeRecent * 100,
    distFromLowPct: distFromLow * 100,
    triggeredCount: triggered.length,
    buzzDesc: buzzData.ratioText,
  };
}

const els = {};
function cacheEls() {
  ['minPrice','maxPrice','minDollarVol','mktNasdaq','mktNyse','mktAmex','modeAuto','modeCustom','customTickerRow','customTickers',
   'tossWhitelist','concurrencySel','useCache','minSignals','minBottom','scanBtn','resultsEmpty','resultsList','resultsCount','legendList','clock',
   'scannerOverlay','overlayStopBtn','overlayProgressBar','overlayProgressPct','overlayProgressCount','hudFailBanner','hudFailText',
   'hudCurrentTicker','hudCurrentName','hudCurrentMeta','hudDynamicSvg',
   'hudCmfVal','hudRvolVal','hudMacdVal','hudRsiVal','hudObvVal','hudUpDownVal',
   'hudLogContainer','hudEtaText','hudSpeedText']
    .forEach((id) => (els[id] = document.getElementById(id)));
}

function renderLegend() {
  els.legendList.innerHTML = INDICATORS.map(
    (i) => `<li><b>${i.label}</b><span>${i.weight}점</span></li>`
  ).join('');
}

function fmtUsd(v) { return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtDollarVol(v) { return v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M/일` : `$${(v / 1e3).toFixed(0)}K/일`; }

function appendHudLog(msg, type = 'normal') {
  if (!els.hudLogContainer) return;
  const line = document.createElement('div');
  line.className = `hud-log ${type === 'shake' ? 'hud-log--shake' : type === 'pass' ? 'hud-log--pass' : type === 'drop' ? 'hud-log--drop' : type === 'error' ? 'hud-log--error' : ''}`;
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  line.textContent = `[${timeStr}] ${msg}`;
  els.hudLogContainer.prepend(line);
  if (els.hudLogContainer.children.length > 25) els.hudLogContainer.removeChild(els.hudLogContainer.lastChild);
}

function renderResults(list) {
  els.resultsList.innerHTML = '';
  els.resultsCount.textContent = `${list.length}개 포착`;

  if (!list.length) {
    els.resultsEmpty.style.display = 'block';
    els.resultsEmpty.textContent = '조건을 만족하는 보통주를 찾지 못했습니다.';
    return;
  }
  els.resultsEmpty.style.display = 'none';

  list.forEach((r, idx) => {
    const rank = idx + 1;
    const chgClass = r.changeRate > 0 ? 'up' : r.changeRate < 0 ? 'down' : '';
    const chgSign = r.changeRate > 0 ? '+' : '';
    const tags = r.triggered
      .sort((a, b) => b.weight - a.weight)
      .map((t) => {
        const isShake = t.key === 'shakeout' && t.status === 'crossed';
        const isBuzz = t.key === 'buzz_surge' && t.status === 'crossed';
        const tagClass = isShake ? 'tag--shake' : isBuzz ? 'tag--crossed' : t.status === 'crossed' ? 'tag--crossed' : 'tag--imminent';
        return `<span class="tag ${tagClass}">${t.label}${t.status === 'crossed' ? (t.barsAgo ? ` · ${t.barsAgo}봉 전` : ' · 오늘') : ' · 임박'}</span>`;
      })
      .join('');

    const reasons = [];
    if (r.hasShakeout) reasons.push(`<b style="color:var(--shakeout)">[⚡개미털기 포착]</b> 지지선 일시 이탈 투매 유도 후 +${r.distFromLowPct.toFixed(1)}% 복귀`);
    if (r.hasBuzz) reasons.push(`<b style="color:var(--gold)">[🔥커뮤니티 글 급증]</b> ${r.buzzDesc} (소외주 관심 집중)`);
    reasons.push(`최근 20일 변동폭 <b>${r.rangeRecentPct.toFixed(1)}%</b> 수렴 상태 (바닥 다지기)`);
    reasons.push(`매집·기술신호 <b>${r.triggeredCount}개 포착</b> (종합 ${r.totalScore.toFixed(1)}점)`);

    const card = document.createElement('li');
    card.className = 'card' + (rank <= 3 ? ' card--gold card--top' : '');
    card.innerHTML = `
      <div class="card__rank">${String(rank).padStart(2, '0')}</div>
      <div class="card__body">
        <div class="card__head">
          <span class="card__name" title="${r.meta.name}">${r.meta.name}</span>
          <span class="card__code">${r.meta.code}</span>
          <span class="card__market">${r.meta.market}</span>
          <span class="card__dvol">${fmtDollarVol(r.avgDollarVol20)}</span>
        </div>
        <div class="card__tags">${tags || '<span class="tag">신호 대기</span>'}</div>
        <ul class="card__reasons">${reasons.map((x) => `<li>${x}</li>`).join('')}</ul>
      </div>
      <div class="card__stats">
        <div class="card__price">${fmtUsd(r.last)}</div>
        <div class="card__chg ${chgClass}">${chgSign}${r.changeRate.toFixed(2)}%</div>
        <div class="card__score">종합 <b>${r.totalScore.toFixed(1)}</b>점</div>
        <div class="card__bottombar" title="바닥점수 ${r.bottomScore.toFixed(1)}/40">
          <i style="width:${clamp((r.bottomScore / 40) * 100, 0, 100)}%"></i>
        </div>
      </div>
    `;
    els.resultsList.appendChild(card);
  });
}

function parseWhitelist(raw) {
  if (!raw || !raw.trim()) return null;
  const set = new Set(raw.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean));
  return set.size ? set : null;
}

async function buildUniverse(minPrice, maxPrice) {
  if (els.modeCustom.checked) {
    const raw = els.customTickers.value || '';
    const codes = raw.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    return codes.map((code) => ({ code, name: code, market: 'CUSTOM', price: null, changeRate: 0 }));
  }

  const wanted = [];
  if (els.mktNasdaq.checked) wanted.push('NASDAQ');
  if (els.mktNyse.checked) wanted.push('NYSE');
  if (els.mktAmex.checked) wanted.push('AMEX');
  if (!wanted.length) throw new Error('거래소를 하나 이상 선택하세요.');

  let universe = [];
  for (const ex of wanted) {
    if (!IS_SCANNING) return [];
    if (els.useCache.checked) {
      const cached = getCachedUniverse(EXCHANGES[ex].param);
      if (cached) {
        universe = universe.concat(cached);
        continue;
      }
    }
    try {
      const rows = await fetchExchangeList(EXCHANGES[ex].param);
      rows.forEach((r) => (r.market = ex));
      universe = universe.concat(rows);
      if (els.useCache.checked) setCachedUniverse(EXCHANGES[ex].param, rows);
    } catch (e) {}
  }

  const whitelist = parseWhitelist(els.tossWhitelist.value);
  if (whitelist) universe = universe.filter((r) => whitelist.has(r.code.toUpperCase()));
  return universe.filter((r) => r.price >= minPrice && r.price <= maxPrice);
}

async function runScan() {
  IS_SCANNING = true;
  failCount = 0;
  const minPrice = num(els.minPrice.value) || 0;
  const maxPrice = num(els.maxPrice.value) || Infinity;
  const minDollarVol = num(els.minDollarVol.value) || 500000;
  const minSignals = parseInt(els.minSignals.value, 10);
  const minBottom = parseInt(els.minBottom.value, 10);
  CONCURRENCY = parseInt(els.concurrencySel.value, 10) || 5;

  els.scannerOverlay.classList.add('is-active');
  els.hudLogContainer.innerHTML = '';
  els.overlayProgressBar.style.width = '0%';
  els.overlayProgressPct.textContent = '0.0%';
  els.scanBtn.disabled = true;

  appendHudLog('커뮤니티 버즈 + 9대 지표 통합 퀀트 가동 시작');

  try {
    const candidates = await buildUniverse(minPrice, maxPrice);
    if (!candidates.length) {
      renderResults([]);
      return;
    }

    appendHudLog(`유니버스 필터 통과: ${candidates.length}개사 분석 시작`);
    const analyzed = [];
    let doneCount = 0;
    const startTime = Date.now();

    const worker = async () => {
      while (IS_SCANNING) {
        const idx = doneCount++;
        if (idx >= candidates.length) break;
        const c = candidates[idx];
        try {
          const bars = await fetchHistory(c.code);
          if (bars && bars.length) {
            const res = await analyzeStock(
              { code: c.code, name: c.name, market: c.market, changeRate: c.changeRate || 0 },
              bars, minDollarVol,
              (info) => {
                els.hudCurrentTicker.textContent = info.ticker;
                els.hudCurrentName.textContent = info.name;
                els.hudCurrentMeta.textContent = `PRICE: $${info.price.toFixed(2)} | VOL: ${(info.avgVol/1000).toFixed(0)}K`;
                renderHudSvgChart(info.bars, info.ma20, info.ma60, info.bbUpper, info.bbLower, info.recentLow, info.shakeoutInfo);
                els.hudCmfVal.textContent = info.curCmf.toFixed(2);
                els.hudRvolVal.textContent = `${info.curRvol.toFixed(1)}x`;
                els.hudMacdVal.textContent = info.curMacd.toFixed(2);
                els.hudRsiVal.textContent = `${info.curRsi.toFixed(0)}`;
                els.hudObvVal.textContent = info.curObvDiff >= 0 ? '상승' : '수렴';
                els.hudUpDownVal.textContent = `${info.upDownRatio.toFixed(1)}x`;
              }
            );

            if (res && !res.dropped) {
              analyzed.push(res);
              appendHudLog(`[포착] ${c.code} (${c.name}) - 점수: ${res.totalScore.toFixed(0)}점 ${res.hasBuzz ? '🔥버즈급증' : ''}`, 'pass');
            }
          }
        } catch (e) {}

        const curDone = Math.min(doneCount, candidates.length);
        const pct = (curDone / candidates.length) * 100;
        els.overlayProgressBar.style.width = pct.toFixed(1) + '%';
        els.overlayProgressPct.textContent = pct.toFixed(1) + '%';
        els.overlayProgressCount.textContent = `${curDone} / ${candidates.length} 종목`;

        const elapsedSec = (Date.now() - startTime) / 1000;
        const speed = curDone / Math.max(elapsedSec, 0.1);
        const remSec = Math.max(0, Math.round((candidates.length - curDone) / Math.max(speed, 0.1)));
        els.hudSpeedText.textContent = `속도: ${speed.toFixed(1)} ops/s`;
        els.hudEtaText.textContent = remSec > 60 ? `약 ${Math.floor(remSec / 60)}분 ${remSec % 60}초` : `약 ${remSec}초`;
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker()));

    if (!IS_SCANNING) return;
    await sleep(400);

    let filtered = els.modeCustom.checked
      ? analyzed
      : analyzed.filter((r) => r.triggeredCount >= minSignals && r.bottomScore >= minBottom);

    filtered.sort((a, b) => b.totalScore - a.totalScore);
    renderResults(filtered);

  } catch (e) {
    if (e.message !== 'SCAN_ABORTED') alert('오류: ' + e.message);
  } finally {
    IS_SCANNING = false;
    els.scanBtn.disabled = false;
    els.scannerOverlay.classList.remove('is-active');
  }
}

function tickClock() {
  const now = new Date();
  if (els.clock) els.clock.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

document.addEventListener('DOMContentLoaded', () => {
  cacheEls();
  renderLegend();
  tickClock();
  setInterval(tickClock, 1000);

  els.scanBtn.addEventListener('click', runScan);
  els.overlayStopBtn.addEventListener('click', () => {
    IS_SCANNING = false;
    els.scannerOverlay.classList.remove('is-active');
  });

  const toggleCustom = () => {
    if (els.customTickerRow) els.customTickerRow.style.display = els.modeCustom.checked ? 'flex' : 'none';
  };
  els.modeAuto.addEventListener('change', toggleCustom);
  els.modeCustom.addEventListener('change', toggleCustom);
});
