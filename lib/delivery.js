// Shared transaction delivery: webhook -> lookup detail items -> process each item.
// Used by server.js (local) and netlify/functions/webhook.js (hosted).
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const axios = require('axios');
const { ACCOUNTS, BASE_URL } = require('../config');

const REQUEST_TIMEOUT_MS = 5000;
const MIN_REQUEST_TIMEOUT_MS = 1000;
const MAX_ATTEMPTS = 3; // 1 try + 2 retries
const BASE_BACKOFF_MS = 200;
// Whole-webhook budget; keeps us under Netlify's 10s function limit.
const DELIVERY_DEADLINE_MS = 8000;
const MAX_CONCURRENCY = 5; // parallel process calls per transaction
const MAX_REMEMBERED_IDS = 10000;
const DELIVERY_DATA = ['Transaksi berhasil diproses'];
// Item status from /rest/transaction/get: 2 = Perlu Diproses. Anything else (3 Dikirim,
// 4 Selesai, 5 Dibatalkan, 6 Moderasi) is already handled, so a repeated webhook must not resend it.
const STATUS_NEEDS_PROCESSING = 2;

// VCG answers HTTP 200 even on failure; body.status_code carries the outcome.
const VCG_OK = '00';
const VCG_NOT_FOUND = '44';
const VCG_TIMESTAMP_EXPIRED = '45';
const VCG_SIGNATURE_USED = '46';
// A signature covers only path + access key + minute, and since 2026-10-21 VCG accepts each one
// once (seller-backend-code middlewares/rest_sign_guard.go), with a timestamp up to 2 minutes off.
// So a second call to the same path in the same minute (another webhook, a retry, a parallel item)
// is rejected with 46; minutes M-1, M+1 and M+2 are still usable. Past ones go first to leave
// future minutes for later calls.
const SIGNATURE_MINUTE_OFFSETS = [0, -1, 1, 2];
const ONE_MINUTE_MS = 60 * 1000;

// Keep-alive agents reuse TCP/TLS connections, saving a handshake on every call.
const defaultClient = axios.create({
	baseURL: BASE_URL,
	timeout: REQUEST_TIMEOUT_MS,
	httpAgent: new http.Agent({ keepAlive: true }),
	httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 20 }),
});

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function minuteTimestamp(ms) {
	return new Date(ms).toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
}

function signedParams(account, pathStr, extra, timestamp) {
	const toSign = `${pathStr}${account.accessKey}${timestamp}`;
	const hmac = crypto.createHmac('sha512', account.secretKey).update(toSign, 'utf8').digest('hex');
	const sign = Buffer.from(hmac, 'utf8').toString('base64');
	return { access_token: account.accessKey, timestamp, sign, ...extra };
}

function vcgError(res) {
	const code = res?.data?.status_code;
	const err = new Error(`VCG ${code}: ${res?.data?.message || 'unknown error'}`);
	err.vcgCode = code;
	return err;
}

// Responses without a status_code are treated as success, as before.
function assertVcgOk(res) {
	const code = res?.data?.status_code;
	if (code !== undefined && code !== VCG_OK) throw vcgError(res);
	return res;
}

