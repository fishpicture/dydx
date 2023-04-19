// 1. 加载 lib 库
const { DydxClient, OrderSide, OrderType, TimeInForce, Market } = require('@dydxprotocol/v3-client')
const Web3 = require('web3')
const WebSocket = require('ws')
const { WebsocketClient } = require('ftx-api')
const config = require('./config'); 

let futureBid = null;
let	futureAsk = null;
let accountPosition = null;
let ftxfutureTickerUpdateAt;
let dydxTickerUpdateAt;
let processing = false;
let bids = [];
let asks = [];
let unrealizedPnl = null;
let positionId = null

async function startFtxWS() {
    try {
        const params = {
          key: config.ftxApiKey,
          secret: config.ftxApiSecret,
        }
        const ws = new WebsocketClient(params);
      
        ws.on('response', msg => console.log('response: ', msg));
        ws.on('error', msg => console.log('err: ', msg));
        ws.on('update', msg => {
            if(msg['channel'] === 'orderbook' && msg['type'] !== 'subscribed') {
                const orderbook = msg['data']
                var ftxBidCount = 0;
                var ftxAskCount = 0;
                var tempbidPrice = 0;
                var tempaskPrice = 0;
                for (var i = 0; i < orderbook.bids.length; i++) {
                    ftxBidCount = ftxBidCount + orderbook.bids[i][1];
                    if (ftxBidCount >= config.futureSize) {
                        tempbidPrice = orderbook.bids[i][0];
                        break;
                    }
                    else if (i == orderbook.bids.length && ftxBidCount < config.futureSize) {
                        tempbidPrice = null;
                    }
                }
                for (var i = 0; i < orderbook.asks.length; i++) {
                    ftxAskCount = ftxAskCount + orderbook.asks[i][1];
                    if (ftxAskCount >= config.futureSize) {
                        tempaskPrice = orderbook.asks[i][0];
                        break;
                    }
                    else if (i == orderbook.asks.length && ftxAskCount < config.futureSize) {
                        tempaskPrice = null;
                    }
                }
                futureBid = tempbidPrice;
                futureAsk = tempaskPrice;
                ftxfutureTickerUpdateAt = Number.parseInt(orderbook.time * 1000, 10);
                // console.log('futureBid:' + futureBid + 
                // ", futureAsk:" + futureAsk + 
                // ", ftxfutureTickerUpdateAt:" + ftxfutureTickerUpdateAt + 
                // ", now:" + Date.now())
            }
            // 价格更新，尝试交易
            trade()
        });
    
        ws.subscribe({
          channel: 'orderbook',
          market: config.futureMarket
        });
      } catch (err) {
        futureBid = null;
        futureAsk = null;	
        console.error(err)
        console.error('connect FTX websocket failed.', err.message)
		process.exit(0)
      }
}

// 初始化 dydx client
const client = new DydxClient(config.httpHost, { 
	apiTimeout: 3000,
	starkPrivateKey: config.starkKey,
	web3: Web3,
	apiKeyCredentials: {
		key: config.apiKey,
		secret: config.apiSecret,
		passphrase: config.apiPassphrase,
	}
});

