const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { verifyWebhook, buildAuditEntry, auditKey } = require('../lib/webhook-audit');

const ACCOUNTS = [
	{ name: 'default', accessKey: 'AK1', secretKey: 'SK1' },
	{ name: 'secondary', accessKey: 'AK2', secretKey: 'SK2' },
];
// Go's json.Encoder ends the body with a newline, and VCG signs exactly those bytes.
const RAW_BODY = '{"seller_id":"s1","message_type":2,"timestamp":"2026-10-23 16:10:00","data":{"transaction_id":"t1","transaction_detail_id":"d1","status":3,"status_name":"Dikirim","qty":2,"note":"No. Meter: 123","customer_data":{"meter":"123"}}}\n';
const TIMESTAMP = '1792746600';

// What seller-backend-code src/vip/worker/listen_webhook_sender.go sends.
function vcgSignature(secret, timestamp, body) {
	return crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}

const signedHeaders = (secret) => ({ 'x-vcg-timestamp': TIMESTAMP, 'x-vcg-signature': vcgSignature(secret, TIMESTAMP, RAW_BODY) });

test('accepts the signature VCG computes and names the account whose secret signed it', () => {
	const result = verifyWebhook(signedHeaders('SK2'), RAW_BODY, ACCOUNTS);

	assert.deepStrictEqual(result, { hasHeaders: true, valid: true, account: 'secondary', timestamp: TIMESTAMP });
});

test('rejects a signature when the body was changed after signing', () => {
	const result = verifyWebhook(signedHeaders('SK1'), RAW_BODY.replace('"status":3', '"status":2'), ACCOUNTS);

	assert.strictEqual(result.valid, false);
	assert.strictEqual(result.account, null);
});

test('reports missing signature headers instead of a failed check', () => {
	const result = verifyWebhook({ 'content-type': 'application/json' }, RAW_BODY, ACCOUNTS);

	assert.deepStrictEqual(result, { hasHeaders: false, valid: null, account: null, timestamp: null });
});

test('reads the signature headers whatever their casing', () => {
	const { 'x-vcg-timestamp': ts, 'x-vcg-signature': sig } = signedHeaders('SK1');

	const result = verifyWebhook({ 'X-VCG-Timestamp': ts, 'X-Vcg-Signature': sig }, RAW_BODY, ACCOUNTS);

	assert.strictEqual(result.account, 'default');
});

test('an audit entry keeps what VCG sent and what the bot answered, without customer data', () => {
	const entry = buildAuditEntry({
		receivedAt: new Date('2026-10-23T09:10:00.123Z'),
		rawBody: RAW_BODY,
		verification: verifyWebhook(signedHeaders('SK1'), RAW_BODY, ACCOUNTS),
		response: { statusCode: 200, body: '{"status":"Transaksi sudah diproses sebelumnya","skipped":1}' },
		durationMs: 42,
	});

	assert.deepStrictEqual(entry, {
		received_at: '2026-10-23T09:10:00.123Z',
		seller_id: 's1',
		message_type: 2,
		vcg_timestamp: '2026-10-23 16:10:00',
		transaction_id: 't1',
		transaction_detail_id: 'd1',
		status: 3,
		status_name: 'Dikirim',
		qty: 2,
		signature: { hasHeaders: true, valid: true, account: 'default', timestamp: TIMESTAMP },
		response: { status: 200, body: { status: 'Transaksi sudah diproses sebelumnya', skipped: 1 } },
		duration_ms: 42,
	});
	assert.doesNotMatch(JSON.stringify(entry), /Meter|customer/);
});

test('an unparseable body is still recorded', () => {
	const entry = buildAuditEntry({
		receivedAt: new Date('2026-10-23T09:10:00.000Z'),
		rawBody: 'not json',
		verification: verifyWebhook({}, 'not json', ACCOUNTS),
		response: { statusCode: 500, body: '{"error":"Unexpected token"}' },
		durationMs: 1,
	});

	assert.strictEqual(entry.transaction_detail_id, null);
	assert.strictEqual(entry.response.status, 500);
});

test('audit keys sort by arrival time and name the detail item', () => {
	const at = (iso) => ({ received_at: iso, transaction_detail_id: 'd1' });
	const keys = [auditKey(at('2026-10-23T09:10:00.500Z')), auditKey(at('2026-10-23T09:09:59.999Z'))];

	assert.ok(keys[1] < keys[0]);
	assert.match(keys[0], /d1/);
	assert.doesNotMatch(keys[0], /[:.]/);
});
