const { deliverTransaction, extractTrxId, toWebhookResponse } = require('../../lib/delivery');

const json = (statusCode, body) => ({
	statusCode,
	headers: { 'content-type': 'application/json' },
	body: body ? JSON.stringify(body) : '',
});

exports.handler = async function handler(event) {
	if (event.httpMethod === 'GET') {
		return json(200, { message: 'Endpoint webhook tersedia' });
	}

	if (event.httpMethod !== 'POST') {
		return { statusCode: 405, body: 'Method Not Allowed' };
	}

	try {
		const payload = event.body ? JSON.parse(event.body) : {};
		if (!payload || Object.keys(payload).length === 0) {
			return json(400, { error: 'Payload kosong' });
		}

		console.log('[webhook] incoming payload:', JSON.stringify(payload));

		if (payload.message_type === 2) {
			const trxId = extractTrxId(payload);
			if (!trxId) {
				return json(400, { error: 'transaction_id tidak ada di payload', payload_data: payload.data });
			}

			const result = await deliverTransaction(trxId);
			console.log('[webhook] trxId:', trxId, '| account:', result.account, '| processed:', result.processed, '| skipped:', result.skipped, '| failed:', result.failed.map(f => f.id));
			const { status, body } = toWebhookResponse(result);
			return json(status, body);
		}

		return json(200, { status: 'Diabaikan (bukan transaksi)', message_type: payload.message_type });
	} catch (e) {
		return json(500, { error: String(e.message || e) });
	}
}