// GET is safe to repeat: retry any network error, 429 or 5xx.
function isRetryableRead(err) {
	if (err?.vcgCode) return false; // VCG answered; repeating the same call gets the same answer
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
	if (err?.vcgCode) return false;
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

// Returns [{ id, status }]; status is undefined when the API does not send one.
function extractDetailItems(body) {
	const data = body?.data;
	const list = [data?.items, data, body?.items].find((x) => Array.isArray(x) && x.length > 0);
	const toItem = (item) => ({ id: extractId(item), status: item?.status });
	if (list) return list.map(toItem).filter((item) => item.id);
	const single = data && typeof data === 'object' ? toItem(data) : null;
	return single?.id ? [single] : [];
}

function needsProcessing(item) {
	return item.status === undefined || item.status === STATUS_NEEDS_PROCESSING;
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
 * @param {{ accounts?: Array<{ name: string, accessKey: string, secretKey: string }>, client?: object, sleep?: (ms: number) => Promise<void>, maxAttempts?: number, deadlineMs?: number, logger?: Console, now?: () => number }} [options]
 */
function createDelivery({
	accounts = ACCOUNTS,
	client = defaultClient,
	sleep = defaultSleep,
	maxAttempts = MAX_ATTEMPTS,
	deadlineMs = DELIVERY_DEADLINE_MS,
	logger = console,
	now = Date.now,
} = {}) {
	const deliveredIds = createBoundedSet(MAX_REMEMBERED_IDS);
	const inFlight = new Map();
	// Signatures this process already sent. Parallel calls (items of one transaction) skip them
	// instead of colliding; other processes (e.g. Netlify instances) still collide and get 46.
	const spentSignatures = createBoundedSet(MAX_REMEMBERED_IDS);

	// Per-request timeout left in the delivery budget.
	const requestTimeout = (deadline) => Math.max(MIN_REQUEST_TIMEOUT_MS, Math.min(REQUEST_TIMEOUT_MS, deadline - now()));

	// Sends with each still-valid signature minute until VCG stops rejecting the signature itself.
	// A 45/46 rejection happens before VCG acts on the request, so resending is safe even for POST.
	// The first try always goes out; later ones only while the delivery budget allows a request.
	async function sendSigned(account, pathStr, extra, deadline, send) {
		let res = { data: { status_code: VCG_SIGNATURE_USED, message: 'every usable signature minute is already spent' } };
		let sent = 0;
		for (const offset of SIGNATURE_MINUTE_OFFSETS) {
			if (sent > 0 && deadline - now() < MIN_REQUEST_TIMEOUT_MS) break;
			const timestamp = minuteTimestamp(now() + offset * ONE_MINUTE_MS);
			const signatureKey = `${account.accessKey}|${pathStr}|${timestamp}`;
			if (spentSignatures.has(signatureKey)) continue;
			spentSignatures.add(signatureKey);
			sent += 1;
			res = await send(signedParams(account, pathStr, extra, timestamp), requestTimeout(deadline));
			const code = res?.data?.status_code;
			if (code !== VCG_SIGNATURE_USED && code !== VCG_TIMESTAMP_EXPIRED) return res;
			logger.warn(`[delivery] ${pathStr} [${account.name}] signature ${timestamp} rejected (${code}), trying another minute`);
		}
		return res;
	}

	async function withRetry(label, deadline, isRetryable, fn) {
		for (let attempt = 1; ; attempt++) {
			try {
				return await fn();
			} catch (err) {
				const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
				const outOfTime = now() + delay + MIN_REQUEST_TIMEOUT_MS > deadline;
				if (attempt >= maxAttempts || outOfTime || !isRetryable(err)) throw err;
				logger.warn(`[delivery] ${label} attempt ${attempt} failed (${err.response?.status || err.code || err.message}), retry in ${delay}ms`);
				await sleep(delay);
			}
		}
	}

	async function getTransactionDetailIds(account, trxId, deadline) {
		const pathStr = '/rest/transaction/get';
		const res = await withRetry(`get ${trxId} [${account.name}]`, deadline, isRetryableRead, async () => {
			const reply = await sendSigned(account, pathStr, { transaction_id: trxId }, deadline,
				(params, timeout) => client.get(pathStr, { timeout, params }));
			// 44 = this account does not own the transaction: a valid "empty" answer, not an error.
			return reply?.data?.status_code === VCG_NOT_FOUND ? reply : assertVcgOk(reply);
		});
		return extractDetailItems(res.data);
	}

	// Looks the transaction up on every account in parallel; the account that owns it wins.
	// If none has it and any lookup errored, we cannot be sure it does not exist -> throw.
	async function findTransaction(trxId, deadline) {
		const lookups = await Promise.allSettled(accounts.map((a) => getTransactionDetailIds(a, trxId, deadline)));
		const hit = lookups.findIndex((r) => r.status === 'fulfilled' && r.value.length > 0);
		if (hit >= 0) return { account: accounts[hit], items: lookups[hit].value };
		const errors = lookups.filter((r) => r.status === 'rejected');
		if (errors.length > 0) throw errors[0].reason;
		return { account: null, items: [] };
	}

	async function processDetail(account, detailId, deadline) {
		const pathStr = '/rest/transaction/process';
		try {
			await withRetry(`process ${detailId} [${account.name}]`, deadline, isRetryableWrite, async () =>
				assertVcgOk(await sendSigned(account, pathStr, { transaction_detail_id: detailId }, deadline,
					(params, timeout) => client.post(pathStr, { delivery_data: DELIVERY_DATA }, { timeout, params }))));
			deliveredIds.add(detailId);
			return { id: detailId, ok: true };
		} catch (err) {
			logger.error('[delivery] process failed:', detailId, err.message, err.response?.data);
			return { id: detailId, ok: false, status: err.response?.status ?? null, error: err.message };
		}
	}

	async function runDelivery(trxId) {
		const deadline = now() + deadlineMs;
		let account;
		let items;
		try {
			({ account, items } = await findTransaction(trxId, deadline));
		} catch (err) {
			logger.error('[delivery] lookup failed:', trxId, err.message, err.response?.data);
			return { trxId, lookupFailed: true, detailIds: [], skipped: [], processed: [], failed: [] };
		}
		const detailIds = items.map((item) => item.id);
		const isPending = (item) => needsProcessing(item) && !deliveredIds.has(item.id);
		const skipped = items.filter((item) => !isPending(item)).map((item) => item.id);
		const pending = items.filter(isPending).map((item) => item.id);
		const results = await mapWithConcurrency(pending, MAX_CONCURRENCY, (id) => processDetail(account, id, deadline));
		return {
			trxId,
			account: account?.name ?? null,
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
	if (result.processed.length === 0) {
		return { status: 200, body: { status: 'Transaksi sudah diproses sebelumnya', skipped: result.skipped.length } };
	}
	return { status: 200, body: { status: 'Semua transaksi berhasil diproses', processed: result.processed.length } };
}

// httpClient is exported so server.js can attach the API hit logger to it.
module.exports = { createDelivery, extractTrxId, toWebhookResponse, httpClient: defaultClient, ...createDelivery() };
