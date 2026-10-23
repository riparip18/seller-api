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
function verifyWebhook(headers, rawBody, accounts = ACCOUNTS) {
	const timestamp = header(headers, 'x-vcg-timestamp');
	const signature = header(headers, 'x-vcg-signature');
	if (!timestamp || !signature) return { hasHeaders: false, valid: null, account: null, timestamp: null };
	const signer = accounts.find((a) => sameText(webhookSignature(a.secretKey, timestamp, rawBody), signature));
	return { hasHeaders: true, valid: Boolean(signer), account: signer?.name ?? null, timestamp };
}

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch (_) {
		return null;
	}
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
		response: { status: response.statusCode, body: parseJson(response.body) ?? response.body ?? null },
		duration_ms: durationMs,
	};
}

// Keys sort by arrival time; the detail id lets the log be filtered per order item.
function auditKey(entry) {
	const time = entry.received_at.replace(/[:.]/g, '-');
	return `${time}_${entry.transaction_detail_id ?? 'none'}_${crypto.randomBytes(3).toString('hex')}`;
}

module.exports = { verifyWebhook, buildAuditEntry, auditKey };
