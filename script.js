const PROXY = 'https://lingering-mountain-1e41.swc4876.workers.dev/?url=';

const EXCHANGES = {
  NASDAQ: { param: 'NASDAQ', label: 'NASDAQ' },
  NYSE:   { param: 'NYSE',   label: 'NYSE'   },
  AMEX:   { param: 'AMEX',   label: 'AMEX'   },
};

const HISTORY_RANGE = '6mo';
const HISTORY_INTERVAL = '1d';
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_KEY_PREFIX = 'scanner_cache_universe_';

let IS_SCANNING = false;
let CONCURRENCY = 6;
let failCount = 0;
let lastHudRenderTime = 0;

// 지표 가중치 정의
const INDICATORS = [
  { key: 'social_buzz', label: '💬 실시간 커뮤니티 버즈·심리', weight: 15 },
  { key: 'shakeout',    label: '⚡ 저점 매물 흡수 (Shakeout)',   weight: 15 },
  { key: 'cmf',         label: 'CMF 자금유입 (기관 매집)',     weight: 14 },
  { key: 'rvol',        label: 'RVOL 상대 거래량 급증',        weight: 14 },
  { key: 'up_down_vol', label: '상승일 거래량 우위',           weight: 10 },
  { key: 'obv',         label: 'OBV 추세 상승 전환',           weight: 10 },
  { key: 'ma_20_60',    label: 'MA 20/60 골든크로스',         weight: 9  },
  { key: 'bollinger',   label: '볼린저밴드 수축 후 상방돌파',    weight: 9  },
  { key: 'macd',        label: 'MACD 골든크로스',             weight: 8  },
  { key: 'rsi',         label: 'RSI 모멘텀 골든크로스',         weight: 6  },
];
const INDICATOR_WEIGHT_SUM = INDICATORS.reduce((s, i) => s + i.weight, 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(v) {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return NaN;
  return parseFloat(String(v).replace(/[$,%]/g, ''));
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

async function fetchViaProxy(targetUrl, { tries = 3, label = '' } = {}) {
  const url = PROXY + encodeURIComponent(targetUrl);
  let lastErr;
  for (let i = 0; i < tries; i++) {
    if (!IS_SCANNING) throw new Error('SCAN_ABORTED');
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        await sleep(700 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(250 * Math.pow(2, i));
    }
  }
  failCount++;
  throw new Error(`${label || targetUrl} 요청 실패: ${lastErr ? lastErr.message : 'unknown'}`);
}

function isCommonStock(item) {
  const code = (item.code || '').trim().toUpperCase();
  const name = (item.name || '').toLowerCase();

  if (/[.\-+](WS|WT|W|U|RT|PR|UN|R|CL)$/i.test(code)) return false;
  if (code.includes('^') || code.includes('/') || code.length > 5) return false;

  const hardExclude = [
    'preferred', 'pref', ' etf', 'etn', 'depositary', 'warrant', 'unit',
    'spdr', 'ishares', 'vanguard', 'invesco', 'schwab', 'direxion',
    'proshares', 'wisdomtree', 'debenture', 'class b',
  ];
  if (hardExclude.some((kw) => name.includes(kw))) return false;

  const spacPatterns = [
    /blank check/, /\bspac\b/, /acquisition corp/, /acquisition co\b/,
    /acquisition trust/, /special purpose acquisition/,
  ];
  if (spacPatterns.some((re) => re.test(name))) return false;

  return true;
}

async function fetchExchangeList(exchangeParam) {
  const target = `https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=6000&exchange=${exchangeParam}`;
  const json = await fetchViaProxy(target, { label: `${exchangeParam} 유니버스` });
  const rows = json?.data?.table?.rows && Array.isArray(json.data.table.rows)
    ? json.data.table.rows
    : [];
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
  } catch (e) {
    return null;
  }
}

function setCachedUniverse(exchangeParam, rows) {
  try {
    sessionStorage.setItem(CACHE_KEY_PREFIX + exchangeParam, JSON.stringify({ ts: Date.now(), rows }));
  } catch (e) {}
}

async function fetchHistory(symbol) {
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${HISTORY_RANGE}&interval=${HISTORY_INTERVAL}`;
  const json = await fetchViaProxy(target, { label: `${symbol} 시세 히스토리` });
  const result = json?.chart?.result?.[0];
  if (!result) return null;

  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close ? q.close[i] : null;
    if (close === null || close === undefined || Number.isNaN(close)) continue;
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

// -------------------------------------------------------------
// [1번 보완] 실제 StockTwits 커뮤니티 데이터 조회 및 분석 엔진
// -------------------------------------------------------------
async function fetchStockTwitsBuzz(symbol, bars, n, curRvol) {
  try {
    const target = `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol)}.json`;
    const json = await fetchViaProxy(target, { tries: 1, label: `${symbol} 버즈` });
    const messages = json?.messages || [];

    if (messages.length > 0) {
      const now = Date.now();
      // 최근 24시간 내 올라온 메시지 필터
      const recentMsgs = messages.filter(m => (now - new Date(m.created_at).getTime()) < 24 * 3600 * 1000);
      const msgCount = recentMsgs.length;

      let bullish = 0, bearish = 0;
      messages.forEach(m => {
        const sentiment = m.entities?.sentiment?.basic;
        if (sentiment === 'Bullish') bullish++;
        if (sentiment === 'Bearish') bearish++;
      });

      const bullishRatio = (bullish + bearish) > 0 ? (bullish / (bullish + bearish)) * 100 : 50;

      // 24시간 내 글 15개 이상 & 매수 우위(60% 이상)일 때 강력 버즈 판정
      if (msgCount >= 15 && bullishRatio >= 60) {
        return {
          status: 'crossed',
          buzzIndex: msgCount,
          labelText: `🔥 트윗 급증 (${msgCount}건/Bull ${bullishRatio.toFixed(0)}%)`
        };
      } else if (msgCount >= 8 || bullishRatio >= 70) {
        return {
          status: 'imminent',
          buzzIndex: msgCount,
          labelText: `관심 유입 (${msgCount}건)`
        };
      }
      return {
        status: 'none',
        buzzIndex: msgCount,
        labelText: `보통 (${msgCount}건)`
      };
    }
  } catch (e) {
    // API 제한이나 종목 미존재 시 자체 가격/거래량 수식 모델로 자동 폴백
  }

  // 폴백 수식 (거래량 급증 & 변동성 수렴)
  const volumes = bars.map(b => b.volume);
  const recent3Vol = sma(volumes, 3)[n - 1] || 1;
  const prior15Vol = sma(volumes, 15)[n - 4] || 1;
  const volSurge = recent3Vol / Math.max(prior15Vol, 1);
  const buzzIndex = (volSurge * 0.65) + (curRvol * 0.35);

  if (buzzIndex >= 2.5) {
    return { status: 'crossed', buzzIndex, labelText: `모멘텀 급증 (+${(buzzIndex * 100).toFixed(0)}%)` };
  } else if (buzzIndex >= 1.6) {
    return { status: 'imminent', buzzIndex, labelText: '모멘텀 유입' };
  }
  return { status: 'none', buzzIndex: 1.0, labelText: '보통' };
}

// -------------------------------------------------------------
// 기술적 보조지표 계산 로직
// -------------------------------------------------------------
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
    if (Number.isNaN(emaFast[i]) || Number.isNaN(emaSlow[i])) return NaN;
    return emaFast[i] - emaSlow[i];
  });
  const signal = new Array(closes.length).fill(NaN);
  const valids = macdLine.map((v, i) => ({ v, i })).filter((x) => !Number.isNaN(x.v));
  if (valids.length >= signalPeriod) {
    const emaSig = ema(valids.map((x) => x.v), signalPeriod);
    emaSig.forEach((val, idx) => {
      if (!Number.isNaN(val)) signal[valids[idx].i] = val;
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
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { mid, upper, lower };
}

function crossState(shortArr, longArr, lookback = 3, imminentGapPct = 3) {
  const n = shortArr.length;
  const diff = shortArr.map((v, i) => v - longArr[i]);
  for (let back = 0; back < lookback; back++) {
    const i = n - 1 - back;
    const p = i - 1;
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

function detectEarlyShakeout(bars, recentLow, n) {
  const last = bars[n - 1].close;
  const distFromLow = (last - recentLow) / (recentLow || 1);

  if (distFromLow > 0.08 || distFromLow < -0.01) {
    return { status: 'none' };
  }

  for (let i = n - 4; i < n; i++) {
    if (i < 0) continue;
    const b = bars[i];
    const range = b.high - b.low;
    const lowerTail = Math.min(b.open, b.close) - b.low;

    const isHammer = range > 0 && (lowerTail / range >= 0.52) && (b.close >= b.low * 1.02);
    const isSpringTrap = (b.low <= recentLow * 1.005) && (last >= recentLow * 0.995);

    if (isHammer || isSpringTrap) {
      return {
        status: 'crossed',
        barsAgo: n - 1 - i,
        shakeoutIndex: i,
        shakeoutPrice: b.low,
        type: isHammer ? '밑꼬리 매물소화' : '지지선 일시이탈 후 반등'
      };
    }
  }

  if (distFromLow >= 0.005 && distFromLow <= 0.035) {
    return { status: 'imminent' };
  }

  return { status: 'none' };
}

// -------------------------------------------------------------
// [3번 보완] 상하 영역 분리 정밀 SVG 차트 렌더링 함수
// -------------------------------------------------------------
function renderHudSvgChart(bars, ma20, ma60, bbUpper, bbLower, recentLow, shakeoutInfo, macdLine, rsi9) {
  if (!bars || bars.length < 20 || !els.hudDynamicSvg) return;
  const W = 480, H = 145, PAD_X = 8;
  
  // 영역 분할: 상단 메인 가격 영역 (Top: 6, Bottom: 92), 하단 오실레이터 영역 (Top: 100, Bottom: 140)
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

  // 상단 가격 스케일
  const validVals = [...closes, ...sliceMa20, ...sliceMa60, ...sliceBbU, ...sliceBbL, recentLow].filter(v => typeof v === 'number' && !Number.isNaN(v));
  const minVal = Math.min(...validVals);
  const maxVal = Math.max(...validVals);
  const range = maxVal - minVal || 1;

  const getX = (i) => PAD_X + (i / (n - 1)) * (W - PAD_X * 2);
  const getYPrice = (val) => P_BOTTOM - ((val - minVal) / range) * (P_BOTTOM - P_TOP);

  // 하단 거래량 바 (상단 차트 배경에 옅게 깔기)
  const maxVol = Math.max(...volumes) || 1;
  const volBars = sliceBars.map((b, i) => {
    const vH = (b.volume / maxVol) * 22;
    const x = getX(i) - 2;
    const y = P_BOTTOM - vH;
    const isUp = b.close >= b.open;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="4" height="${vH.toFixed(1)}" fill="${isUp ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.15)'}" />`;
  }).join('');

  const pricePts = closes.map((c, i) => `${getX(i).toFixed(1)},${getYPrice(c).toFixed(1)}`).join(' ');
  const ma20Pts = sliceMa20.map((m, i) => Number.isNaN(m) ? null : `${getX(i).toFixed(1)},${getYPrice(m).toFixed(1)}`).filter(Boolean).join(' ');
  const ma60Pts = sliceMa60.map((m, i) => Number.isNaN(m) ? null : `${getX(i).toFixed(1)},${getYPrice(m).toFixed(1)}`).filter(Boolean).join(' ');
  const bbUPts = sliceBbU.map((u, i) => Number.isNaN(u) ? null : `${getX(i).toFixed(1)},${getYPrice(u).toFixed(1)}`).filter(Boolean).join(' ');
  const bbLPts = sliceBbL.map((l, i) => Number.isNaN(l) ? null : `${getX(i).toFixed(1)},${getYPrice(l).toFixed(1)}`).filter(Boolean).join(' ');
  const baseLineY = getYPrice(recentLow).toFixed(1);

  let shakeoutMarker = '';
  if (shakeoutInfo && shakeoutInfo.status === 'crossed' && shakeoutInfo.shakeoutIndex !== undefined) {
    const localIdx = shakeoutInfo.shakeoutIndex - startIdx;
    if (localIdx >= 0 && localIdx < n) {
      const sX = getX(localIdx).toFixed(1);
      const sY = getYPrice(shakeoutInfo.shakeoutPrice).toFixed(1);
      shakeoutMarker = `
        <circle cx="${sX}" cy="${sY}" r="4.5" fill="none" stroke="var(--shakeout)" stroke-width="1.8" />
        <text x="${sX}" y="${Number(sY) + 11}" fill="var(--shakeout)" font-family="JetBrains Mono" font-size="7.5" font-weight="700" text-anchor="middle">SHAKEOUT</text>
      `;
    }
  }

  // 하단 오실레이터 (RSI & MACD 정규화)
  const sliceRsi = (rsi9 || []).slice(startIdx);
  const rsiPts = sliceRsi.map((v, i) => {
    if (Number.isNaN(v)) return null;
    const y = S_BOTTOM - (v / 100) * (S_BOTTOM - S_TOP);
    return `${getX(i).toFixed(1)},${y.toFixed(1)}`;
  }).filter(Boolean).join(' ');

  const sliceMacd = (macdLine || []).slice(startIdx);
  const validMacd = sliceMacd.filter(x => !Number.isNaN(x));
  const macdMin = Math.min(...validMacd, -0.1);
  const macdMax = Math.max(...validMacd, 0.1);
  const macdRange = macdMax - macdMin || 1;
  const macdPts = sliceMacd.map((v, i) => {
    if (Number.isNaN(v)) return null;
    const y = S_BOTTOM - ((v - macdMin) / macdRange) * (S_BOTTOM - S_TOP);
    return `${getX(i).toFixed(1)},${y.toFixed(1)}`;
  }).filter(Boolean).join(' ');

  const rsiMidY = (S_TOP + (S_BOTTOM - S_TOP) * 0.5).toFixed(1);

  els.hudDynamicSvg.innerHTML = `
    <!-- 배경 거래량 -->
    <g class="hud-vol-layer">${volBars}</g>
    
    <!-- 상단 가격 뷰 구분 그리드 -->
    <line x1="${PAD_X}" y1="${P_TOP}" x2="${W-PAD_X}" y2="${P_TOP}" stroke="rgba(255,255,255,0.03)" stroke-width="1" />
    <line x1="${PAD_X}" y1="${baseLineY}" x2="${W-PAD_X}" y2="${baseLineY}" stroke="var(--up)" stroke-width="1.2" stroke-dasharray="3,3" />
    <text x="${W-PAD_X-4}" y="${baseLineY - 3}" fill="var(--up)" font-family="JetBrains Mono" font-size="8" text-anchor="end">SUPPORT $${recentLow.toFixed(2)}</text>
    
    <!-- 지표 라인 -->
    ${bbUPts ? `<polyline fill="none" stroke="rgba(56,189,248,0.25)" stroke-width="1" stroke-dasharray="2,2" points="${bbUPts}" />` : ''}
    ${bbLPts ? `<polyline fill="none" stroke="rgba(56,189,248,0.25)" stroke-width="1" stroke-dasharray="2,2" points="${bbLPts}" />` : ''}
    ${ma60Pts ? `<polyline fill="none" stroke="var(--purple)" stroke-width="1.2" opacity="0.8" stroke-linecap="round" points="${ma60Pts}" />` : ''}
    ${ma20Pts ? `<polyline fill="none" stroke="var(--red)" stroke-width="1.5" stroke-linecap="round" points="${ma20Pts}" />` : ''}
    <polyline fill="none" stroke="var(--text)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" points="${pricePts}" />
    ${shakeoutMarker}
    <circle cx="${getX(n-1)}" cy="${getYPrice(closes[n-1])}" r="3" fill="var(--red)" />

    <!-- 상/하단 분할선 -->
    <line x1="${PAD_X}" y1="${S_TOP - 4}" x2="${W-PAD_X}" y2="${S_TOP - 4}" stroke="rgba(255,255,255,0.08)" stroke-width="1" />

    <!-- 하단 서브 오실레이터 뷰 (RSI 50선 + MACD/RSI 곡선) -->
    <line x1="${PAD_X}" y1="${rsiMidY}" x2="${W-PAD_X}" y2="${rsiMidY}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="2,2" />
    <text x="${PAD_X + 2}" y="${S_TOP + 8}" fill="var(--text-faint)" font-family="JetBrains Mono" font-size="7">RSI / MACD</text>
    ${macdPts ? `<polyline fill="none" stroke="rgba(239,68,68,0.6)" stroke-width="1" stroke-dasharray="2,2" points="${macdPts}" />` : ''}
    ${rsiPts ? `<polyline fill="none" stroke="rgba(168,85,247,0.7)" stroke-width="1.2" points="${rsiPts}" />` : ''}
  `;
}

