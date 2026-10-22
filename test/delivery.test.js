const test = require('node:test');
const assert = require('node:assert');
const { createDelivery, extractTrxId } = require('../lib/delivery');

const noSleep = () => Promise.resolve();
const ONE = [{ name: 'default', accessKey: 'AK1', secretKey: 'SK1' }];

function httpError(status) {
	const err = new Error(`HTTP ${status}`);
	err.response = { status, data: {} };
	return err;
}

function networkError() {
	const err = new Error('ECONNRESET');
	err.code = 'ECONNRESET';
	return err;
}

// Fake axios-like client: `get`/`post` handlers are queues of response bodies or errors.
function fakeClient({ get = [], post = {} } = {}) {
	const calls = { get: 0, post: [], getTimestamps: [], postTimestamps: [] };
	return {
		calls,
		get: async (_url, { params } = {}) => {
			calls.getTimestamps.push(params?.timestamp);
			const next = get[Math.min(calls.get++, get.length - 1)];
			if (next instanceof Error) throw next;
			return { status: 200, data: next };
		},
		post: async (_url, _body, { params }) => {
			const id = params.transaction_detail_id;
			calls.post.push(id);
			calls.postTimestamps.push(params.timestamp);
			const queue = post[id] || [];
			const attempt = calls.post.filter((x) => x === id).length - 1;
			const next = queue[Math.min(attempt, queue.length - 1)];
			if (next instanceof Error) throw next;
			return { status: 200, data: next ?? {} };
		},
	};
}

// VCG answers HTTP 200 with the outcome in status_code; these bodies are what staging returned.
const SIGNATURE_USED = { status_code: '46', message: 'Signature already used' };
const TIMESTAMP_EXPIRED = { status_code: '45', message: 'expired timestamp' };
const FIXED_NOW = () => Date.UTC(2026, 9, 22, 4, 33, 30); // signature minute 202610220433

const itemsResponse = (...ids) => ({ data: { items: ids.map((id) => ({ id })) } });

test('delivers every detail item of a transaction', async () => {
	const client = fakeClient({ get: [itemsResponse('d1', 'd2', 'd3')] });
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep });

	const result = await deliverTransaction('trx-1');

	assert.deepStrictEqual(result.processed.sort(), ['d1', 'd2', 'd3']);
	assert.deepStrictEqual(result.failed, []);
});

test('retries process on connection error, 503 and 502, then succeeds', async () => {
	const client = fakeClient({
		get: [itemsResponse('d1')],
		post: { d1: [networkError(), httpError(503), httpError(502), undefined] },
	});
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep, maxAttempts: 4 });

	const result = await deliverTransaction('trx-1');

	assert.deepStrictEqual(result.processed, ['d1']);
	assert.strictEqual(client.calls.post.length, 4);
});

test('does not retry process on 4xx client errors', async () => {
	const client = fakeClient({ get: [itemsResponse('d1')], post: { d1: [httpError(400)] } });
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep });

	const result = await deliverTransaction('trx-1');

	assert.strictEqual(result.failed.length, 1);
	assert.strictEqual(result.failed[0].id, 'd1');
	assert.strictEqual(result.failed[0].status, 400);
	assert.strictEqual(client.calls.post.length, 1);
});

test('gives up after max attempts', async () => {
	const client = fakeClient({ get: [itemsResponse('d1')], post: { d1: [httpError(503)] } });
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep, maxAttempts: 3 });

	const result = await deliverTransaction('trx-1');

	assert.strictEqual(result.failed.length, 1);
	assert.strictEqual(client.calls.post.length, 3);
});

test('retries transaction lookup on transient error', async () => {
	const client = fakeClient({ get: [networkError(), itemsResponse('d1')] });
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep });

	const result = await deliverTransaction('trx-1');

	assert.deepStrictEqual(result.processed, ['d1']);
	assert.strictEqual(client.calls.get, 2);
});

test('returns empty result when transaction has no detail items', async () => {
	const client = fakeClient({ get: [{ data: { items: [] } }] });
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep });

	const result = await deliverTransaction('trx-1');

	assert.deepStrictEqual(result.detailIds, []);
});

test('skips detail ids that were already delivered', async () => {
	const client = fakeClient({ get: [itemsResponse('d1')] });
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep });

	await deliverTransaction('trx-1');
	const second = await deliverTransaction('trx-1');

	assert.deepStrictEqual(second.skipped, ['d1']);
	assert.deepStrictEqual(second.processed, []);
	assert.strictEqual(client.calls.post.length, 1);
});

test('concurrent webhooks for the same transaction share one delivery', async () => {
	const client = fakeClient({ get: [itemsResponse('d1')] });
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep });

	const [a, b] = await Promise.all([deliverTransaction('trx-1'), deliverTransaction('trx-1')]);

	assert.strictEqual(a, b);
	assert.strictEqual(client.calls.post.length, 1);
});

