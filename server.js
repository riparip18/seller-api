const express = require('express');
const cors = require('cors');
const { spawn, exec } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');

const { ACCESS_KEY, SECRET_KEY, BASE_URL, NGROK_STATIC_DOMAIN } = require('./config');

const app = express();
const PORT = process.env.PORT || 5000;
const API_TIMEOUT = 10000; // 10s timeout for upstream API

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ===== State =====
let ngrokProcess = null;
let serviceState = {
	tunnel_running: false,
	tunnel_pid: null,
	webhook_url: `https://${NGROK_STATIC_DOMAIN}/webhook`,
	status_url: `https://${NGROK_STATIC_DOMAIN}/`,
	last_check: new Date(),
	controls_enabled: process.env.ENABLE_CONTROLS !== 'false'
};

const processedIds = new Set();

// ===== Helpers =====
function generateSignature(pathStr) {
	const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
	const toSign = `${pathStr}${ACCESS_KEY}${timestamp}`;
	const hmac = crypto.createHmac('sha512', SECRET_KEY).update(toSign, 'utf8').digest('hex');
	const signature = Buffer.from(hmac, 'utf8').toString('base64');
	return { signature, timestamp };
}

function resolveNgrokBinary() {
	const localWin = path.join(__dirname, 'ngrok.exe');
	if (process.platform === 'win32' && fs.existsSync(localWin)) return localWin;
	return 'ngrok';
}

async function getNgrokPublicUrl() {
	try {
		const res = await axios.get('http://127.0.0.1:4040/api/tunnels', { timeout: 2000 });
		const tunnels = res.data?.tunnels || [];
		const https = tunnels.find(t => (t.public_url || '').startsWith('https://'));
		const http = tunnels.find(t => (t.public_url || '').startsWith('http://'));
		return (https || http)?.public_url || null;
	} catch (_) {
		return null;
	}
}


async function startNgrok() {
	return new Promise(async (resolve) => {
		try {
			if (ngrokProcess && serviceState.tunnel_running) {
				const url = await getNgrokPublicUrl();
				if (url) {
					serviceState = { ...serviceState, webhook_url: `${url}/webhook`, status_url: `${url}/`, last_check: new Date() };
				}
				return resolve({ success: true, message: 'Ngrok already running', pid: serviceState.tunnel_pid });
			}
			const bin = resolveNgrokBinary();
			// Try reserved domain first
			if (NGROK_STATIC_DOMAIN) {
				ngrokProcess = spawn(bin, ['http', `--url=${NGROK_STATIC_DOMAIN}`, String(PORT)], {
					cwd: __dirname,
					detached: true,
					stdio: 'ignore'
				});
				ngrokProcess.unref();
				await new Promise(r => setTimeout(r, 3000));
				let url = await getNgrokPublicUrl();
				if (url) {
					serviceState = { ...serviceState, tunnel_running: true, tunnel_pid: ngrokProcess.pid, webhook_url: `${url}/webhook`, status_url: `${url}/`, last_check: new Date() };
					return resolve({ success: true, pid: ngrokProcess.pid, message: 'Ngrok started (reserved domain)' });
				}
				await stopNgrok();
			}
			// Fallback to random domain
			ngrokProcess = spawn(bin, ['http', String(PORT)], {
				cwd: __dirname,
				detached: true,
				stdio: 'ignore'
			});
			ngrokProcess.unref();
			await new Promise(r => setTimeout(r, 3000));
			const url = await getNgrokPublicUrl();
			if (url) {
				serviceState = { ...serviceState, tunnel_running: true, tunnel_pid: ngrokProcess.pid, webhook_url: `${url}/webhook`, status_url: `${url}/`, last_check: new Date() };
				return resolve({ success: true, pid: ngrokProcess.pid, message: 'Ngrok started (random domain)' });
			}
			return resolve({ success: false, pid: null, message: 'Failed to get ngrok public URL' });
		} catch (error) {
			resolve({ success: false, pid: null, message: `Failed to start ngrok: ${error.message}` });
		}
	});
}

