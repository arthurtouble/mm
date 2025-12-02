import "dotenv/config";
import crypto from "crypto";
import * as hl from "@nktkas/hyperliquid";

const user = "0xabe0750986fb2a72e0ebb71e28bb80402f7a6b54";

const infoClient = new hl.InfoClient({
    transport: new hl.HttpTransport(),
});
const exchangeClient = new hl.ExchangeClient({
    transport: new hl.HttpTransport(),
    wallet: process.env.PRIVATE_KEY_HL
});
const subsClient = new hl.SubscriptionClient({
    transport: new hl.WebSocketTransport(),
});

const hlParams = {
    BTC: {
        index: 0,
        price_decimals: 0,
        size_decimals: 5
    },
    ETH: {
        index: 0,
        price_decimals: 1,
        size_decimals: 4
    }
};

let cloids = {}; // market => [cloids]

const hash128Hex = (input) => {
    return crypto.createHash('sha256')
        .update(input)
        .digest('hex')
        .slice(0, 32); // first 128 bits
}

const deterministicHexList = (seed, count) => {
    const list = [];
    for (let i = 0; i < count; i++) {
        list.push('0x' + hash128Hex(seed + ":" + i));
    }
    return list;
}

// let users = {};
// const sub = await subsClient.trades({ coin: "ETH" }, (event) => {
//     console.log(event);
//     event.forEach((item) => {
//         users[item.users[0]] = users[item.users[0]] || 0;
//         users[item.users[1]] = users[item.users[1]] || 0;
//         users[item.users[0]] += item.sz * 1;
//         users[item.users[1]] += item.sz * 1
//     })
// });

export const getCandles = async (market, limit) => {
    // 1-minute candles
    const startTime = Date.now() - limit * 60 * 1000;
    let candles = await infoClient.candleSnapshot({ coin: market, interval: "1m", startTime });
    candles = candles.map((c) => { return { t: c.t, o: c.o, c: c.c, h: c.h, l: c.l } });
    return candles;
}

export const streamMidPrice = async (market, callback) => {
    await subsClient.bbo({ coin: market }, (event) => {
        if (event && event.bbo) {
            const midPrice = (parseFloat(event.bbo[0].px) + parseFloat(event.bbo[1].px)) / 2;
            callback(midPrice);
        }
    });
}

export const streamCandle = async (market, callback) => {
    await subsClient.candle({ coin: market, interval: "1m" }, (candle) => {
        if (candle) {
            callback({
                t: candle.t,
                o: candle.o,
                c: candle.c,
                h: candle.h,
                l: candle.l
            });
        }
    });
}

export const streamUserPosition = async (market, callback) => {
    await subsClient.clearinghouseState({ user }, (event) => {
        if (event && event.clearinghouseState) {
            const p = event.clearinghouseState.assetPositions.find((p) => p.position.coin == market);
            if (!p) return;
            const position = p.position;
            const positionSizeUsd = position.szi * 1 * position.entryPx;
            callback(positionSizeUsd);
        }
    });
}

export const streamUserOpenOrders = async (market, callback) => {
    await subsClient.openOrders({ user }, (event) => {
        // console.log(event);
        return;
        if (event && event.openOrders) {
            const orders = event.openOrders.orders;
            callback(orders);
        }
    });
}

