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
// Whole-webhook budget. VCG waits 10s for a webhook answer and never retries, and a Netlify
// cold start uses ~2-3s of that before this code runs, so the work itself must end by ~6s.
const DELIVERY_DEADLINE_MS = 6000;
const MAX_CONCURRENCY = 5; // parallel process calls per transaction
const MAX_REMEMBERED_IDS = 10000;
const DELIVERY_TEXT = 'Transaksi berhasil diproses';
// VCG answers 43 for a voucher/account item unless delivery_data has exactly one entry per unit
// bought, and ignores delivery_data for other items. The cap keeps a forged qty from exhausting memory.
const MAX_DELIVERY_QTY = 10000;
// Item status from /rest/transaction/get: 2 = Perlu Diproses. Anything else (3 Dikirim,
// 4 Selesai, 5 Dibatalkan, 6 Moderasi) is already handled, so a repeated webhook must not resend it.
const STATUS_NEEDS_PROCESSING = 2;

// VCG answers HTTP 200 even on failure; body.status_code carries the outcome.
const VCG_OK = '00';
const VCG_NOT_FOUND = '44';
const VCG_TIMESTAMP_EXPIRED = '45';
const VCG_SIGNATURE_USED = '46';
// Since seller-backend-code 1.1.42 (TASK-3405) each call carries a fresh nonce that is part of the
// sign, so signatures never repeat; staging also refuses calls without one (REST_NONCE_REQUIRED).
// VC_REST_NONCE=false signs the old way, for a VCG that predates the nonce.
const USE_NONCE_DEFAULT = process.env.VC_REST_NONCE !== 'false';
// Without a nonce a signature covers only path + access key + minute, and VCG 1.1.38 accepted each
// one once, with a timestamp up to 2 minutes off. So a second call to the same path in the same
// minute (another webhook, a retry, a parallel item) is rejected with 46; minutes M-1, M+1 and M+2
// are still usable. Past ones go first to leave future minutes for later calls.
const SIGNATURE_MINUTE_OFFSETS = [0, -1, 1, 2];
const NONCE_MINUTE_OFFSETS = [0];
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