async function stopNgrok() {
	return new Promise((resolve) => {
		const finish = (ok) => {
			serviceState = { ...serviceState, tunnel_running: false, tunnel_pid: null, last_check: new Date() };
			ngrokProcess = null;
			resolve(ok);
		};
		try {
			if (process.platform === 'win32') {
				exec('taskkill /F /IM ngrok.exe', () => finish(true));
			} else {
				exec('pkill ngrok', () => finish(true));
			}
		} catch (_) {
			finish(false);
		}
	});
}

// ===== Core API (same behavior as Python) =====
app.get('/', (req, res) => {
	res.json({ message: 'Seller API aktif', status: 'ok', webhook_url: serviceState.webhook_url });
});

app.post('/', (req, res) => {
	res.json({ message: 'Pesanan diterima', data: req.body || {} });
});

app.all('/webhook', async (req, res) => {
	if (req.method === 'GET') {
		return res.status(200).json({ message: 'Endpoint webhook tersedia' });
	}
	try {
		const payload = req.body || {};
		if (!payload || Object.keys(payload).length === 0) {
			return res.status(400).json({ error: 'Payload kosong' });
		}
		if (payload.message_type === 2) {
			const trxId = payload.data?.transaction_id;
			console.log('[webhook] message_type=2, trxId:', trxId, '| payload.data:', JSON.stringify(payload.data));
			if (!trxId) return res.status(400).json({ error: 'transaction_id tidak ada di payload' });
			const detailId = await getTransactionDetailId(trxId);
			console.log('[webhook] detailId result:', detailId);
			if (!detailId) return res.status(404).json({ error: 'transaction_detail_id tidak ditemukan' });
			if (processedIds.has(detailId)) return res.status(204).send('');
			const success = await processTransaction(detailId);
			if (success) {
				processedIds.add(detailId);
				return res.status(200).json({ status: 'Transaksi berhasil diproses' });
			}
			return res.status(500).json({ error: 'Gagal memproses transaksi' });
		}
		return res.status(200).json({ status: 'Diabaikan (bukan transaksi)' });
	} catch (e) {
		return res.status(500).json({ error: String(e.message || e) });
	}
});

// ===== VC Gamers Transaction APIs (proxy) =====
app.get('/api/transactions', async (req, res) => {
    try {
        const pathStr = '/rest/transaction/all';
        const { signature, timestamp } = generateSignature(pathStr);
        const url = `${BASE_URL}${pathStr}`;

        const {
            next_cursor,
            prev_cursor,
            limit,
            search,
            date_start,
            date_end,
            status
        } = req.query || {};

        const params = {
            access_token: ACCESS_KEY,
            timestamp,
            sign: signature,
        };
        if (next_cursor) params.next_cursor = next_cursor;
        if (prev_cursor) params.prev_cursor = prev_cursor;
        if (limit) params.limit = limit;
        if (search) params.search = search;
        if (date_start) params.date_start = date_start;
        if (date_end) params.date_end = date_end;
        if (status) params.status = status;

        const apiRes = await axios.get(url, { params });
        return res.status(200).json({ success: true, data: apiRes.data?.data || {} });
    } catch (e) {
        return res.status(500).json({ success: false, error: String(e.message || e) });
    }
});

app.get('/api/transactions/summary', async (req, res) => {
    try {
        const pathStr = '/rest/transaction/all';
        const { signature, timestamp } = generateSignature(pathStr);
        const url = `${BASE_URL}${pathStr}`;

        const { date_start, date_end, status, limit = 100 } = req.query || {};

        const params = {
            access_token: ACCESS_KEY,
            timestamp,
            sign: signature,
            limit
        };
        if (date_start) params.date_start = date_start;
        if (date_end) params.date_end = date_end;
        if (status) params.status = status;

        let pendapatanTotal = 0;
        let potonganTotal = 0;
        let nextCursor = undefined;

        // Fetch pages until no next_cursor
        for (let i = 0; i < 10; i++) { // safety cap
            const apiRes = await axios.get(url, { params: { ...params, next_cursor: nextCursor } });
            const payload = apiRes.data?.data || {};
            const items = payload.items || [];

            for (const item of items) {
                const income = Number(item?.amount) || 0; // gross income from API field
                const fee = Number(item?.fee || item?.platform_fee || item?.service_fee || 0);
                pendapatanTotal += income;
                potonganTotal += fee;
            }

            const cursor = payload.next_cursor;
            if (!cursor) break;
            nextCursor = cursor;
        }

        const labaBersih = pendapatanTotal - potonganTotal;

        return res.status(200).json({
            success: true,
            data: {
                pendapatan: pendapatanTotal,
                potongan: potonganTotal,
                laba_bersih: labaBersih
            }
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: String(e.message || e) });
    }
});

