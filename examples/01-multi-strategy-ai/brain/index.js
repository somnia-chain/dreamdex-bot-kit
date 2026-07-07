/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { createOpencodeClient, createOpencodeServer } from '@opencode-ai/sdk';
import { CONFIG } from '../config.js';
import { log } from '../utils/logger.js';

let client = null;
let sessionId = null;
let server = null;
let cycleCount = 0;
let modelRef = null;

async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

async function resolveModel() {
  try {
    const cfg = await client.config.get();
    const defaultModel = cfg?.default_model || cfg?.model;

    const { providers } = await client.config.providers();
    const providerMap = {};
    const orderedIds = [];

    if (providers && providers.length > 0) {
      for (const p of providers) {
        const id = p.id || p.name;
        providerMap[id] = p;
        orderedIds.push(id);
      }
    }

    if (typeof defaultModel === 'string' && defaultModel.includes('/')) {
      const [pId, mId] = defaultModel.split('/');
      if (providerMap[pId] && providerMap[pId].models?.[mId]) {
        modelRef = { providerID: pId, modelID: mId };
        log('success', 'brain', `Resolved default: ${defaultModel}`);
        return modelRef;
      } else {
        log('warn', 'brain', `Default model '${defaultModel}' not found in available providers, searching...`);
      }
    }

    const preferred = CONFIG.OPCODE_PROVIDER;
    const priority = [...orderedIds];
    const prefIdx = priority.indexOf(preferred);
    if (prefIdx > 0) {
      priority.splice(prefIdx, 1);
      priority.unshift(preferred);
    }

    const priorityModels = ['deepseek-v4-flash-free', 'gpt-5.4-mini', 'gemini-3.5-flash', 'claude-haiku-4-5'];
    const goodModels = ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-sonnet-4', 'gpt-5.4', 'gpt-5', 'gemini-3.1-pro'];

    for (const id of priority) {
      const p = providerMap[id];
      const models = p.models || {};
      const modelIds = Object.keys(models);
      if (modelIds.length === 0) continue;

      const found = priorityModels.find(m => modelIds.includes(m));
      if (found) {
        modelRef = { providerID: id, modelID: found };
        log('success', 'brain', `Model: ${modelRef.providerID}/${modelRef.modelID}`);
        return modelRef;
      }
    }

    for (const id of priority) {
      const p = providerMap[id];
      const models = p.models || {};
      const modelIds = Object.keys(models);
      if (modelIds.length === 0) continue;

      const found = goodModels.find(m => modelIds.includes(m));
      if (found) {
        modelRef = { providerID: id, modelID: found };
        log('success', 'brain', `Picked: ${modelRef.providerID}/${modelRef.modelID}`);
        return modelRef;
      }
    }

    for (const id of priority) {
      const p = providerMap[id];
      const models = p.models || {};
      const modelIds = Object.keys(models);
      if (modelIds.length > 0) {
        modelRef = { providerID: id, modelID: modelIds[0] };
        log('info', 'brain', `Fallback pick: ${modelRef.providerID}/${modelRef.modelID}`);
        return modelRef;
      }
    }
  } catch (e) {
    log('warn', 'brain', `resolveModel error: ${e.message}`);
  }

  modelRef = null;
  log('warn', 'brain', 'No model resolved — prompt will use server default');
  return null;
}

