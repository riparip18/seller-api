// Shared transaction delivery: webhook -> lookup detail items -> process each item.
// Used by server.js (local) and netlify/functions/webhook.js (hosted).
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const axios = require('axios');
const { ACCESS_KEY, SECRET_KEY, BASE_URL } = require('../config');

const REQUEST_TIMEOUT_MS = 5000;
const MIN_REQUEST_TIMEOUT_MS = 1000;
const MAX_ATTEMPTS = 3; // 1 try + 2 retries
const BASE_BACKOFF_MS = 200;
// Whole-webhook budget; keeps us under Netlify's 10s function limit.
const DELIVERY_DEADLINE_MS = 8000;
const MAX_CONCURRENCY = 5; // parallel process calls per transaction
const MAX_REMEMBERED_IDS = 10000;
const DELIVERY_DATA = ['Transaksi berhasil diproses'];

// Keep-alive agents reuse TCP/TLS connections, saving a handshake on every call.
const defaultClient = axios.create({
	baseURL: BASE_URL,
	timeout: REQUEST_TIMEOUT_MS,
	httpAgent: new http.Agent({ keepAlive: true }),
	httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 20 }),
});

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function generateSignature(pathStr) {
	const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
	const toSign = `${pathStr}${ACCESS_KEY}${timestamp}`;
	const hmac = crypto.createHmac('sha512', SECRET_KEY).update(toSign, 'utf8').digest('hex');
	const signature = Buffer.from(hmac, 'utf8').toString('base64');
	return { signature, timestamp };
}

// Signature is regenerated per attempt so retries never reuse a stale timestamp.
function signedParams(pathStr, extra) {
	const { signature, timestamp } = generateSignature(pathStr);
	return { access_token: ACCESS_KEY, timestamp, sign: signature, ...extra };
}

// GET is safe to repeat: retry any network error, 429 or 5xx.
function isRetryableRead(err) {
	const status = err?.response?.status;
	if (!status) return true;
	return status === 429 || status >= 500;
}

// POST /process is not idempotent. Only retry when the request clearly never got applied:
// connection-level failures, rate limiting, or gateway errors. A timeout or plain 500 may
// mean the item was already delivered, so retrying could deliver it twice.
const UNSENT_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']);
const UNAPPLIED_STATUSES = new Set([429, 502, 503, 504]);
function isRetryableWrite(err) {
	const status = err?.response?.status;
	if (!status) return UNSENT_ERROR_CODES.has(err?.code);
	return UNAPPLIED_STATUSES.has(status);
}

function extractId(item) {
	return item?.id ?? item?.detail_id ?? item?.transaction_detail_id ?? item?.trx_detail_id ?? null;
}

function extractTrxId(payload) {
	return payload?.data?.transaction_id
		?? payload?.data?.trx_id
		?? payload?.transaction_id
		?? payload?.trx_id
		?? null;
}

function extractDetailIds(body) {
	const data = body?.data;
	const list = [data?.items, data, body?.items].find((x) => Array.isArray(x) && x.length > 0);
	if (list) return list.map(extractId).filter(Boolean);
	const single = data && typeof data === 'object' ? extractId(data) : null;
	return single ? [single] : [];
}

