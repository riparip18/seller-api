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
			const detailId = await getTransactionDetailId(trxId);
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
		const items = res.data?.data?.items || [];
		return items.length > 0 ? items[0]?.id : null;
	} catch (_) {
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
