const { connectLambda, getStore } = require('@netlify/blobs');
const { deliverTransaction, extractTrxId, extractWebhookItem, toWebhookResponse } = require('../../lib/delivery');
const { verifyWebhook, buildAuditEntry, auditKey } = require('../../lib/webhook-audit');

const AUDIT_STORE = 'webhook-log';
// VCG waits 10s for the answer and delivery may already use ~6s of it, so recording gets little time.
const AUDIT_WRITE_TIMEOUT_MS = 500;

const json = (statusCode, body) => ({
	statusCode,
	headers: { 'content-type': 'application/json' },
	body: body ? JSON.stringify(body) : '',
});

// The exact request bytes: VCG signs those, so the signature check must not see a re-encoded string.
function bodyBytes(event) {
	if (!event.body) return Buffer.alloc(0);
	return Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
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

// Recording is a side channel: whatever fails or stalls in it, VCG gets the answer for the work
// already done. A write still running at the timeout is abandoned and may be lost.
async function recordAudit(event, { receivedAt, bytes, response }) {
	let timer;
	try {
		const verification = verifyWebhook(event.headers, bytes);
		const entry = buildAuditEntry({ receivedAt, rawBody: bytes.toString('utf8'), verification, response, durationMs: Date.now() - receivedAt.getTime() });
		connectLambda(event);
		const write = getStore(AUDIT_STORE).setJSON(auditKey(entry), entry).then(() => 'saved', (e) => `failed: ${e.message}`);
		const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timed out'), AUDIT_WRITE_TIMEOUT_MS); });
		const outcome = await Promise.race([write, timeout]);
		if (outcome !== 'saved') console.warn('[webhook] audit write', outcome, entry.transaction_detail_id);
	} catch (e) {
		console.warn('[webhook] audit failed:', e.message);
	} finally {
		clearTimeout(timer);
	}
}

exports.handler = async function handler(event) {
	const receivedAt = new Date();
	const bytes = bodyBytes(event);
	const response = await handle(event, bytes.toString('utf8'));
	if (event.httpMethod === 'POST') await recordAudit(event, { receivedAt, bytes, response });
	return response;
};