// ===== Balance APIs =====
app.get('/api/balance', async (req, res) => {
    try {
        const pathStr = '/rest/balance/get';
        const { signature, timestamp } = generateSignature(pathStr);
        const url = `${BASE_URL}${pathStr}`;
        const params = { access_token: ACCESS_KEY, timestamp, sign: signature };
        const apiRes = await axios.get(url, { params });
        return res.status(200).json({ success: true, data: apiRes.data?.data || {} });
    } catch (e) {
        return res.status(500).json({ success: false, error: String(e.message || e) });
    }
});

app.get('/api/balance/histories', async (req, res) => {
    try {
        const pathStr = '/rest/balance/histories';
        const { signature, timestamp } = generateSignature(pathStr);
        const url = `${BASE_URL}${pathStr}`;
        const { next_cursor, prev_cursor, limit = 50, search } = req.query || {};
        const params = { access_token: ACCESS_KEY, timestamp, sign: signature, limit };
        if (next_cursor) params.next_cursor = next_cursor;
        if (prev_cursor) params.prev_cursor = prev_cursor;
        if (search) params.search = search;
        const apiRes = await axios.get(url, { params });
        return res.status(200).json({ success: true, data: apiRes.data?.data || {} });
    } catch (e) {
        return res.status(500).json({ success: false, error: String(e.message || e) });
    }
});

app.get('/api/balance/summary', async (req, res) => {
    try {
        const pathStr = '/rest/balance/histories';
        const { signature, timestamp } = generateSignature(pathStr);
        const url = `${BASE_URL}${pathStr}`;
        const { limit = 100, search } = req.query || {};
        const baseParams = { access_token: ACCESS_KEY, timestamp, sign: signature, limit };
        if (search) baseParams.search = search;

        let pendapatanTotal = 0;
        let potonganTotal = 0;
        let nextCursor;

        for (let i = 0; i < 10; i++) {
            const params = nextCursor ? { ...baseParams, next_cursor: nextCursor } : baseParams;
            const apiRes = await axios.get(url, { params });
            const payload = apiRes.data?.data || {};
            const items = payload.items || [];
            for (const item of items) {
                const amount = Number(item?.amount) || 0;
                if (amount >= 0) pendapatanTotal += amount; else potonganTotal += Math.abs(amount);
            }
            nextCursor = payload.next_cursor;
            if (!nextCursor) break;
        }

        const labaBersih = pendapatanTotal - potonganTotal;
        return res.status(200).json({ success: true, data: { pendapatan: pendapatanTotal, potongan: potonganTotal, laba_bersih: labaBersih } });
    } catch (e) {
        return res.status(500).json({ success: false, error: String(e.message || e) });
    }
});

// ===== Product APIs =====
// Simple in-memory cache for product lookups (local-only convenience)
const productCache = new Map();
function cacheKey(pathStr, params) {
	const ordered = Object.keys(params || {}).sort().reduce((acc, k) => { acc[k] = params[k]; return acc; }, {});
	return `${pathStr}|${JSON.stringify(ordered)}`;
}
function getFromCache(pathStr, params, ttlMs) {
	const key = cacheKey(pathStr, params);
	const entry = productCache.get(key);
	if (!entry) return { hit: false, data: null };
	const isFresh = (Date.now() - entry.ts) < ttlMs;
	if (!isFresh) { productCache.delete(key); return { hit: false, data: null }; }
	return { hit: true, data: entry.data };
}
function setCache(pathStr, params, data) {
	const key = cacheKey(pathStr, params);
	productCache.set(key, { ts: Date.now(), data });
}