export async function initBrain() {
  log('info', 'brain', 'Connecting to OpenCode...');

  let baseUrl = `http://${CONFIG.OPCODE_HOSTNAME}:${CONFIG.OPCODE_PORT}`;

  const healthy = await waitForHealth(baseUrl, 2000);

  if (!healthy) {
    log('info', 'brain', 'No existing server — starting a new one...');
    server = await createOpencodeServer({
      port: CONFIG.OPCODE_PORT,
      hostname: CONFIG.OPCODE_HOSTNAME,
      timeout: CONFIG.OPCODE_START_TIMEOUT,
    });
    baseUrl = server.url;
    log('success', 'brain', `Server started at ${baseUrl}`);
  } else {
    log('success', 'brain', `Connected to existing server at ${baseUrl}`);
  }

  client = createOpencodeClient({ baseUrl, responseStyle: 'data' });

  const h = await waitForHealth(baseUrl, 15000);
  if (!h) throw new Error('OpenCode server did not become ready');

  const port = new URL(baseUrl).port;
  log('success', 'brain', `OpenCode ready on port ${port}`);

  if (CONFIG.OPCODE_API_KEY && CONFIG.OPCODE_API_KEY !== 'YOUR_OPENCODE_API_KEY_HERE') {
    try {
      log('info', 'brain', `Setting auth for: ${CONFIG.OPCODE_PROVIDER}`);
      await client.auth.set({
        path: { id: CONFIG.OPCODE_PROVIDER },
        body: { type: 'api', key: CONFIG.OPCODE_API_KEY },
      });
      log('success', 'brain', 'Provider auth set');
    } catch (e) {
      log('warn', 'brain', `Auth error: ${e.message}`);
    }
  } else {
    log('warn', 'brain', 'OPCODE_API_KEY not set — using OpenCode default credentials');
  }

  await resolveModel();

  const session = await client.session.create({
    body: { title: 'DreamDEX Trading Agent' },
  });

  if (!session || !session.id) {
    throw new Error('Failed to create session');
  }

  sessionId = session.id;
  log('success', 'brain', `Session: ${sessionId}`);

  const initBody = {
    noReply: true,
    parts: [
      {
        type: 'text',
        text:
          'You are an autonomous crypto trading AI agent on DreamDEX (Somnia Testnet).\n' +
          'Goal: maximize profit on WETH:USDso. Decide BUY, SELL, or HOLD each cycle.\n' +
          'CRITICAL: respond ONLY with a valid JSON object like {"action":"BUY","strategy":"GRID",...} — no other text, no markdown.',
      },
    ],
  };
  if (modelRef) initBody.model = modelRef;

  await client.session.prompt({
    path: { id: sessionId },
    body: initBody,
  });

  log('success', 'brain', 'Brain ready');
  return { client, sessionId };
}