test('failed delivery can be retried by a later webhook', async () => {
	const client = fakeClient({ get: [itemsResponse('d1')], post: { d1: [httpError(400), undefined] } });
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep });

	const first = await deliverTransaction('trx-1');
	const second = await deliverTransaction('trx-1');

	assert.strictEqual(first.failed.length, 1);
	assert.deepStrictEqual(second.processed, ['d1']);
});

test('extractTrxId reads the supported payload shapes', () => {
	assert.strictEqual(extractTrxId({ data: { transaction_id: 'a' } }), 'a');
	assert.strictEqual(extractTrxId({ data: { trx_id: 'b' } }), 'b');
	assert.strictEqual(extractTrxId({ transaction_id: 'c' }), 'c');
	assert.strictEqual(extractTrxId({}), null);
});

test('does not retry process on timeout or 500 (request may already have been applied)', async () => {
	const timeout = new Error('timeout');
	timeout.code = 'ECONNABORTED';
	for (const err of [timeout, httpError(500)]) {
		const client = fakeClient({ get: [itemsResponse('d1')], post: { d1: [err, undefined] } });
		const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep });

		const result = await deliverTransaction('trx-1');

		assert.strictEqual(result.failed.length, 1);
		assert.strictEqual(client.calls.post.length, 1);
	}
});

test('stops retrying once the delivery deadline is spent', async () => {
	const client = fakeClient({ get: [networkError()] });
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep, deadlineMs: 0 });

	const result = await deliverTransaction('trx-1');

	assert.strictEqual(client.calls.get, 1);
	assert.strictEqual(result.lookupFailed, true);
});

test('lookup failure maps to 502 without leaking upstream error text', () => {
	const { toWebhookResponse } = require('../lib/delivery');
	const res = toWebhookResponse({ trxId: 't', lookupFailed: true, detailIds: [], processed: [], skipped: [], failed: [] });
	assert.strictEqual(res.status, 502);
	assert.deepStrictEqual(Object.keys(res.body).sort(), ['error', 'trxId']);
});

test('finds the transaction on whichever account owns it and processes with that account', async () => {
	const accounts = [
		{ name: 'default', accessKey: 'AK1', secretKey: 'SK1' },
		{ name: 'secondary', accessKey: 'AK2', secretKey: 'SK2' },
	];
	const posts = [];
	const client = {
		get: async (_url, { params }) => ({
			status: 200,
			data: params.access_token === 'AK2' ? itemsResponse('d1') : { status_code: '44', message: 'not found' },
		}),
		post: async (_url, _body, { params }) => {
			posts.push(params.access_token);
			return { status: 200, data: {} };
		},
	};
	const { deliverTransaction } = createDelivery({ accounts, client, sleep: noSleep });

	const result = await deliverTransaction('trx-1');

	assert.deepStrictEqual(result.processed, ['d1']);
	assert.strictEqual(result.account, 'secondary');
	assert.deepStrictEqual(posts, ['AK2']);
});

test('reports lookup failure when an account errors and no other account has the transaction', async () => {
	const accounts = [
		{ name: 'default', accessKey: 'AK1', secretKey: 'SK1' },
		{ name: 'secondary', accessKey: 'AK2', secretKey: 'SK2' },
	];
	const client = {
		get: async (_url, { params }) => {
			if (params.access_token === 'AK2') throw httpError(400);
			return { status: 200, data: { status_code: '44' } };
		},
		post: async () => ({ status: 200, data: {} }),
	};
	const { deliverTransaction } = createDelivery({ accounts, client, sleep: noSleep });

	const result = await deliverTransaction('trx-1');

	assert.strictEqual(result.lookupFailed, true);
});

test('only processes items still waiting to be processed (status 2); retries of sent items succeed without re-sending', async () => {
	const client = fakeClient({
		get: [{ data: { items: [{ id: 'd1', status: 2 }, { id: 'd2', status: 3 }, { id: 'd3', status: 4 }] } }],
	});
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep });
	const { toWebhookResponse } = require('../lib/delivery');

	const result = await deliverTransaction('trx-1');

	assert.deepStrictEqual(client.calls.post, ['d1']);
	assert.deepStrictEqual(result.processed, ['d1']);
	assert.deepStrictEqual(result.skipped.sort(), ['d2', 'd3']);
	assert.strictEqual(toWebhookResponse(result).status, 200);
});

test('lookup rejected with "Signature already used" retries with another minute instead of answering 404', async () => {
	const client = fakeClient({ get: [SIGNATURE_USED, itemsResponse('d1')] });
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep, now: FIXED_NOW });

	const result = await deliverTransaction('trx-1');

	assert.deepStrictEqual(result.processed, ['d1']);
	assert.deepStrictEqual(client.calls.getTimestamps, ['202610220433', '202610220432']);
});