app.get('/api/product/categories', async (req, res) => {
	try {
		const pathStr = '/rest/product/categories';
		const baseParams = { access_token: ACCESS_KEY };
		const cached = getFromCache(pathStr, baseParams, 5 * 60 * 1000); // 5 minutes
		if (cached.hit) {
			res.set('x-cache', 'HIT');
			return res.status(200).json({ success: true, data: cached.data });
		}
		const { signature, timestamp } = generateSignature(pathStr);
		const url = `${BASE_URL}${pathStr}`;
		const params = { access_token: ACCESS_KEY, timestamp, sign: signature };
		const apiRes = await axios.get(url, { params, timeout: API_TIMEOUT });
		const data = apiRes.data?.data || [];
		setCache(pathStr, baseParams, data);
		res.set('x-cache', 'MISS');
		return res.status(200).json({ success: true, data });
	} catch (e) {
		return res.status(500).json({ success: false, error: String(e.message || e) });
	}
});

app.get('/api/product/brands', async (req, res) => {
	try {
		const { category_id } = req.query || {};
		if (!category_id) return res.status(400).json({ success: false, error: 'Missing required parameter: category_id' });
		const pathStr = '/rest/product/brands';
		const baseParams = { access_token: ACCESS_KEY, category_id };
		const cached = getFromCache(pathStr, baseParams, 5 * 60 * 1000);
		if (cached.hit) {
			res.set('x-cache', 'HIT');
			return res.status(200).json({ success: true, data: cached.data });
		}
		const { signature, timestamp } = generateSignature(pathStr);
		const url = `${BASE_URL}${pathStr}`;
		const params = { access_token: ACCESS_KEY, timestamp, sign: signature, category_id };
		const apiRes = await axios.get(url, { params, timeout: API_TIMEOUT });
		const data = apiRes.data?.data || [];
		setCache(pathStr, baseParams, data);
		res.set('x-cache', 'MISS');
		return res.status(200).json({ success: true, data });
	} catch (e) {
		return res.status(500).json({ success: false, error: String(e.message || e) });
	}
});

app.get('/api/product/groups', async (req, res) => {
	try {
		const { category_id, brand_id } = req.query || {};
		if (!category_id) return res.status(400).json({ success: false, error: 'Missing required parameter: category_id' });
		if (!brand_id) return res.status(400).json({ success: false, error: 'Missing required parameter: brand_id' });
		const pathStr = '/rest/product/groups';
		const baseParams = { access_token: ACCESS_KEY, category_id, brand_id };
		const cached = getFromCache(pathStr, baseParams, 5 * 60 * 1000);
		if (cached.hit) {
			res.set('x-cache', 'HIT');
			return res.status(200).json({ success: true, data: cached.data });
		}
		const { signature, timestamp } = generateSignature(pathStr);
		const url = `${BASE_URL}${pathStr}`;
		const params = { access_token: ACCESS_KEY, timestamp, sign: signature, category_id, brand_id };
		const apiRes = await axios.get(url, { params, timeout: API_TIMEOUT });
		const data = apiRes.data?.data || [];
		setCache(pathStr, baseParams, data);
		res.set('x-cache', 'MISS');
		return res.status(200).json({ success: true, data });
	} catch (e) {
		return res.status(500).json({ success: false, error: String(e.message || e) });
	}
});
app.get('/api/product/variation-masters', async (req, res) => {
	try {
		const { group_id } = req.query || {};
		if (!group_id) {
			return res.status(400).json({ success: false, error: 'Missing required parameter: group_id' });
		}
		const pathStr = '/rest/product/variation-masters';
		const baseParams = { access_token: ACCESS_KEY, group_id };
		const cached = getFromCache(pathStr, baseParams, 2 * 60 * 1000); // 2 minutes
		if (cached.hit) {
			res.set('x-cache', 'HIT');
			return res.status(200).json({ success: true, data: cached.data });
		}
		const { signature, timestamp } = generateSignature(pathStr);
		const url = `${BASE_URL}${pathStr}`;
		const params = { access_token: ACCESS_KEY, timestamp, sign: signature, group_id };
		const apiRes = await axios.get(url, { params, timeout: API_TIMEOUT });
		const data = apiRes.data?.data || [];
		setCache(pathStr, baseParams, data);
		res.set('x-cache', 'MISS');
		return res.status(200).json({ success: true, data });
	} catch (e) {
		return res.status(500).json({ success: false, error: String(e.message || e) });
	}
});