export const placeOrders = async (market, bids, asks) => {

    if (!bids.length || !asks.length) return;

    const start = performance.now();

    if (!cloids[market] || !cloids[market].length) {
        cloids[market] = deterministicHexList(market, bids.length + asks.length);
    }

    // Cancel order(s) based on cloids
    let cancels = [];
    for (let i = 0; i < cloids[market].length; i++) {
        cancels.push({
            asset: hlParams[market].index,
            cloid: cloids[market][i]
        });
    }
    // console.log('cancels', cancels);

    try {
        const resultCancel = await exchangeClient.cancelByCloid({ cancels });
        console.log('resultCancel', resultCancel && resultCancel.status);
    } catch (error) {
        // console.log('error', error);
    }

    // Place order(s)
    let orders = [];
    for (let i = 0; i < bids.length; i++) {
        orders.push({
            a: hlParams[market].index,
            b: true,
            p: (bids[i].price).toFixed(hlParams[market].price_decimals),
            s: (bids[i].size / bids[i].price).toFixed(hlParams[market].size_decimals),
            r: false,
            t: {
                limit: {
                    tif: "Gtc",
                },
            },
            c: cloids[market][i]
        });
    }
    for (let i = 0; i < asks.length; i++) {
        orders.push({
            a: hlParams[market].index,
            b: false,
            p: (asks[i].price).toFixed(hlParams[market].price_decimals),
            s: (asks[i].size / asks[i].price).toFixed(hlParams[market].size_decimals),
            r: false,
            t: {
                limit: {
                    tif: "Gtc",
                },
            },
            c: cloids[market][i + bids.length]
        });
    }

    // console.log('orders', orders);

    const result = await exchangeClient.order({
        orders: orders,
        grouping: "na",
    });

    console.log('result', result && result.status);
    const end = performance.now();
    console.log(`Latency: ${end - start} ms`);
    return result;

}

// await subsClient.bbo({ coin: "BTC" }, (event) => {
//     console.log(event);
// });

// await subsClient.candle({ coin: "BTC", interval: "1m" }, (event) => {
//     console.log(event);
// });

// await subsClient.userFills({ user }, (event) => {
//     console.log(event);
// });

// await subsClient.openOrders({ user }, (event) => {
//     console.log(event);
// });

// await subsClient.clearinghouseState({ user }, (event) => {
//     // console.log(event);
//     console.log(event.clearinghouseState.assetPositions);
// });

// const start = performance.now();
// // Place order(s)
// const result = await exchangeClient.order({
//     orders: [{
//         a: 0, // BTC = 0, ETH = 1
//         b: true, // buy = true, sell = false
//         p: "88001", // price
//         s: "0.0004", // size
//         r: false, // reduce only
//         t: {
//             limit: {
//                 tif: "Gtc",
//             },
//         },
//     }, {
//         a: 0, // BTC = 0, ETH = 1
//         b: true, // buy = true, sell = false
//         p: "88000", // price
//         s: "0.001", // size
//         r: false, // reduce only
//         t: {
//             limit: {
//                 tif: "Gtc",
//             },
//         },
//     }],
//     grouping: "na",
// });
// const end = performance.now();
// console.log(`Latency: ${end - start} ms`);
// console.log(JSON.stringify(result));

// // Cancel order(s)
// const resultCancel = await exchangeClient.cancel({
//     cancels: [{
//         a: 0, // BTC = 0, ETH = 1
//         o: 253452676330 // order id
//     }, {
//         a: 0, // BTC = 0, ETH = 1
//         o: 253451124010 // order id
//     }]
// });

// console.log(JSON.stringify(resultCancel));

// Modify Order(s)

// const resultModify = await exchangeClient.batchModify({
//     modifies: [{
//         oid: 253461022051,
//         order: {
//             a: 0, // BTC = 0, ETH = 1
//             b: true, // buy = true, sell = false
//             p: "88006", // price
//             s: "0.0007", // size
//             r: false, // reduce only
//             t: {
//                 limit: {
//                     tif: "Gtc",
//                 },
//             },
//         }
//     }, {
//         oid: 253461022052,
//         order: {
//             a: 0, // BTC = 0, ETH = 1
//             b: true, // buy = true, sell = false
//             p: "88809", // price
//             s: "0.0012", // size
//             r: false, // reduce only
//             t: {
//                 limit: {
//                     tif: "Gtc",
//                 },
//             },
//         }
//     }]
// });

// console.log(JSON.stringify(resultModify));

// setInterval(async () => {
//     // await sub.unsubscribe();
//     const ranking = Object.entries(users)
//         .sort((a, b) => b[1] - a[1])
//         .slice(0, 10)
//         .map(([user, volume]) => ({ user, volume }));
//     console.log("ranking", ranking);
// }, 30 * 1000);

// Candle updates
// await subsClient.candle({ coin: "ETH", interval: "1h" }, (data) => {
//     console.log(data);
// });

// await sub.unsubscribe();