test('expired signature timestamp also moves on to the next minute', async () => {
	const client = fakeClient({ get: [SIGNATURE_USED, TIMESTAMP_EXPIRED, itemsResponse('d1')] });
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep, now: FIXED_NOW });

	const result = await deliverTransaction('trx-1');

	assert.deepStrictEqual(result.processed, ['d1']);
	assert.deepStrictEqual(client.calls.getTimestamps, ['202610220433', '202610220432', '202610220434']);
});

test('lookup reports failure (502), not "not found" (404), when every signature minute is used', async () => {
	const client = fakeClient({ get: [SIGNATURE_USED] });
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep, now: FIXED_NOW });
	const { toWebhookResponse } = require('../lib/delivery');

	const result = await deliverTransaction('trx-1');

	// VCG accepts timestamps within ±2 minutes, so minutes M, M-1, M+1 and M+2 are usable.
	assert.deepStrictEqual(client.calls.getTimestamps, ['202610220433', '202610220432', '202610220434', '202610220435']);
	assert.strictEqual(result.lookupFailed, true);
	assert.strictEqual(toWebhookResponse(result).status, 502);
});

// Behaves like VCG since 2026-10-21: a sign (path + access key + minute) is accepted once.
function singleUseSignClient(items) {
	const used = new Set();
	const sent = [];
	const rejectReuse = (url, params) => {
		const key = `${url}|${params.access_token}|${params.timestamp}`;
		sent.push(key);
		if (used.has(key)) return { status: 200, data: SIGNATURE_USED };
		used.add(key);
		return null;
	};
	return {
		sent,
		get: async (url, { params }) => rejectReuse(url, params) || { status: 200, data: { status_code: '00', data: { items } } },
		post: async (url, _body, { params }) => rejectReuse(url, params) || { status: 200, data: { status_code: '00' } },
	};
}

test('parallel items on one account take distinct signature minutes; items beyond the usable minutes fail without a doomed request', async () => {
	const client = singleUseSignClient(['d1', 'd2', 'd3', 'd4', 'd5'].map((id) => ({ id, status: 2 })));
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep, now: FIXED_NOW });

	const result = await deliverTransaction('trx-1');

	assert.strictEqual(result.processed.length, 4);
	assert.strictEqual(result.failed.length, 1);
	assert.match(result.failed[0].error, /46/);
	assert.strictEqual(client.sent.filter((key) => key.includes('/process')).length, 4);
});

test('stops trying other signature minutes once the delivery deadline is spent', async () => {
	let clock = FIXED_NOW();
	const client = fakeClient({ get: [SIGNATURE_USED] });
	const answer = client.get;
	client.get = async (...args) => {
		clock += 4000; // each VCG round trip takes 4s
		return answer(...args);
	};
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep, now: () => clock, deadlineMs: 8000 });

	const result = await deliverTransaction('trx-1');

	assert.strictEqual(client.calls.getTimestamps.length, 2);
	assert.strictEqual(result.lookupFailed, true);
});

test('process rejected with "Signature already used" is retried with another minute', async () => {
	const client = fakeClient({ get: [itemsResponse('d1')], post: { d1: [SIGNATURE_USED, { status_code: '00', message: 'Success' }] } });
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep, now: FIXED_NOW });

	const result = await deliverTransaction('trx-1');

	assert.deepStrictEqual(result.processed, ['d1']);
	assert.deepStrictEqual(client.calls.postTimestamps, ['202610220433', '202610220432']);
});

test('process answered with a VCG error code counts as failed, not delivered, so a later webhook can deliver it', async () => {
	const client = fakeClient({ get: [itemsResponse('d1')], post: { d1: [{ status_code: '50', message: 'Gagal' }, undefined] } });
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep, now: FIXED_NOW });

	const first = await deliverTransaction('trx-1');
	const second = await deliverTransaction('trx-1');

	assert.deepStrictEqual(first.processed, []);
	assert.strictEqual(first.failed[0].id, 'd1');
	assert.match(first.failed[0].error, /50/);
	assert.deepStrictEqual(second.processed, ['d1']);
});

test('webhook retry for an already delivered transaction returns 200 without calling process', async () => {
	const client = fakeClient({ get: [{ data: { items: [{ id: 'd1', status: 3 }] } }] });
	const { deliverTransaction } = createDelivery({ accounts: ONE, client, sleep: noSleep });
	const { toWebhookResponse } = require('../lib/delivery');

	const result = await deliverTransaction('trx-1');

	assert.strictEqual(client.calls.post.length, 0);
	assert.strictEqual(toWebhookResponse(result).status, 200);
});
