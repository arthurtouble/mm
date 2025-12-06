import { streamMidPrice, streamUserPosition, placeOrders, streamUserOpenOrders, streamCandle, getCandles } from "./lib/hyperliquid.js";

/*
TODO:
- ? it will only requote if ATR changes by more than atr_change_trigger which is 50%, but if ATR remains high on a pump or dump in price, it is high volatility and should requote faster than waiting for the 1minute to be up
- skewed distances can be negative if skew > 1
- upgrade logic, refresh rate, layers, etc. to not be picked off by volatility, that is what's causing most losses
- cancel all orders when app is killed or closed
- the active candle in ATR is skewing the calculation, because it could just be starting so High-Low = 0 - done, 
        -> used previous candle high/low and current candle close
- better volatility/ATR calculation based on 1min candle, ready before the algo begins - done
- distance skew depends on bid or ask side - done
- requote based on fill or increased volatility, not set interval - done
- kill switch to stop quoting on side that reaches the hard limit (part of scaleSizes) - done
*/

const PARAMS = {
    BTC: {
        base_spread: 0.0006,
        layers: 3,
        distance_multiplier: 1.5,
        size_multiplier: 1.5,
        atr_multiplier: 0.5, // how much impact ATR has on the quoted spread
        atr_change_trigger: 0.1, // an ATR change higher than this % triggers a requote
        price_change_trigger: 0.0005, // a price change higher than this % triggers a requote
        base_size: 100, // in USD
        hard_limit: 10000, // in USD
        soft_limit: 5000, // in USD
        skew_adjustment: 2,
        scale_adjustment: 0.001,
        candle_lookback: 7, // minutes, also ema_period
        trend_factor: 100 // Impact of trend on skew (high value because (price-ema)/price is small)
    }
};

let midPrices = {}; // BTC: price
let positions = {}; // BTC: pos (long = positive, short = negative, in USD)
let candles = {}; // BTC: [{t,o,h,l,c},...] (one minute candles ordered from oldest to most recent = current active one)

let lastATRs = {}; // BTC: atr // used to check if volatility has increased to trigger requote
let lastPositions = {}; // BTC: pos // used to check if inventory has changed to trigger requote
let lastQuoteTimes = {}; // BTC: time // used to check if more than 30s has passed to trigger requote
let lastQuoteMidPrices = {}; // BTC: price // used to check if price has changed to trigger requote

const computeATR = (market) => {
    const _candles = candles[market];
    if (!_candles || _candles.length < 2) return 0;
    let vol = 0;
    for (let i = 1; i < _candles.length; i++) {
        vol += Math.max(_candles[i].h - _candles[i].l, Math.abs(_candles[i].c - _candles[i - 1].h), Math.abs(_candles[i].c - _candles[i - 1].l));
    }
    return vol / (_candles.length - 1);
}

const computeEMA = (market) => {
    const _candles = candles[market];
    if (!_candles || _candles.length < 2) return null;
    const k = 2 / (_candles.length + 1);
    let ema = _candles[0].c;
    for (let i = 1; i < _candles.length; i++) {
        ema = _candles[i].c * k + ema * (1 - k);
    }
    return ema;
}

const skewDistances = (market, distances, isBidSide) => {
    const pos = positions[market] || 0;
    const hardLimit = PARAMS[market].hard_limit;

    // Trend Skew
    const ema = computeEMA(market);
    let trendSkew = 0;
    if (ema) {
        // if price > ema (uptrend), trendSkew is positive.
        trendSkew = (midPrices[market] - ema) / midPrices[market] * PARAMS[market].trend_factor;
    }
    console.log('ema', ema, 'trendSkew', trendSkew);

    const skew = (PARAMS[market].skew_adjustment * pos / hardLimit) - trendSkew; // based on inventory + trend
    const skewedDistances = [];
    for (let i = 0; i < distances.length; i++) {
        if (skew > 0) { // we are long, so we want to close our longs more. pull asks closer, bids wider
            if (isBidSide) {
                skewedDistances.push(distances[i] * (1 + skew));
            } else {
                skewedDistances.push(distances[i] * Math.max(0, 1 - skew));
            }
        } else { // we are short, so we want to close our shorts more. pull bids closer, asks wider
            if (isBidSide) {
                skewedDistances.push(distances[i] * Math.max(0, 1 - Math.abs(skew)));
            } else {
                skewedDistances.push(distances[i] * (1 + Math.abs(skew)));
            }
        }
    }
    return skewedDistances;
}

const scaleSizes = (market, sizes, isBidSide) => {
    const pos = positions[market] || 0;
    const softLimit = PARAMS[market].soft_limit;
    if (Math.abs(pos) <= softLimit || (isBidSide && pos < 0) || (!isBidSide && pos > 0)) return sizes;
    const hardLimit = PARAMS[market].hard_limit;
    const inventoryFactor = pos / hardLimit;
    const scaledSizes = [];
    for (let i = 0; i < sizes.length; i++) {
        if (inventoryFactor >= 1 || inventoryFactor <= -1) {
            scaledSizes.push(3); // 3 USD, hard limit, basically no quoting on this side
        } else {
            scaledSizes.push(sizes[i] * (1 - Math.abs(inventoryFactor)));
        }
    }
    return scaledSizes;
}