function buildTradingPrompt(ctx) {
  const { marketData, signals, stats, openPositions, vaultBalances } = ctx;

  const mid = parseFloat(marketData.midPrice || 0);
  const vaultQuote = parseFloat(vaultBalances.usdsoFree || 0);
  const vaultBase = parseFloat(vaultBalances.wethFree || 0);
  const totalValue = vaultBase * mid + vaultQuote;

  const maxTradeValue = (vaultQuote * CONFIG.MAX_RISK_PERCENT).toFixed(4);
  const maxLoss = (parseFloat(CONFIG.INITIAL_DEPOSIT_USDSO) * CONFIG.MAX_LOSS_PERCENT).toFixed(2);

  let candlesText = 'None';
  if (marketData.candles && marketData.candles.length > 0) {
    candlesText = marketData.candles
      .slice(-15)
      .map((c) => `O:${(c.open || 0).toFixed(6)} H:${(c.high || 0).toFixed(6)} L:${(c.low || 0).toFixed(6)} C:${(c.close || 0).toFixed(6)} V:${c.volume || 0}`)
      .join('\n');
  }

  let tradesText = 'None';
  if (marketData.trades && marketData.trades.length > 0) {
    tradesText = marketData.trades.slice(-10).map((t) => `${t.side || '?'} ${t.amount || t.quantity} @ ${t.price}`).join('\n');
  }

  let positionText = 'None';
  let unrealizedPnl = '0';
  if (openPositions && openPositions.length > 0) {
    const pos = openPositions[0];
    positionText = `${pos.amount} WETH @ ${pos.entryPrice} USDso`;
    if (mid > 0) {
      unrealizedPnl = ((mid - parseFloat(pos.entryPrice)) * parseFloat(pos.amount)).toFixed(4);
    }
  }

  let statsText = '';
  for (const [strategy, data] of Object.entries(stats)) {
    if (strategy === 'totalTrades' || strategy === 'closedTrades' || strategy === 'overallWinRate') continue;
    if (data.totalTrades > 0) {
      statsText += `- ${strategy.toUpperCase()}: ${data.winRate}% win (${data.wins}W/${data.losses}L / ${data.totalTrades}), avg PnL: ${data.avgReturn} USDso\n`;
    } else {
      statsText += `- ${strategy.toUpperCase()}: no closed trades yet\n`;
    }
  }

  // CoinGecko sentiment section for AI context
  let cgSentimentText = 'CoinGecko data not available';
  if (signals.coingecko) {
    const cg = signals.coingecko;
    cgSentimentText = `BTC: $${cg.btcPrice?.toLocaleString()} (${cg.btcChange24h?.toFixed(1)}% / 24h) | RSI: ${cg.btcRSI?.toFixed(1)} | Trend: ${cg.btcChange24h > 1 ? 'BULLISH' : cg.btcChange24h < -1 ? 'BEARISH' : 'NEUTRAL'}\n` +
      `ETH: $${cg.ethPrice?.toLocaleString()} (${cg.ethChange24h?.toFixed(1)}% / 24h) | RSI: ${cg.ethRSI?.toFixed(1)} | Trend: ${cg.ethChange24h > 1 ? 'BULLISH' : cg.ethChange24h < -1 ? 'BEARISH' : 'NEUTRAL'}\n` +
      `Overall Crypto Sentiment: ${cg.signal} (confidence: ${cg.confidence?.toFixed(2)}) | ${cg.reason}`;
  }

  return `You are an autonomous AI trading agent on DreamDEX (Somnia Testnet). Goal: maximize profit on WETH:USDso.

RULES: BUY (USDso->WETH), SELL (WETH->USDso), or HOLD. Strategy: GRID / MOMENTUM / MEAN_REVERSION. Max trade: ${maxTradeValue} USDso. Min: 0.001 WETH. Ignore gas costs.

MARKET: Last: ${mid.toFixed(8)} USDso | Bid: ${(marketData.bestBid || 0).toFixed(8)} (qty:${marketData.bidQty || 0}) | Ask: ${(marketData.bestAsk || 0).toFixed(8)} (qty:${marketData.askQty || 0}) | Spread: ${marketData.spread || '0'}% | 24h: ${marketData.change24h || 'N/A'}%

CANDLES: ${candlesText}

TRADES: ${tradesText}

ACCOUNT: Vault: ${vaultBase} WETH / ${vaultQuote} USDso | Total: ${totalValue.toFixed(4)} USDso | Position: ${positionText} | Unrealized: ${unrealizedPnl} USDso | Realized PnL: ${ctx.realizedPnl || '0'} USDso

SIGNALS:
GRID [${signals.grid?.signal || 'HOLD'}] conf:${(signals.grid?.confidence || 0).toFixed(2)} — ${signals.grid?.reason || 'N/A'}
MOMENTUM [${signals.momentum?.signal || 'HOLD'}] conf:${(signals.momentum?.confidence || 0).toFixed(2)} — ${signals.momentum?.reason || 'N/A'}
MEAN_REV [${signals.meanReversion?.signal || 'HOLD'}] RSI:${(signals.meanReversion?.rsi || 0).toFixed(1)} conf:${(signals.meanReversion?.confidence || 0).toFixed(2)} — ${signals.meanReversion?.reason || 'N/A'}

COINGECKO MARKET SENTIMENT:
${cgSentimentText}

HISTORY: ${stats.totalTrades || 0} trades (${stats.closedTrades || 0} closed) | WinRate: ${stats.overallWinRate || '0'}%\n${statsText}

RISK: Circuit breaker at -${maxLoss} USDso (50% of initial ${CONFIG.INITIAL_DEPOSIT_USDSO} USDso)

Respond with a valid JSON object ONLY (no other text). Example:
{"action":"HOLD","strategy":"MEAN_REVERSION","price":0,"amount":0,"stopLoss":0,"takeProfit":0,"confidence":0.5,"reasoning":"Neutral market, waiting for clearer signal."}

Make your decision. Output ONLY the JSON object.`;
}

