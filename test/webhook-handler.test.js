const test = require('node:test');
const assert = require('node:assert');
const { handler } = require('../netlify/functions/webhook');

// A status-change webhook needs no VCG call, so the handler runs without network.
const STATUS_CHANGE = JSON.stringify({ seller_id: 's1', message_type: 2, data: { transaction_id: 't1', transaction_detail_id: 'd1', status: 3 } });
const ANSWER = { status: 'Transaksi sudah diproses sebelumnya', skipped: 1 };

// Outside Netlify there is no Blobs context, so connectLambda throws: the answer must not change.
test('VCG gets the same answer when the audit store is unavailable', async () => {
	const res = await handler({ httpMethod: 'POST', headers: {}, body: STATUS_CHANGE, isBase64Encoded: false });

	assert.strictEqual(res.statusCode, 200);
	assert.deepStrictEqual(JSON.parse(res.body), ANSWER);
});

test('a webhook without headers or with a base64 body is still answered', async () => {
	const res = await handler({ httpMethod: 'POST', body: Buffer.from(STATUS_CHANGE).toString('base64'), isBase64Encoded: true });

	assert.strictEqual(res.statusCode, 200);
	assert.deepStrictEqual(JSON.parse(res.body), ANSWER);
});