const computeOrderDistances = (market) => {
    const layers = PARAMS[market].layers;
    const distanceMultiplier = PARAMS[market].distance_multiplier;
    const atrDistance = computeATR(market) * PARAMS[market].atr_multiplier;
    console.log('atrDistance', atrDistance);
    let distances = [];
    for (let i = 0; i < layers; i++) {
        if (i == 0) {
            distances.push(PARAMS[market].base_spread * midPrices[market] / 2 + atrDistance);
        } else {
            distances.push(distances[i - 1] * distanceMultiplier);
        }
    }
    return distances;
}

const computeOrderSizes = (market, isBidSide) => {
    const layers = PARAMS[market].layers;
    const baseSize = PARAMS[market].base_size;
    const sizeMultiplier = PARAMS[market].size_multiplier;
    let sizes = [];
    for (let i = 0; i < layers; i++) {
        if (i == 0) {
            sizes.push(baseSize);
        } else {
            sizes.push(sizes[i - 1] * sizeMultiplier);
        }
    }
    return scaleSizes(market, sizes, isBidSide);
}

const streamData = (market) => {

    streamCandle(market, (candle) => {
        // latest 1-min candle
        midPrices[market] = candle.c;
        // update candle with same t property or push new one into the candles[market]
        candles[market] = candles[market] || [];
        let found = false;
        for (let i = 0; i < candles[market].length; i++) {
            if (candles[market][i].t == candle.t) {
                candles[market][i] = candle;
                found = true;
                break;
            }
        }
        if (!found) {
            candles[market].push(candle);
        }
        // keep candles[market] length to PARAMS[market].candle_lookback
        if (candles[market].length > PARAMS[market].candle_lookback) {
            candles[market].shift();
        }
        // console.log('candles', JSON.stringify(candles[market]));
    });

    streamUserPosition(market, (position) => {
        positions[market] = position;
    });

    // streamUserOpenOrders(market, (orders) => {

    // });

}

let runningQuote = {};
const quote = async (market) => {

    if (!midPrices[market] || runningQuote[market]) return;

    runningQuote[market] = true;

    // build orders
    const distances = computeOrderDistances(market);
    // console.log('raw distances', distances);
    const bidDistances = skewDistances(market, distances, true);
    const askDistances = skewDistances(market, distances, false);
    console.log('bid distances', bidDistances);
    console.log('ask distances', askDistances);

    const bidSizes = computeOrderSizes(market, true);
    const askSizes = computeOrderSizes(market, false);
    // console.log('bid sizes', bidSizes);
    // console.log('ask sizes', askSizes);

    let bids = [];
    let asks = [];
    for (let i = 0; i < distances.length; i++) {
        bids.push({ price: parseFloat(midPrices[market] * 1 - bidDistances[i]), size: parseFloat(bidSizes[i]) });
        asks.push({ price: parseFloat(midPrices[market] * 1 + askDistances[i]), size: parseFloat(askSizes[i]) });
    }

    console.log(JSON.stringify(bids));
    console.log(JSON.stringify(asks));
    console.log('SPREAD: ', Math.abs(bids[0].price - asks[0].price).toFixed(0));
    console.log('_____');

    // send orders
    await placeOrders(market, bids, asks);

    lastQuoteTimes[market] = Date.now();
    lastQuoteMidPrices[market] = midPrices[market];
    runningQuote[market] = false;

}

const requoteIfNeeded = (market) => {

    setTimeout(() => {
        requoteIfNeeded(market);
    }, 500);

    if (runningQuote[market]) return;

    if (!lastQuoteTimes[market]) {
        console.log('REQUOTING lastQuoteTimes');
        quote(market);
        return;
    }

    // requote if price changes by more than price_change_trigger
    if (!lastQuoteMidPrices[market]) lastQuoteMidPrices[market] = midPrices[market];
    const lastPrice = lastQuoteMidPrices[market];
    const currentPrice = midPrices[market];
    if (Math.abs(currentPrice - lastPrice) / lastPrice > PARAMS[market].price_change_trigger) {
        console.log('REQUOTING PRICE', currentPrice, lastPrice);
        lastQuoteMidPrices[market] = currentPrice;
        quote(market);
        return;
    }

    // requote if ATR changes by more than atr_change_trigger
    const atr = computeATR(market);
    if (!lastATRs[market]) lastATRs[market] = atr;
    const lastATR = lastATRs[market];
    // console.log('ATRs', atr, lastATR);
    if (Math.abs(atr - lastATR) / lastATR > PARAMS[market].atr_change_trigger) {
        console.log('REQUOTING ATR', atr, lastATR, Math.abs(atr - lastATR) / lastATR);
        lastATRs[market] = atr;
        quote(market);
        return;
    }
    // requote if user position changes by more than threshold
    const pos = positions[market] || 0;
    if (!lastPositions[market]) lastPositions[market] = pos;
    const lastPos = lastPositions[market];
    // console.log('POS', pos, lastPos, Math.abs(pos - lastPos));
    if (Math.abs(pos - lastPos) >= PARAMS[market].base_size) { // if inventory varies by more than base size
        console.log('REQUOTING POS', pos, lastPos, Math.abs(pos - lastPos));
        lastPositions[market] = pos;
        quote(market);
        return;
    }

    // requote if more than 20s passes
    const lastQuoteTime = lastQuoteTimes[market] || Date.now();
    if (Date.now() - lastQuoteTime > 20 * 1000) {
        console.log('REQUOTING TIME', Date.now() - lastQuoteTime);
        quote(market);
        return;
    }

}

const start = async (market) => {
    candles[market] = await getCandles(market, PARAMS[market].candle_lookback);
    streamData(market);
    requoteIfNeeded(market);
}

await start("BTC");