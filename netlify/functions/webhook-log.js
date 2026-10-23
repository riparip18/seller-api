// Read back the webhook audit trail written by webhook.js, newest first.
// GET /api/webhook-log?limit=50&days=2&detail=<transaction_detail_id>
const { connectLambda, getStore } = require('@netlify/blobs');
const { auditDayPrefix } = require('../../lib/webhook-audit');

const AUDIT_STORE = 'webhook-log';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// Only recent UTC days are listed, so reading stays cheap however large the store grows.
const DEFAULT_DAYS = 2;
const MAX_DAYS = 7;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const json = (statusCode, body) => ({
	statusCode,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body, null, 2),
});

function boundedInt(value, fallback, max) {
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

exports.handler = async function handler(event) {
	if (event.httpMethod !== 'GET') {
		return { statusCode: 405, body: 'Method Not Allowed' };
	}

	const query = event.queryStringParameters || {};
	const limit = boundedInt(query.limit, DEFAULT_LIMIT, MAX_LIMIT);
	const days = boundedInt(query.days, DEFAULT_DAYS, MAX_DAYS);

	try {
		connectLambda(event);
		const store = getStore(AUDIT_STORE);
		const prefixes = Array.from({ length: days }, (_, i) => auditDayPrefix(new Date(Date.now() - i * ONE_DAY_MS)));
		const listed = await Promise.all(prefixes.map((prefix) => store.list({ prefix })));
		const keys = listed
			.flatMap(({ blobs }) => blobs.map((blob) => blob.key))
			.filter((key) => !query.detail || key.includes(query.detail))
			.sort()
			.reverse()
			.slice(0, limit);
		const entries = await Promise.all(keys.map((key) => store.get(key, { type: 'json' })));
		return json(200, { count: entries.length, days, entries: entries.filter(Boolean) });
	} catch (e) {
		return json(500, { error: String(e.message || e) });
	}
};
