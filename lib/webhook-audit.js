// Webhook audit trail for QA: checks VCG's webhook signature and summarizes each hit, so what VCG
// sent and what the bot answered can be read back (/api/webhook-log) without the VCG dashboard.
const crypto = require('crypto');
const { ACCOUNTS } = require('../config');

// VCG signs hex(HMAC-SHA256(secret_key, timestamp + "." + raw body)) with the seller's API secret
// key (seller-backend-code src/vip/worker/listen_webhook_sender.go).
function webhookSignature(secretKey, timestamp, rawBody) {
	return crypto.createHmac('sha256', secretKey).update(`${timestamp}.`).update(rawBody ?? '').digest('hex');
}

function header(headers, name) {
	const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === name);
	return key ? headers[key] : null;
}

function sameText(a, b) {
	const left = Buffer.from(String(a));
	const right = Buffer.from(String(b));
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Returns which account's secret produced the signature; valid is null when VCG sent no signature.
// rawBody may be a string or the exact request bytes.
function verifyWebhook(headers, rawBody, accounts = ACCOUNTS) {
	const timestamp = header(headers, 'x-vcg-timestamp');
	const signature = header(headers, 'x-vcg-signature');
	if (!timestamp || !signature) return { hasHeaders: false, valid: null, account: null, timestamp: null };
	const expected = String(signature).toLowerCase();
	const signer = accounts.find((a) => a.secretKey && sameText(webhookSignature(a.secretKey, timestamp, rawBody), expected));
	return { hasHeaders: true, valid: Boolean(signer), account: signer?.name ?? null, timestamp };
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch (_) {
		return null;
	}
}

const MAX_ERROR_CHARS = 200;

const clipText = (value) => (typeof value === 'string' && value.length > MAX_ERROR_CHARS ? `${value.slice(0, MAX_ERROR_CHARS)}…` : value);

// Only the bot's own outcome fields: a 400 answer echoes payload.data (customer data) back to VCG,
// and that must not reach the log.
function summarizeResponse(response) {
	const body = parseJson(response.body);
	if (!body || typeof body !== 'object') return { status: response.statusCode, body: null };
	const failed = Array.isArray(body.failed)
		? body.failed.map((f) => ({ id: f?.id ?? null, code: f?.code ?? null, error: clipText(f?.error ?? null) }))
		: undefined;
	const kept = {
		status: body.status,
		error: clipText(body.error),
		processed: body.processed,
		skipped: body.skipped,
		trxId: body.trxId,
		failed,
		message_type: body.message_type,
	};
	return { status: response.statusCode, body: Object.fromEntries(Object.entries(kept).filter(([, v]) => v !== undefined)) };
}

// Keeps the transaction fields QA checks; customer_data and notes (meter numbers, game ids) are left out.
function buildAuditEntry({ receivedAt, rawBody, verification, response, durationMs }) {
	const payload = parseJson(rawBody) || {};
	const data = payload.data || {};
	return {
		received_at: receivedAt.toISOString(),
		seller_id: payload.seller_id ?? null,
		message_type: payload.message_type ?? null,
		vcg_timestamp: payload.timestamp ?? null,
		transaction_id: data.transaction_id ?? null,
		transaction_detail_id: data.transaction_detail_id ?? null,
		status: data.status ?? null,
		status_name: data.status_name ?? null,
		qty: data.qty ?? null,
		signature: verification,
		response: summarizeResponse(response),
		duration_ms: durationMs,
	};
}

// Keys are grouped per UTC day so the log reader lists only recent days, not the whole store.
function auditDayPrefix(date) {
	return `${date.toISOString().slice(0, 10)}/`;
}

// Within a day keys sort by arrival time; the detail id lets the log be filtered per order item.
function auditKey(entry) {
	const time = entry.received_at.slice(11).replace(/[:.]/g, '-');
	const day = auditDayPrefix(new Date(entry.received_at));
	return `${day}${time}_${entry.transaction_detail_id ?? 'none'}_${crypto.randomBytes(3).toString('hex')}`;
}

module.exports = { verifyWebhook, buildAuditEntry, auditKey, auditDayPrefix };
