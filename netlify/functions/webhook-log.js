// Read back the webhook audit trail written by webhook.js, newest first.
// GET /api/webhook-log?limit=50&detail=<transaction_detail_id>
const { connectLambda, getStore } = require('@netlify/blobs');

const AUDIT_STORE = 'webhook-log';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const json = (statusCode, body) => ({
	statusCode,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body, null, 2),
});

exports.handler = async function handler(event) {
	if (event.httpMethod !== 'GET') {
		return { statusCode: 405, body: 'Method Not Allowed' };
	}

	const query = event.queryStringParameters || {};
	const requested = Number.parseInt(query.limit, 10);
	const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;

	try {
		connectLambda(event);
		const store = getStore(AUDIT_STORE);
		const { blobs } = await store.list();
		const keys = blobs
			.map((blob) => blob.key)
			.filter((key) => !query.detail || key.includes(query.detail))
			.sort()
			.reverse()
			.slice(0, limit);
		const entries = await Promise.all(keys.map((key) => store.get(key, { type: 'json' })));
		return json(200, { count: entries.length, total: blobs.length, entries });
	} catch (e) {
		return json(500, { error: String(e.message || e) });
	}
};
