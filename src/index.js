   // redeploy
import { buildPushPayload } from '@block65/webcrypto-web-push';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

const DEFAULT_GAMES = [
  { id: 'marshall', opponent: 'Marshall', date: '2026-09-05', threshold: 25 },
  { id: 'buffalo', opponent: 'Buffalo', date: '2026-09-19', threshold: 25 },
  { id: 'wisconsin', opponent: 'Wisconsin', date: '2026-09-26', threshold: 40 },
  { id: 'usc', opponent: 'USC', date: '2026-10-10', threshold: 60 },
  { id: 'purdue', opponent: 'Purdue', date: '2026-10-31', threshold: 30 },
  { id: 'minnesota', opponent: 'Minnesota', date: '2026-11-14', threshold: 30 },
  { id: 'rutgers', opponent: 'Rutgers', date: '2026-11-21', threshold: 25 },
];

async function getGames(env) {
  const raw = await env.TICKETS_KV.get('games');
  if (raw) return JSON.parse(raw);
  await env.TICKETS_KV.put('games', JSON.stringify(DEFAULT_GAMES));
  return DEFAULT_GAMES;
}

async function getPrices(env, gameId) {
  const raw = await env.TICKETS_KV.get(`prices:${gameId}`);
  return raw ? JSON.parse(raw) : [];
}

function average(nums) {
  if (!nums.length) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
}

function gameStats(prices) {
  const now = Date.now();
  const last24h = prices.filter((p) => now - p.ts < 24 * 60 * 60 * 1000).map((p) => p.price);
  const all = prices.map((p) => p.price);
  return {
    avg24h: average(last24h),
    avgAll: average(all),
    low: all.length ? Math.min(...all) : null,
    latest: prices.length ? prices[prices.length - 1] : null,
    count: prices.length,
  };
}

async function getSubs(env) {
  const raw = await env.TICKETS_KV.get('subs');
  return raw ? JSON.parse(raw) : [];
}

async function sendPushToAll(env, notification) {
  const subs = await getSubs(env);
  if (!subs.length) return;

  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  const message = {
    data: JSON.stringify(notification),
    options: { ttl: 3600, urgency: 'high' },
  };

  const stillValid = [];
  for (const sub of subs) {
    try {
      const req = await buildPushPayload(message, sub, vapid);
      const res = await fetch(sub.endpoint, req);
      if (res.status !== 404 && res.status !== 410) stillValid.push(sub);
    } catch (err) {
      console.error('push send failed', err);
      stillValid.push(sub);
    }
  }
  if (stillValid.length !== subs.length) {
    await env.TICKETS_KV.put('subs', JSON.stringify(stillValid));
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      if (pathname === '/api/games' && request.method === 'GET') {
        const games = await getGames(env);
        const withStats = await Promise.all(
          games.map(async (g) => ({ ...g, stats: gameStats(await getPrices(env, g.id)) })),
        );
        return json(withStats);
      }

      if (pathname === '/api/games/threshold' && request.method === 'POST') {
        const { id, threshold } = await request.json();
        const games = await getGames(env);
        const idx = games.findIndex((g) => g.id === id);
        if (idx === -1) return json({ error: 'game not found' }, 404);
        games[idx].threshold = Number(threshold);
        await env.TICKETS_KV.put('games', JSON.stringify(games));
        return json({ ok: true });
      }

      if (pathname === '/api/price' && request.method === 'POST') {
        const { gameId, price, seats, who } = await request.json();
        const games = await getGames(env);
        const game = games.find((g) => g.id === gameId);
        if (!game) return json({ error: 'game not found' }, 404);

        const prices = await getPrices(env, gameId);
        prices.push({ price: Number(price), seats: seats ?? null, who: who || 'someone', ts: Date.now() });
        await env.TICKETS_KV.put(`prices:${gameId}`, JSON.stringify(prices));

        const stats = gameStats(prices);

        if (game.threshold != null && Number(price) <= Number(game.threshold)) {
          await sendPushToAll(env, {
            title: `Great price: ${game.opponent}`,
            body: `$${price} logged by ${who || 'someone'} — at or below your $${game.threshold} target (avg $${stats.avgAll ?? '—'})`,
            tag: `price-${gameId}`,
          });
        }

        return json({ ok: true, stats });
      }

      if (pathname === '/api/vapid-public-key' && request.method === 'GET') {
        return json({ publicKey: env.VAPID_PUBLIC_KEY });
      }

      if (pathname === '/api/subscribe' && request.method === 'POST') {
        const { subscription, who } = await request.json();
        const subs = await getSubs(env);
        const withoutDupe = subs.filter((s) => s.endpoint !== subscription.endpoint);
        withoutDupe.push({ ...subscription, who: who || 'someone' });
        await env.TICKETS_KV.put('subs', JSON.stringify(withoutDupe));
        return json({ ok: true });
      }

      if (pathname === '/api/test-push' && request.method === 'POST') {
        await sendPushToAll(env, {
          title: 'Test notification',
          body: 'If you see this, push notifications are working.',
          tag: 'test',
        });
        return json({ ok: true });
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env) {
    const games = await getGames(env);
    const now = Date.now();
    const upcoming = games
      .filter((g) => new Date(g.date).getTime() > now)
      .sort((a, b) => new Date(a.date) - new Date(b.date))[0];

    if (!upcoming) return;

    const prices = await getPrices(env, upcoming.id);
    const stats = gameStats(prices);
    const daysAway = Math.ceil((new Date(upcoming.date).getTime() - now) / (24 * 60 * 60 * 1000));

    await sendPushToAll(env, {
      title: `Check prices: ${upcoming.opponent}`,
      body: stats.low
        ? `${daysAway}d away. Lowest seen: $${stats.low} (avg $${stats.avgAll}). Target: $${upcoming.threshold}.`
        : `${daysAway}d away. Nothing logged yet — worth a quick check on pogoseat.`,
      tag: `reminder-${upcoming.id}`,
    });
  },
};