async function startDydxWS() {
  
    const timestamp = new Date().toISOString()
    const signature = client.private.sign({
      requestPath: '/ws/accounts',
      method: 'GET',
      isoTimestamp: timestamp,
    })
  
    const msg = {
      type: 'subscribe',
      channel: 'v3_orderbook',
      id: config.dydxMarket
    }  
  
    const ws = new WebSocket(config.wsHost)
  
  
    ws.on('message', (message) => {
      var msg = JSON.parse(message)
      if(msg.channel == "v3_orderbook")
      {
          if(msg.contents.bids.length > 20 && msg.contents.asks.length > 20)
          {
              for(var i = 0; i< msg.contents.bids.length; i++)
              {
                  bids.push([msg.contents.bids[i].price,msg.contents.bids[i].size])
              }
              for(var i = 0; i< msg.contents.asks.length; i++)
              {
                  asks.push([msg.contents.asks[i].price,msg.contents.asks[i].size])
              }
          }
          else if(msg.message_id > 2)
          {
              // 增量更新
              let upodated = false
              if (msg.contents.bids.length > 0) {
                dydxTickerUpdateAt = Date.now();
                updated = true
                msg.contents.bids.forEach(bid => {
                    const index = bids.findIndex(oBid => oBid[0] <= bid[0]);
                    if (bid[1] === "0") {
                        // delete
                        if (index !== -1 && bid[0] === bids[index][0]) {
                            bids.splice(index, 1);
                        }
                    } else {
                        if (index === -1) {
                            // insert to last
                            bids.push(bid);
                        } else if (bid[0] === bids[index][0]) {
                            // update
                            bids[index][1] = bid[1];
                        } else {
                            // insert to middle
                            bids.splice(index, 0, bid);
                        }
                    }					
                });
              }
              if (msg.contents.asks.length > 0) {
                dydxTickerUpdateAt = Date.now();
                updated = true
                msg.contents.asks.forEach(ask => {
                    const index = asks.findIndex(oAsk => oAsk[0] >= ask[0]);
    
                    if (ask[1] === "0") {
                        // delete
                        if (index !== -1 && ask[0] === asks[index][0]) {
                            asks.splice(index, 1);
                        }	
                    }
                    else {
                        if (index === -1) {
                            asks.push(ask);
                        } else if (ask[0] === asks[index][0]) {
                            asks[index][1] = ask[1];
                        } else {
                            asks.splice(index, 0, ask);
                        }
                    }
                });
              }
              
            // 价格更新，尝试交易
            if (updated) {
                trade()
            }
          }
      }
    })
  
    ws.on('open', () => {
      console.log('>', msg)
      ws.send(JSON.stringify(msg))
    })
  
    ws.on('error', (error) => {
      console.log('<', error)
    })
  
    ws.on('close', () => {
      console.log('Connection closed')
      process.exit(0)
    })
  
}

var risk = false;
async function riskControl()
{
	if(Date.now() - dydxTickerUpdateAt < 1000 && Date.now() - ftxfutureTickerUpdateAt < 1000 && accountPosition!=null && futureBid!=null && futureAsk!=null && positionId != null)
	{
		risk = false
	}
	else
	{
		risk = true
		
	}
    //console.log(Date.now() - dydxTickerUpdateAt < 1000,Date.now() - ftxfutureTickerUpdateAt < 1000,accountPosition,futureBid,futureAsk,positionId)
    //console.log("risk",risk)
}

// 定时刷新 dydx 的价钱
async function getOrderbook()
{
	try {
		var orderbook =  await client.public.getOrderBook(config.dydxMarket);
		bids = [];
		asks = [];
		for(var i = 0; i< orderbook.bids.length; i++)
		{
			bids.push([orderbook.bids[i].price,orderbook.bids[i].size])
		}
		for(var i = 0; i< orderbook.asks.length; i++)
		{
			asks.push([orderbook.asks[i].price,orderbook.asks[i].size])
		}
    } catch(error) {
        console.log(error)
    }	
}

async function getAccountInfo()
{
	try {	
		const account = await client.private.getAccount(config.ethAddress)
        positionId = account.account.positionId;
		var tempPosition = 0;
        // console.log(positionId)
		if(account.account.openPositions[config.dydxMarket])
		{
			tempPosition = parseFloat(account.account.openPositions[config.dydxMarket].size);
			unrealizedPnl = parseFloat(account.account.openPositions[config.dydxMarket].unrealizedPnl);

			if(unrealizedPnl > 20)
			{
			    takeProfit();
			}
		}
		accountPosition = tempPosition;
    } catch(error) {
		accountPosition = null;
		unrealizedPnl = null;
        console.log(error)
    }	
}