export async function getAIDecision(ctx, maxRetries = 2) {
  cycleCount++;

  if (cycleCount > 1 && cycleCount % CONFIG.OPCODE_SESSION_ROTATE === 0) {
    log('info', 'brain', `Rotating session (cycle ${cycleCount})...`);
    try {
      await client.session.delete({ path: { id: sessionId } }).catch(() => {});
      const ns = await client.session.create({
        body: { title: `DreamDEX Agent C${cycleCount}` },
      });
      if (ns?.id) {
        sessionId = ns.id;
        const rotBody = {
          noReply: true,
          parts: [{ type: 'text', text: 'Trading agent. Always respond with a JSON object for decisions — no other text.' }],
        };
        if (modelRef) rotBody.model = modelRef;
        await client.session.prompt({
          path: { id: sessionId },
          body: rotBody,
        });
      }
    } catch (e) {
      log('warn', 'brain', `Rotation error: ${e.message}`);
    }
  }

  const promptFn = ctx.customPrompt || buildTradingPrompt;
  const prompt = promptFn(ctx);

  const TIMEOUT_MS = 45000;

  async function promptWithTimeout(body) {
    const result = await Promise.race([
      client.session.prompt({
        path: { id: sessionId },
        body,
        throwOnError: true,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timed out')), TIMEOUT_MS)
      ),
    ]);
    return result;
  }

  async function reconnectSession() {
    try {
      const baseUrl = `http://${CONFIG.OPCODE_HOSTNAME}:${CONFIG.OPCODE_PORT}`;
      const healthCheck = await fetch(`${baseUrl}/health`).then(r => r.ok).catch(() => false);
      if (!healthCheck) {
        log('info', 'brain', 'Server down, restarting...');
        server = null;
        server = await createOpencodeServer({
          port: CONFIG.OPCODE_PORT,
          hostname: CONFIG.OPCODE_HOSTNAME,
          timeout: CONFIG.OPCODE_START_TIMEOUT,
        });
        const newBaseUrl = server.url;
        client = createOpencodeClient({ baseUrl: newBaseUrl, responseStyle: 'data' });
        log('success', 'brain', `Server restarted at ${newBaseUrl}`);
      }
      const ns = await client.session.create({
        body: { title: `DexScalp-${Date.now()}` },
      });
      if (ns?.id) {
        sessionId = ns.id;
        const initBody = {
          noReply: true,
          parts: [{ type: 'text', text: 'You are a scalping agent. Always respond with JSON.' }],
        };
        if (modelRef) initBody.model = modelRef;
        await client.session.prompt({ path: { id: sessionId }, body: initBody });
        log('success', 'brain', `New session: ${sessionId}`);
        return true;
      }
    } catch (e) {
      log('warn', 'brain', `Reconnect failed: ${e.message}`);
    }
    return false;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const promptBody = {
        parts: [{ type: 'text', text: prompt }],
      };
      if (modelRef) promptBody.model = modelRef;

      const msg = await promptWithTimeout(promptBody);

      if (!msg) {
        log('warn', 'brain', `Prompt returned null/empty (attempt ${attempt + 1})`);
        if (attempt < maxRetries) continue;
        return { action: 'HOLD', strategy: 'MEAN_REVERSION', confidence: 0, reasoning: 'Empty AI response. HOLD.' };
      }

      const textParts = msg.parts?.map(p => p.text || '').join('') || '';

      const structured = msg.info?.structured_output || msg.info?.structured;
      if (structured) {
        return structured;
      }

      if (msg.info?.error) {
        log('warn', 'brain', `AI error: ${JSON.stringify(msg.info.error).substring(0, 200)}`);
        if (msg.info.error.name === 'StructuredOutputError' && attempt < maxRetries) continue;
      }

      const jsonMatch = textParts.match(/\{[\s\S]*"action"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.action && ['BUY', 'SELL', 'HOLD'].includes(parsed.action)) {
            log('success', 'brain', `Parsed JSON from text: ${parsed.action}`);
            return parsed;
          }
        } catch {}
      }

      log('warn', 'brain', `No structured output. Finish: ${msg.info?.finish}. Error: ${msg.info?.error?.name || 'none'}. Keys: ${Object.keys(msg.info || {}).join(', ')}`);
      if (attempt < maxRetries) {
        log('info', 'brain', 'Retrying...');
        continue;
      }

      return { action: 'HOLD', strategy: 'MEAN_REVERSION', confidence: 0, reasoning: 'No structured output received. HOLD.' };
    } catch (err) {
      const errMsg = err?.message || err?.data?.message || String(err);
      log('error', 'brain', `Prompt error (attempt ${attempt + 1}): ${errMsg}`);

      if (errMsg.includes('fetch failed') || errMsg.includes('abort') || errMsg.includes('network')) {
        log('info', 'brain', 'Connection issue, reconnecting session...');
        await reconnectSession();
      }

      if (attempt < maxRetries) {
        const delay = Math.min(5000 * (attempt + 1), 15000);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return { action: 'HOLD', strategy: 'MEAN_REVERSION', confidence: 0, reasoning: `AI error: ${errMsg}. HOLD.` };
    }
  }

  return { action: 'HOLD', strategy: 'MEAN_REVERSION', confidence: 0, reasoning: 'Max retries. HOLD.' };
}

export function getClient() {
  return client;
}

export function getServer() {
  return server;
}