// Utility to clear product cache (dev helper)
app.post('/api/product/cache/clear', (req, res) => {
	productCache.clear();
	res.json({ success: true, message: 'Product cache cleared' });
});

async function getTransactionDetailId(trxId) {
	const pathStr = '/rest/transaction/get';
	const { signature, timestamp } = generateSignature(pathStr);
	const url = `${BASE_URL}${pathStr}`;
	try {
		const res = await axios.get(url, {
			params: {
				access_token: ACCESS_KEY,
				timestamp,
				sign: signature,
				transaction_id: trxId
			}
		});
		console.log('[getTransactionDetailId] raw response:', JSON.stringify(res.data));
		// Coba beberapa kemungkinan struktur response
		const data = res.data?.data;
		// Kemungkinan 1: data.items[] dengan field id
		if (Array.isArray(data?.items) && data.items.length > 0) {
			const id = data.items[0]?.id ?? data.items[0]?.detail_id ?? data.items[0]?.transaction_detail_id;
			console.log('[getTransactionDetailId] found via items[0]:', id);
			return id || null;
		}
		// Kemungkinan 2: data langsung object (bukan array)
		if (data && !Array.isArray(data)) {
			const id = data.id ?? data.detail_id ?? data.transaction_detail_id;
			if (id) {
				console.log('[getTransactionDetailId] found via data object:', id);
				return id;
			}
		}
		console.log('[getTransactionDetailId] tidak ditemukan dari response:', JSON.stringify(data));
		return null;
	} catch (err) {
		console.error('[getTransactionDetailId] error:', err.message, err.response?.data);
		return null;
	}
}

async function processTransaction(detailId) {
	const pathStr = '/rest/transaction/process';
	const { signature, timestamp } = generateSignature(pathStr);
	const url = `${BASE_URL}${pathStr}`;
	try {
		const res = await axios.post(url, { delivery_data: ['Transaksi berhasil diproses'] }, {
			params: {
				access_token: ACCESS_KEY,
				timestamp,
				sign: signature,
				transaction_detail_id: detailId
			}
		});
		return res.status >= 200 && res.status < 300;
	} catch (_) {
		return false;
	}
}

// ===== Control endpoints for Start/Stop (tunnel only) =====
app.get('/api/status', async (req, res) => {
	const url = await getNgrokPublicUrl();
	if (url) {
		serviceState = { ...serviceState, tunnel_running: true, tunnel_pid: ngrokProcess?.pid || null, webhook_url: `${url}/webhook`, status_url: `${url}/`, last_check: new Date() };
	} else if (!ngrokProcess) {
		serviceState = { ...serviceState, tunnel_running: false, tunnel_pid: null, last_check: new Date() };
	}
	res.json({ success: true, data: serviceState });
});

app.post('/api/start', async (req, res) => {
	if (!serviceState.controls_enabled) return res.status(403).json({ success: false, message: 'Controls disabled in production' });
	const result = await startNgrok();
	res.json({ success: result.success, message: result.message, data: serviceState });
});

app.post('/api/stop', async (req, res) => {
	if (!serviceState.controls_enabled) return res.status(403).json({ success: false, message: 'Controls disabled in production' });
	const ok = await stopNgrok();
	res.json({ success: ok, message: ok ? 'Ngrok stopped' : 'Failed to stop ngrok', data: serviceState });
});

// Serve the main page
app.get('/', (req, res) => {
	res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
	console.log(`🎮 Seller API (Node) running on http://localhost:${PORT}`);
	console.log(`📊 Status API: http://localhost:${PORT}/api/status`);
	console.log(`🔗 Webhook URL: ${serviceState.webhook_url}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
	console.log('\n🛑 Shutting down...');
	await stopNgrok();
	process.exit(0);
});

module.exports = app;