// -------------------------------------------------------------
// 종합 퀀트 및 버즈 분석 함수
// -------------------------------------------------------------
async function analyzeStock(meta, bars, minDollarVol, onHudUpdate) {
  if (!bars || bars.length < 45) return null;

  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const volumes = bars.map((b) => b.volume);
  const n = closes.length;
  const last = closes[n - 1];

  const vol20Arr = sma(volumes, 20);
  const avgVol20 = vol20Arr[n - 1] || 1;
  const avgDollarVol20 = avgVol20 * last;

  const win = Math.min(20, n - 1);
  const recentHigh = Math.max(...highs.slice(n - win));
  const recentLow = Math.min(...lows.slice(n - win));
  const rangeRecent = (recentHigh - recentLow) / (recentLow || 1);

  if (rangeRecent < 0.015) {
    return { dropped: true, reason: `스팩/시체주 제외 (20일 변동폭 ${(rangeRecent * 100).toFixed(1)}% < 1.5%)` };
  }

  if (Number.isNaN(avgDollarVol20) || avgDollarVol20 < minDollarVol) {
    return { dropped: true, reason: `거래대금 미달 ($${(avgDollarVol20 / 1000).toFixed(0)}K < $${(minDollarVol / 1000).toFixed(0)}K)` };
  }

  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);

  if (last < (ma20[n - 1] || last) * 0.93) {
    return { dropped: true, reason: `20일 이평선 이탈 (-7% 초과)` };
  }

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
  const curMacd = (macdLine[n - 1] || 0) - (macdSig[n - 1] || 0);
  const curRsi = rsi9[n - 1] || 50;
  const curObvDiff = (obv[n - 1] || 0) - (obvMa[n - 1] || 0);

  let upVolSum = 0, downVolSum = 0;
  for (let i = Math.max(1, n - 14); i < n; i++) {
    if (closes[i] > closes[i - 1]) upVolSum += volumes[i];
    else if (closes[i] < closes[i - 1]) downVolSum += volumes[i];
  }
  const upDownRatio = downVolSum === 0 ? 2.0 : upVolSum / downVolSum;

  const shakeoutInfo = detectEarlyShakeout(bars, recentLow, n);
  
  // 실시간 StockTwits 버즈 분석 호출
  const buzzInfo = await fetchStockTwitsBuzz(meta.code, bars, n, curRvol);

  if (onHudUpdate) {
    onHudUpdate({
      ticker: meta.code, name: meta.name, price: last, avgVol: avgVol20, dVol: avgDollarVol20,
      bars, ma20, ma60, bbUpper, bbLower, recentLow, shakeoutInfo, macdLine, macdSig, rsi9, rsi14,
      curCmf, curRvol, curMacd, curRsi, curObvDiff, upDownRatio, buzzInfo
    });
  }

  const signals = {};
  signals.social_buzz = buzzInfo;
  signals.shakeout = shakeoutInfo;
  signals.cmf = curCmf >= 0.12 ? { status: 'crossed', barsAgo: 0 } : curCmf >= 0.05 ? { status: 'imminent' } : { status: 'none' };
  signals.rvol = curRvol >= 1.7 ? { status: 'crossed', barsAgo: 0 } : curRvol >= 1.3 ? { status: 'imminent' } : { status: 'none' };
  signals.up_down_vol = upDownRatio >= 1.35 ? { status: 'crossed', barsAgo: 0 } : upDownRatio >= 1.15 ? { status: 'imminent' } : { status: 'none' };
  signals.obv = crossState(obv, obvMa, 3, 999);
  signals.ma_20_60 = crossState(ma20, ma60, 3, 2.5);
  signals.macd = crossState(macdLine, macdSig, 3, 999);
  signals.rsi = crossState(rsi9, rsi14, 3, 5);

  signals.bollinger = (() => {
    const bw = (i) => (bbUpper[i] - bbLower[i]) / (bbMid[i] || 1);
    const recentBw = bw(n - 4), pastBw = bw(n - 20);
    const crossedMid = closes[n - 2] <= bbMid[n - 2] && closes[n - 1] > bbMid[n - 1];
    if (!Number.isNaN(recentBw) && !Number.isNaN(pastBw) && recentBw < pastBw * 0.75 && crossedMid) {
      return { status: 'crossed', barsAgo: 0 };
    }
    if (!Number.isNaN(recentBw) && recentBw < pastBw * 0.6) return { status: 'imminent' };
    return { status: 'none' };
  })();

  let rawIndicatorScore = 0;
  const triggered = [];
  for (const ind of INDICATORS) {
    const s = signals[ind.key];
    if (s?.status === 'crossed') {
      rawIndicatorScore += ind.weight;
      triggered.push({ ...ind, ...s });
    } else if (s?.status === 'imminent') {
      rawIndicatorScore += ind.weight * 0.5;
      triggered.push({ ...ind, ...s });
    }
  }
  const indicatorScore = (rawIndicatorScore / INDICATOR_WEIGHT_SUM) * 45;

  const baseTightness = clamp(1 - rangeRecent / 0.25, 0, 1);
  const distFromLow = (last - recentLow) / (recentLow || 1);
  const proximityScore = clamp(1 - Math.max(distFromLow, 0) / 0.16, 0, 1);

  const lowsRecent5 = Math.min(...lows.slice(n - 5));
  const lowsPrior5 = Math.min(...lows.slice(n - 10, n - 5));
  const higherLow = lowsRecent5 >= lowsPrior5 * 0.995;

  const vol5 = sma(volumes, 5)[n - 1] || 1;
  const volDraughtPenalty = (vol5 / Math.max(avgVol20, 1)) < 0.35 ? 0.5 : 1.0;

  const bottomScore = 40 * (0.45 * baseTightness + 0.35 * proximityScore + 0.2 * (higherLow ? 1 : 0.3)) * volDraughtPenalty;

  const ret5 = (last - closes[n - 6]) / (closes[n - 6] || 1);
  let momentumScore = 0;
  if (ret5 > 0 && ret5 <= 0.12) momentumScore = (ret5 / 0.12) * 15;
  else if (ret5 > 0.12) momentumScore = Math.max(15 - (ret5 - 0.12) * 80, 2);

  const totalScore = (Number.isNaN(bottomScore) ? 0 : bottomScore) +
                     (Number.isNaN(indicatorScore) ? 0 : indicatorScore) +
                     (Number.isNaN(momentumScore) ? 0 : momentumScore);

  return {
    dropped: false,
    meta, last, changeRate: meta.changeRate,
    avgDollarVol20,
    signals, triggered,
    hasShakeout: shakeoutInfo.status === 'crossed',
    hasBuzzSurge: buzzInfo.status === 'crossed',
    bottomScore, indicatorScore, momentumScore, totalScore,
    rangeRecentPct: rangeRecent * 100,
    distFromLowPct: distFromLow * 100,
    higherLow,
    triggeredCount: triggered.length,
    bars: bars.slice(-60),
    ma20, ma60, bbUpper, bbLower, recentLow, shakeoutInfo, macdLine, rsi9
  };
}