// sign = base64(hex(HMAC-SHA512(secret, path + access_token + timestamp + nonce))); no nonce signs the old way.
function signedParams(account, pathStr, extra, timestamp, nonce = '') {
	const toSign = `${pathStr}${account.accessKey}${timestamp}${nonce}`;
	const hmac = crypto.createHmac('sha512', account.secretKey).update(toSign, 'utf8').digest('hex');
	const sign = Buffer.from(hmac, 'utf8').toString('base64');
	return { access_token: account.accessKey, timestamp, sign, ...(nonce ? { nonce } : {}), ...extra };
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

// VCG sends one transaction webhook per detail item, again on every status change, with the
// item id, its current status and quantity. Returns { id, status, sellerId, qty }, or null for other payloads.
function extractWebhookItem(payload) {
	const data = payload?.data;
	if (!data?.transaction_detail_id) return null;
	const status = data.status === undefined || data.status === null ? NaN : Number(data.status);
	return {
		id: data.transaction_detail_id,
		status: Number.isInteger(status) ? status : undefined,
		sellerId: payload.seller_id ?? null,
		qty: data.qty,
	};
}

// Returns [{ id, status, qty }]; status is undefined when the API does not send one.
function extractDetailItems(body) {
	const data = body?.data;
	const list = [data?.items, data, body?.items].find((x) => Array.isArray(x) && x.length > 0);
	const toItem = (item) => ({ id: extractId(item), status: item?.status, qty: item?.qty });
	if (list) return list.map(toItem).filter((item) => item.id);
	const single = data && typeof data === 'object' ? toItem(data) : null;
	return single?.id ? [single] : [];
}

// One entry per unit bought; a missing or invalid qty sends one entry, as before.
function deliveryData(qty) {
	const units = Number(qty);
	const count = Number.isInteger(units) && units > 0 ? Math.min(units, MAX_DELIVERY_QTY) : 1;
	return Array(count).fill(DELIVERY_TEXT);
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
 * @param {{ accounts?: Array<{ name: string, accessKey: string, secretKey: string }>, client?: object, sleep?: (ms: number) => Promise<void>, maxAttempts?: number, deadlineMs?: number, logger?: Console, now?: () => number, useNonce?: boolean }} [options]
 */
function createDelivery({
	accounts = ACCOUNTS,
	client = defaultClient,
	sleep = defaultSleep,
	maxAttempts = MAX_ATTEMPTS,
	deadlineMs = DELIVERY_DEADLINE_MS,
	logger = console,
	now = Date.now,
	useNonce = USE_NONCE_DEFAULT,
} = {}) {
	const deliveredIds = createBoundedSet(MAX_REMEMBERED_IDS);
	const inFlight = new Map();
	// Signatures this process already sent. Parallel calls (items of one transaction) skip them
	// instead of colliding; other processes (e.g. Netlify instances) still collide and get 46.
	const spentSignatures = createBoundedSet(MAX_REMEMBERED_IDS);
	// seller_id from the webhook -> account that owns it, so later items skip the other accounts.
	const sellerAccounts = new Map();

	// Per-request timeout left in the delivery budget.
	const requestTimeout = (deadline) => Math.max(MIN_REQUEST_TIMEOUT_MS, Math.min(REQUEST_TIMEOUT_MS, deadline - now()));

	// Without a nonce: sends with each still-valid signature minute until VCG stops rejecting the
	// signature itself. A 45/46 rejection happens before VCG acts on the request, so resending is
	// safe even for POST. The first try always goes out; later ones only while the budget allows.
	// With a nonce every call is unique, so there is nothing to fall back to: it goes out once.
	async function sendSigned(account, pathStr, extra, deadline, send) {
		let res = { data: { status_code: VCG_SIGNATURE_USED, message: 'every usable signature minute is already spent' } };
		let sent = 0;
		for (const offset of useNonce ? NONCE_MINUTE_OFFSETS : SIGNATURE_MINUTE_OFFSETS) {
			if (sent > 0 && deadline - now() < MIN_REQUEST_TIMEOUT_MS) break;
			const timestamp = minuteTimestamp(now() + offset * ONE_MINUTE_MS);
			const signatureKey = `${account.accessKey}|${pathStr}|${timestamp}`;
			if (!useNonce && spentSignatures.has(signatureKey)) continue;
			if (!useNonce) spentSignatures.add(signatureKey);
			sent += 1;
			const nonce = useNonce ? crypto.randomUUID() : '';
			res = await send(signedParams(account, pathStr, extra, timestamp, nonce), requestTimeout(deadline));
			const code = res?.data?.status_code;
			if (code !== VCG_SIGNATURE_USED && code !== VCG_TIMESTAMP_EXPIRED) return res;
			if (!useNonce) logger.warn(`[delivery] ${pathStr} [${account.name}] signature ${timestamp} rejected (${code}), trying another minute`);
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

	async function processDetail(account, item, deadline) {
		const pathStr = '/rest/transaction/process';
		const body = { delivery_data: deliveryData(item.qty) };
		try {
			await withRetry(`process ${item.id} [${account.name}]`, deadline, isRetryableWrite, async () =>
				assertVcgOk(await sendSigned(account, pathStr, { transaction_detail_id: item.id }, deadline,
					(params, timeout) => client.post(pathStr, body, { timeout, params }))));
			deliveredIds.add(item.id);
			return { id: item.id, ok: true };
		} catch (err) {
			// 44 = this account does not own the item; the caller may try another account.
			if (err.vcgCode !== VCG_NOT_FOUND) logger.error('[delivery] process failed:', item.id, err.message, err.response?.data);
			return { id: item.id, ok: false, status: err.response?.status ?? null, code: err.vcgCode ?? null, error: err.message };
		}
	}

	function accountsFor(sellerId) {
		const known = sellerAccounts.get(sellerId);
		return known ? [known, ...accounts.filter((a) => a !== known)] : accounts;
	}

	// Processes the one item a webhook is about, without looking the transaction up: one signed call
	// instead of two, which matters both for VCG's 10s timeout and for single-use signatures.
	async function runItemDelivery(trxId, item) {
		const result = { trxId, account: null, lookupFailed: false, detailIds: [item.id], skipped: [], processed: [], failed: [] };
		if (deliveredIds.has(item.id)) return { ...result, skipped: [item.id] };
		const deadline = now() + deadlineMs;
		for (const account of accountsFor(item.sellerId)) {
			const outcome = await processDetail(account, item, deadline);
			if (outcome.code === VCG_NOT_FOUND) continue;
			if (outcome.ok && item.sellerId) sellerAccounts.set(item.sellerId, account);
			return outcome.ok
				? { ...result, account: account.name, processed: [item.id] }
				: { ...result, account: account.name, failed: [outcome] };
		}
		return { ...result, detailIds: [] };
	}

	// Status-change webhooks (Dikirim, Selesai, Dibatalkan, ...) need nothing from VCG.
	function deliverItem(trxId, item) {
		if (item.status !== STATUS_NEEDS_PROCESSING) {
			return Promise.resolve({ trxId, account: null, lookupFailed: false, detailIds: [item.id], skipped: [item.id], processed: [], failed: [] });
		}
		return shareInFlight(`detail:${item.id}`, () => runItemDelivery(trxId, item));
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
		const pending = items.filter(isPending);
		const results = await mapWithConcurrency(pending, MAX_CONCURRENCY, (item) => processDetail(account, item, deadline));
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

	// Duplicate webhooks for work that is still running share the same promise.
	function shareInFlight(key, run) {
		if (inFlight.has(key)) return inFlight.get(key);
		const promise = run().finally(() => inFlight.delete(key));
		inFlight.set(key, promise);
		return promise;
	}

	// `item` (from extractWebhookItem) lets a webhook handle just its own item; without a known
	// status the whole transaction is looked up and every waiting item is processed.
	function deliverTransaction(trxId, item = null) {
		if (item && item.status !== undefined) return deliverItem(trxId, item);
		return shareInFlight(trxId, () => runDelivery(trxId));
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
module.exports = { createDelivery, extractTrxId, extractWebhookItem, toWebhookResponse, httpClient: defaultClient, ...createDelivery() };