async function placeOrder(contract, buyorsell, limitormarket, ordersize, orderprice, tif, expiration)
{
	try {
        const order = await client.private.createOrder
		(
            {
                market: contract,
                side: buyorsell,
                type: limitormarket,
                postOnly: false,
                size: ordersize, // Size of the order, in base currency (i.e. an BTC-USD position of size 1 represents 1 BTC).
                price: orderprice, // price
                limitFee: '0.015',
				timeInForce: tif,
                expiration: expiration,
            },
            positionId, 
        )
        console.log("successfully create an order:")
        console.log(order)
    } catch(error) {
        console.log(error)
    }
}

async function takeProfit()
{
    const exp = moment().add(90, 'seconds').format("YYYY-MM-DDTHH:mm:ss.SSSZ")
	if(accountPosition > 0 && Math.abs(accountPosition) > config.maxSize)
	{
		var ordersize = parseFloat(bids[0][1])
		if(ordersize > config.maxSize)
		{
			ordersize = config.maxSize
		}
		placeOrder(config.dydxMarket, "SELL", "LIMIT", ordersize.toString(), bids[0][0], "IOC", exp)
		console.log("Take Profit SELL DYDX price", bids[0][0], "FTX price", futureAsk)		
	}
	if(accountPosition < 0 && Math.abs(accountPosition) > config.maxSize)
	{
		var ordersize = parseFloat(asks[0][1])
		if(ordersize > config.maxSize)
		{
			ordersize = config.maxSize
		}
		placeOrder(config.dydxMarket, "BUY", "LIMIT", ordersize.toString(), asks[0][0], "IOC", exp)
		console.log("Take Profit BUY DYDX price", asks[0][0], "FTX price", futureBid)
	}
}

async function cancelOrder(orderId)
{
    try {
        const result = await client.private.cancelOrder(orderId)
        console.log("successfully canceled an order:")
        console.log(order)
    } catch(error) {
        console.log(error['data']['errors'])
    }	
}

function wait(ms) {
    return new Promise(resolve => setTimeout(() =>resolve(), ms));
};

async function trade() {
	riskControl()
	if(processing == false && risk == false)
	{	
		processing = true;
		var dydxbid = parseFloat(bids[0][0]);
		var dydxask = parseFloat(asks[0][0]);
        const exp = moment().add(90, 'seconds').format("YYYY-MM-DDTHH:mm:ss.SSSZ")
        // console.log(exp)
		const r = accountPosition / config.maxPosition
		if(futureAsk != 0 && dydxbid > futureAsk*(1+config.premium-config.delta*r) && accountPosition> -config.maxPosition + config.positionOffset)
		{
			var ordersize = parseFloat(bids[0][1])
			if(ordersize > config.maxSize)
			{
				ordersize = config.maxSize
			}
            // 2022-12-21T21:30:20.200Z
			placeOrder(config.dydxMarket, "SELL", "LIMIT", ordersize.toString(), bids[0][0], "IOC", exp)
			console.log("SELL DYDX price", bids[0][0], "FTX price", futureAsk)
			await wait(8000);
			//sell
		}
        if(futureBid != 0 && dydxask < futureBid/(1+config.premium+config.delta*r) && accountPosition< config.maxPosition + config.positionOffset)
		{
			var ordersize = parseFloat(asks[0][1])
			if(ordersize > config.maxSize)
			{
				ordersize = config.maxSize
			}
			placeOrder(config.dydxMarket, "BUY", "LIMIT", ordersize.toString(), asks[0][0], "IOC", exp)
			console.log("BUY DYDX price", asks[0][0], "FTX price", futureBid)
			await wait(8000);
		}
		processing = false;	
	}
}

setInterval(() => {
	getAccountInfo()
}, 15000);

setInterval(() => {
	getOrderbook()
}, 5000);

((async () => {
    // 获取账户信息 
     getAccountInfo()

    // 启动FTX websocket
    startFtxWS();

    // 启动Dydx websocket
    startDydxWS();
    
})()).then(() => console.log('Done')).catch(console.error)