// -------------------------------------------------------------
// UI 바인딩 및 이벤트
// -------------------------------------------------------------
const els = {};
function cacheEls() {
  [
    'minPrice','maxPrice','minDollarVol','mktNasdaq','mktNyse','mktAmex','modeAuto','modeCustom','customTickerRow','customTickers',
    'tossWhitelist','concurrencySel','useCache','minSignals','minBottom','scanBtn','resultsEmpty','resultsList','resultsCount','legendList','clock',
    'scannerOverlay','overlayStopBtn','overlayProgressBar','overlayProgressPct','overlayProgressCount',
    'hudFailBanner','hudFailText','hudCurrentTicker','hudCurrentName','hudCurrentMeta','hudDynamicSvg','hudBuzzStatus',
    'hudCmfVal','hudRvolVal','hudMacdVal','hudRsiVal','hudObvVal','hudBuzzVal',
    'hudLogContainer','hudEtaText','hudSpeedText'
  ].forEach((id) => (els[id] = document.getElementById(id)));
}

function renderLegend() {
  els.legendList.innerHTML = INDICATORS.map(
    (i) => `<li><b>${i.label}</b><span>${i.weight}점</span></li>`
  ).join('');
}

function fmtUsd(v) {
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDollarVol(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M/일`;
  return `$${(v / 1e3).toFixed(0)}K/일`;
}

function appendHudLog(msg, type = 'normal') {
  if (!els.hudLogContainer) return;
  const line = document.createElement('div');
  line.className = `hud-log ${type === 'shake' ? 'hud-log--shake' : type === 'buzz' ? 'hud-log--buzz' : type === 'pass' ? 'hud-log--pass' : type === 'drop' ? 'hud-log--drop' : type === 'error' ? 'hud-log--error' : ''}`;
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  line.textContent = `[${timeStr}] ${msg}`;
  els.hudLogContainer.prepend(line);
  if (els.hudLogContainer.children.length > 25) {
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
  els.hudFailText.textContent = `요청 실패 ${failCount}건 발생. 동시 처리 수를 낮추고 재시도해보세요.`;
}

function renderResults(list) {
  els.resultsList.innerHTML = '';
  els.resultsCount.textContent = `${list.length}개 포착`;

  if (!list.length) {
    els.resultsEmpty.style.display = 'block';
    els.resultsEmpty.textContent = failCount > 0
      ? `조건을 만족하는 종목을 찾지 못했습니다. (요청 실패 ${failCount}건)`
      : '조건에 부합하는 종목을 찾지 못했습니다. 조건을 완화해보세요.';
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
        const isBuzz = t.key === 'social_buzz' && t.status === 'crossed';
        const tagClass = isShake ? 'tag--shake' : isBuzz ? 'tag--buzz' : t.status === 'crossed' ? 'tag--crossed' : 'tag--imminent';
        return `<span class="tag ${tagClass}">${t.label}${t.status === 'crossed' ? (t.barsAgo ? ` · ${t.barsAgo}일 전` : ' · 포착') : ' · 임박'}</span>`;
      })
      .join('');

    const reasons = [];
    if (r.hasBuzzSurge) {
      reasons.push(`<b style="color:var(--buzz)">[💬 실시간 커뮤니티]</b> ${r.signals.social_buzz.labelText}`);
    }
    if (r.hasShakeout) {
      reasons.push(`<b style="color:var(--shakeout)">[⚡ 저점 매물 흡수]</b> 일시적 지지선 하향 이탈 후 +${r.distFromLowPct.toFixed(1)}% 이내 빠른 복귀`);
    }
    reasons.push(`20일 변동폭 <b>${r.rangeRecentPct.toFixed(1)}%</b> 수렴 (바닥 지지력 형성)`);
    reasons.push(r.higherLow ? '저점을 높이는 <b>Higher-Low 반등 추세</b>' : '지지선 지지력 유지 중');
    reasons.push(`기술·수급 신호 <b>${r.triggeredCount}개 일치</b> (종합 ${r.totalScore.toFixed(1)}점)`);

    const card = document.createElement('li');
    card.className = 'card' + (rank <= 3 ? ' card--top' : '');
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

    card.addEventListener('click', () => {
      els.hudCurrentTicker.textContent = r.meta.code;
      els.hudCurrentName.textContent = r.meta.name;
      els.hudCurrentMeta.textContent = `PRICE: $${r.last.toFixed(2)} | D-VOL: ${fmtDollarVol(r.avgDollarVol20)}`;
      renderHudSvgChart(r.bars, r.ma20, r.ma60, r.bbUpper, r.bbLower, r.recentLow, r.shakeoutInfo, r.macdLine, r.rsi9);
      els.scannerOverlay.classList.add('is-active');
    });

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
  if (!wanted.length) throw new Error('거래소를 최소 하나 이상 선택하세요.');

  const useCache = els.useCache.checked;
  let universe = [];
  for (const ex of wanted) {
    if (!IS_SCANNING) return [];

    if (useCache) {
      const cached = getCachedUniverse(EXCHANGES[ex].param);
      if (cached) {
        appendHudLog(`${EXCHANGES[ex].label} 캐시 유니버스 로드 (${cached.length}개)`);
        universe = universe.concat(cached);
        continue;
      }
    }

    appendHudLog(`${EXCHANGES[ex].label} 종목 유니버스 조회 중...`);
    try {
      const rows = await fetchExchangeList(EXCHANGES[ex].param);
      rows.forEach((r) => (r.market = ex));
      universe = universe.concat(rows);
      if (useCache) setCachedUniverse(EXCHANGES[ex].param, rows);
    } catch (e) {
      appendHudLog(`[오류] ${EXCHANGES[ex].label} 조회 실패 — ${e.message}`, 'error');
    }
  }

  const whitelist = parseWhitelist(els.tossWhitelist.value);
  if (whitelist) {
    const before = universe.length;
    universe = universe.filter((r) => whitelist.has(r.code.toUpperCase()));
    appendHudLog(`화이트리스트 적용: ${before}개 → ${universe.length}개로 선별`);
  }

  return universe.filter((r) => r.price >= minPrice && r.price <= maxPrice);
}

// -------------------------------------------------------------
// 스캔 파이프라인 실행 엔진
// -------------------------------------------------------------
async function runScan() {
  IS_SCANNING = true;
  failCount = 0;
  const minPrice = num(els.minPrice.value) || 0;
  const maxPrice = num(els.maxPrice.value) || Infinity;
  const minDollarVol = num(els.minDollarVol.value) || 500000;
  const minSignals = parseInt(els.minSignals.value, 10);
  const minBottom = parseInt(els.minBottom.value, 10);
  const isCustomMode = els.modeCustom.checked;
  CONCURRENCY = parseInt(els.concurrencySel.value, 10) || 6;

  els.scannerOverlay.classList.add('is-active');
  els.hudLogContainer.innerHTML = '';
  els.overlayProgressBar.style.width = '0%';
  els.overlayProgressPct.textContent = '0.0%';
  els.hudEtaText.textContent = '계산 중…';
  els.scanBtn.disabled = true;
  updateFailBanner();

  appendHudLog('정밀 분석 & 실시간 커뮤니티 버즈 스캐너 시작');

  try {
    const candidates = await buildUniverse(minPrice, maxPrice);

    if (!candidates.length) {
      appendHudLog('스캔 대상 유니버스가 없습니다.');
      await sleep(800);
      renderResults([]);
      return;
    }

    appendHudLog(`유니버스 필터 통과: ${candidates.length}개사 분석 시작 (동시 ${CONCURRENCY}개)`);

    const analyzed = [];
    let queueIndex = 0;
    let completedCount = 0;
    const startTime = Date.now();

    const worker = async () => {
      while (IS_SCANNING) {
        if (queueIndex >= candidates.length) break;
        const c = candidates[queueIndex++];

        try {
          const bars = await fetchHistory(c.code);
          if (bars && bars.length) {
            const res = await analyzeStock(
              { code: c.code, name: c.name, market: c.market, changeRate: c.changeRate || 0 },
              bars,
              minDollarVol,
              (info) => {
                const now = Date.now();
                if (now - lastHudRenderTime > 120) {
                  lastHudRenderTime = now;
                  requestAnimationFrame(() => {
                    els.hudCurrentTicker.textContent = info.ticker;
                    els.hudCurrentName.textContent = info.name;
                    els.hudCurrentMeta.textContent = `PRICE: $${info.price.toFixed(2)} | VOL: ${(info.avgVol/1000).toFixed(0)}K | D-VOL: $${(info.dVol/1000).toFixed(0)}K`;

                    renderHudSvgChart(
                      info.bars, info.ma20, info.ma60, info.bbUpper, info.bbLower, info.recentLow, info.shakeoutInfo,
                      info.macdLine, info.rsi9
                    );

                    els.hudCmfVal.textContent = info.curCmf >= 0 ? `+${info.curCmf.toFixed(2)}` : info.curCmf.toFixed(2);
                    els.hudCmfVal.className = `sub-metric-val ${info.curCmf >= 0.1 ? 'is-gc' : ''}`;

                    els.hudRvolVal.textContent = `${info.curRvol.toFixed(1)}x`;
                    els.hudRvolVal.className = `sub-metric-val ${info.curRvol >= 1.5 ? 'is-hot' : ''}`;

                    els.hudMacdVal.textContent = info.curMacd >= 0 ? `+${info.curMacd.toFixed(2)}` : info.curMacd.toFixed(2);
                    els.hudMacdVal.className = `sub-metric-val ${info.curMacd >= 0 ? 'is-gc' : ''}`;

                    els.hudRsiVal.textContent = `${info.curRsi.toFixed(0)}`;
                    els.hudRsiVal.className = `sub-metric-val ${info.curRsi >= 50 ? 'is-gc' : ''}`;

                    els.hudObvVal.textContent = info.curObvDiff >= 0 ? '상승' : '수렴';
                    els.hudObvVal.className = `sub-metric-val ${info.curObvDiff >= 0 ? 'is-gc' : ''}`;

                    els.hudBuzzVal.textContent = info.buzzInfo.labelText;
                    els.hudBuzzVal.className = `sub-metric-val ${info.buzzInfo.status === 'crossed' ? 'is-buzz' : ''}`;
                  });
                }
              }
            );

            if (res && !res.dropped) {
              analyzed.push(res);
              if (res.hasBuzzSurge) {
                appendHudLog(`[💬버즈급증] ${c.code} (${c.name}) - ${res.signals.social_buzz.labelText}`, 'buzz');
              } else if (res.hasShakeout) {
                appendHudLog(`[⚡매물소화] ${c.code} (${c.name}) - 지지선 복귀 확인`, 'shake');
              } else {
                appendHudLog(`[포착] ${c.code} (${c.name}) - 점수: ${res.totalScore.toFixed(0)}점`, 'pass');
              }
            } else if (res && res.dropped) {
              appendHudLog(`[제외] ${c.code} - ${res.reason}`, 'drop');
            }
          }
        } catch (e) {
          if (e.message !== 'SCAN_ABORTED') {
            appendHudLog(`[오류] ${c.code} 분석 실패 - ${e.message}`, 'error');
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

    appendHudLog(`스캔 완료 (실패 ${failCount}건) — 결과 화면으로 이동합니다.`);
    await sleep(400);

    let filtered = isCustomMode
      ? analyzed
      : analyzed.filter((r) => r.triggeredCount >= minSignals && r.bottomScore >= minBottom);

    filtered.sort((a, b) => b.totalScore - a.totalScore);
    renderResults(filtered);

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
  tickClock();
  setInterval(tickClock, 1000);

  els.scanBtn.addEventListener('click', runScan);
  els.overlayStopBtn.addEventListener('click', () => {
    IS_SCANNING = false;
    els.scannerOverlay.classList.remove('is-active');
  });

  const toggleCustom = () => {
    if (els.customTickerRow) {
      els.customTickerRow.style.display = els.modeCustom.checked ? 'flex' : 'none';
    }
  };
  els.modeAuto.addEventListener('change', toggleCustom);
  els.modeCustom.addEventListener('change', toggleCustom);
});
