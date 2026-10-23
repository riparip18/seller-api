const { connectLambda, getStore } = require('@netlify/blobs');
const { deliverTransaction, extractTrxId, extractWebhookItem, toWebhookResponse } = require('../../lib/delivery');
const { verifyWebhook, buildAuditEntry, auditKey } = require('../../lib/webhook-audit');

const AUDIT_STORE = 'webhook-log';
// VCG waits 10s for the answer, so recording a webhook may never hold it up for long.
const AUDIT_WRITE_TIMEOUT_MS = 1000;

const json = (statusCode, body) => ({
	statusCode,
	headers: { 'content-type': 'application/json' },
	body: body ? JSON.stringify(body) : '',
});

function rawBodyOf(event) {
	if (!event.body) return '';
	return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

async function handle(event, rawBody) {
	if (event.httpMethod === 'GET') {
		return json(200, { message: 'Endpoint webhook tersedia' });
	}

	if (event.httpMethod !== 'POST') {
		return { statusCode: 405, body: 'Method Not Allowed' };
	}

	try {
		const payload = rawBody ? JSON.parse(rawBody) : {};
		if (!payload || Object.keys(payload).length === 0) {
			return json(400, { error: 'Payload kosong' });
		}

		console.log('[webhook] incoming payload:', JSON.stringify(payload));

		if (payload.message_type === 2) {
			const trxId = extractTrxId(payload);
			if (!trxId) {
				return json(400, { error: 'transaction_id tidak ada di payload', payload_data: payload.data });
			}

			const result = await deliverTransaction(trxId, extractWebhookItem(payload));
			console.log('[webhook] trxId:', trxId, '| account:', result.account, '| processed:', result.processed, '| skipped:', result.skipped, '| failed:', result.failed.map(f => f.id));
			const { status, body } = toWebhookResponse(result);
			return json(status, body);
		}

		return json(200, { status: 'Diabaikan (bukan transaksi)', message_type: payload.message_type });
	} catch (e) {
		return json(500, { error: String(e.message || e) });
	}
}

// Recording is a side channel: a failed or slow write must not change the answer VCG gets.
async function recordAudit(event, entry) {
	let timer;
	try {
		connectLambda(event);
		const write = getStore(AUDIT_STORE).setJSON(auditKey(entry), entry);
		const timeout = new Promise((resolve) => { timer = setTimeout(resolve, AUDIT_WRITE_TIMEOUT_MS); });
		await Promise.race([write, timeout]);
	} catch (e) {
		console.warn('[webhook] audit write failed:', e.message);
	} finally {
		clearTimeout(timer);
	}
}

exports.handler = async function handler(event) {
	const receivedAt = new Date();
	const rawBody = rawBodyOf(event);
	const response = await handle(event, rawBody);
	if (event.httpMethod === 'POST') {
		const verification = verifyWebhook(event.headers, rawBody);
		const entry = buildAuditEntry({ receivedAt, rawBody, verification, response, durationMs: Date.now() - receivedAt.getTime() });
		await recordAudit(event, entry);
	}
	return response;
};