async function mapWithConcurrency(items, limit, fn) {
	const results = new Array(items.length);
	let cursor = 0;
	const worker = async () => {
		while (cursor < items.length) {
			const index = cursor++;
			results[index] = await fn(items[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

// Set that forgets its oldest entries so a long-running server does not grow unbounded.
function createBoundedSet(max) {
	const set = new Set();
	return {
		has: (value) => set.has(value),
		add: (value) => {
			set.add(value);
			if (set.size > max) set.delete(set.values().next().value);
		},
	};
}

/**
 * @param {{ client?: object, sleep?: (ms: number) => Promise<void>, maxAttempts?: number, deadlineMs?: number, logger?: Console }} [options]
 */
function createDelivery({
	client = defaultClient,
	sleep = defaultSleep,
	maxAttempts = MAX_ATTEMPTS,
	deadlineMs = DELIVERY_DEADLINE_MS,
	logger = console,
} = {}) {
	const deliveredIds = createBoundedSet(MAX_REMEMBERED_IDS);
	const inFlight = new Map();

	// fn receives the per-request timeout left in the delivery budget.
	async function withRetry(label, deadline, isRetryable, fn) {
		for (let attempt = 1; ; attempt++) {
			const remaining = deadline - Date.now();
			try {
				return await fn(Math.max(MIN_REQUEST_TIMEOUT_MS, Math.min(REQUEST_TIMEOUT_MS, remaining)));
			} catch (err) {
				const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
				const outOfTime = Date.now() + delay + MIN_REQUEST_TIMEOUT_MS > deadline;
				if (attempt >= maxAttempts || outOfTime || !isRetryable(err)) throw err;
				logger.warn(`[delivery] ${label} attempt ${attempt} failed (${err.response?.status || err.code || err.message}), retry in ${delay}ms`);
				await sleep(delay);
			}
		}
	}

	async function getTransactionDetailIds(trxId, deadline) {
		const pathStr = '/rest/transaction/get';
		const res = await withRetry(`get ${trxId}`, deadline, isRetryableRead, (timeout) =>
			client.get(pathStr, { timeout, params: signedParams(pathStr, { transaction_id: trxId }) }));
		return extractDetailIds(res.data);
	}

	async function processDetail(detailId, deadline) {
		const pathStr = '/rest/transaction/process';
		try {
			await withRetry(`process ${detailId}`, deadline, isRetryableWrite, (timeout) =>
				client.post(pathStr, { delivery_data: DELIVERY_DATA }, {
					timeout,
					params: signedParams(pathStr, { transaction_detail_id: detailId }),
				}));
			deliveredIds.add(detailId);
			return { id: detailId, ok: true };
		} catch (err) {
			logger.error('[delivery] process failed:', detailId, err.message, err.response?.data);
			return { id: detailId, ok: false, status: err.response?.status ?? null, error: err.message };
		}
	}

	async function runDelivery(trxId) {
		const deadline = Date.now() + deadlineMs;
		let detailIds;
		try {
			detailIds = await getTransactionDetailIds(trxId, deadline);
		} catch (err) {
			logger.error('[delivery] lookup failed:', trxId, err.message, err.response?.data);
			return { trxId, lookupFailed: true, detailIds: [], skipped: [], processed: [], failed: [] };
		}
		const skipped = detailIds.filter((id) => deliveredIds.has(id));
		const pending = detailIds.filter((id) => !deliveredIds.has(id));
		const results = await mapWithConcurrency(pending, MAX_CONCURRENCY, (id) => processDetail(id, deadline));
		return {
			trxId,
			lookupFailed: false,
			detailIds,
			skipped,
			processed: results.filter((r) => r.ok).map((r) => r.id),
			failed: results.filter((r) => !r.ok),
		};
	}

	// Duplicate webhooks for a transaction that is still running share the same promise.
	function deliverTransaction(trxId) {
		if (inFlight.has(trxId)) return inFlight.get(trxId);
		const promise = runDelivery(trxId).finally(() => inFlight.delete(trxId));
		inFlight.set(trxId, promise);
		return promise;
	}

	return { deliverTransaction };
}

// Maps a delivery result to the HTTP status/body returned to the webhook caller.
function toWebhookResponse(result) {
	if (result.lookupFailed) {
		return { status: 502, body: { error: 'Gagal mengambil detail transaksi', trxId: result.trxId } };
	}
	if (result.detailIds.length === 0) {
		return { status: 404, body: { error: 'transaction_detail_id tidak ditemukan', trxId: result.trxId } };
	}
	if (result.failed.length > 0) {
		return {
			status: 500,
			body: { error: 'Sebagian transaksi gagal diproses', processed: result.processed.length, failed: result.failed },
		};
	}
	if (result.processed.length === 0) return { status: 204, body: null };
	return { status: 200, body: { status: 'Semua transaksi berhasil diproses', processed: result.processed.length } };
}

module.exports = { createDelivery, extractTrxId, toWebhookResponse, ...createDelivery() };
