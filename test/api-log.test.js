const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const axios = require('axios');
const express = require('express');
const { createApiLog, attachAxiosLogger, requestLogger, isLocalRequest } = require('../lib/api-log');

const BASE = 'https://vcg.test';

// axios instance whose adapter answers locally instead of hitting the network.
function fakeAxios(reply) {
	return axios.create({
		baseURL: BASE,
		adapter: async (config) => {
			const { status = 200, data = {}, networkError } = reply(config) || {};
			if (networkError) throw new axios.AxiosError(networkError, 'ECONNRESET', config);
			const response = { status, statusText: '', headers: {}, config, data };
			if (status >= 400) {
				throw new axios.AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE', config, null, response);
			}
			return response;
		},
	});
}

test('keeps only the newest entries, newest first', () => {
	const log = createApiLog({ max: 3 });
	for (let i = 1; i <= 5; i++) log.add({ path: `/p${i}` });

	const { items } = log.list();

	assert.deepStrictEqual(items.map((e) => e.path), ['/p5', '/p4', '/p3']);
	assert.ok(items.every((e) => typeof e.ts === 'string'));
});

test('list since returns only newer entries and reports the last id', () => {
	const log = createApiLog();
	log.add({ path: '/a' });
	const { id } = log.add({ path: '/b' });
	log.add({ path: '/c' });

	const { items, lastId } = log.list({ since: id });

	assert.deepStrictEqual(items.map((e) => e.path), ['/c']);
	assert.strictEqual(lastId, 3);
});

test('each log instance has its own epoch so the page can tell a server restart apart', () => {
	const first = createApiLog();
	const second = createApiLog();

	assert.ok(first.list().epoch);
	assert.strictEqual(first.list().epoch, first.list().epoch);
	assert.notStrictEqual(first.list().epoch, second.list().epoch);
});

test('clear empties the log without reusing ids', () => {
	const log = createApiLog();
	log.add({ path: '/a' });
	log.clear();
	const entry = log.add({ path: '/b' });

	assert.strictEqual(entry.id, 2);
	assert.deepStrictEqual(log.list().items.map((e) => e.path), ['/b']);
});

test('logs outgoing VCG calls with masked credentials', async () => {
	const log = createApiLog();
	const client = fakeAxios(() => ({ data: { data: { items: [] } } }));
	attachAxiosLogger(client, log, { baseUrl: BASE });

	await client.get('/rest/transaction/get', {
		params: { access_token: 'LpfAISsamBMqcZBHSrzI', sign: 'abc123', timestamp: '202610221100', transaction_id: 'trx-1' },
	});

	const [entry] = log.list().items;
	assert.strictEqual(entry.direction, 'out');
	assert.strictEqual(entry.method, 'GET');
	assert.strictEqual(entry.path, '/rest/transaction/get');
	assert.strictEqual(entry.status, 200);
	assert.deepStrictEqual(entry.params, { access_token: 'LpfA***', sign: '***', timestamp: '202610221100', transaction_id: 'trx-1' });
	assert.deepStrictEqual(entry.response, { data: { items: [] } });
	assert.strictEqual(entry.error, null);
	assert.ok(entry.durationMs >= 0);
});

test('records the VCG status_code so HTTP 200 rejections (e.g. 46 signature used) stand out', async () => {
	const log = createApiLog();
	const client = fakeAxios(() => ({ data: { status_code: '46', message: 'Signature already used' } }));
	attachAxiosLogger(client, log, { baseUrl: BASE });

	await client.get('/rest/transaction/get');

	const [entry] = log.list().items;
	assert.strictEqual(entry.status, 200);
	assert.strictEqual(entry.code, '46');
});

test('logs the POST body and upstream error status, and still rejects', async () => {
	const log = createApiLog();
	const client = fakeAxios(() => ({ status: 500, data: { message: 'boom' } }));
	attachAxiosLogger(client, log, { baseUrl: BASE });

	await assert.rejects(client.post('/rest/transaction/process', { delivery_data: ['x'] }), /500/);

	const [entry] = log.list().items;
	assert.strictEqual(entry.method, 'POST');
	assert.strictEqual(entry.status, 500);
	assert.deepStrictEqual(entry.request, { delivery_data: ['x'] });
	assert.deepStrictEqual(entry.response, { message: 'boom' });
	assert.match(entry.error, /500/);
});

test('logs network errors with no status', async () => {
	const log = createApiLog();
	const client = fakeAxios(() => ({ networkError: 'socket hang up' }));
	attachAxiosLogger(client, log, { baseUrl: BASE });

	await assert.rejects(client.get('/rest/balance/get'));

	const [entry] = log.list().items;
	assert.strictEqual(entry.status, null);
	assert.strictEqual(entry.error, 'socket hang up');
});

test('ignores calls outside the VCG base URL (e.g. local ngrok API)', async () => {
	const log = createApiLog();
	const client = fakeAxios(() => ({ data: { tunnels: [] } }));
	attachAxiosLogger(client, log, { baseUrl: BASE });

	await client.get('http://127.0.0.1:4040/api/tunnels');

	assert.deepStrictEqual(log.list().items, []);
});

test('keeps the leading slash when the base URL is configured with a trailing slash', async () => {
	const log = createApiLog();
	const client = fakeAxios(() => ({}));
	attachAxiosLogger(client, log, { baseUrl: `${BASE}/` });

	await client.get('/rest/balance/get');

	assert.strictEqual(log.list().items[0].path, '/rest/balance/get');
});

test('clips large bodies so the log stays small', async () => {
	const log = createApiLog();
	const client = fakeAxios(() => ({ data: { blob: 'x'.repeat(10000) } }));
	attachAxiosLogger(client, log, { baseUrl: BASE });

	await client.get('/rest/transaction/all');

	const [entry] = log.list().items;
	assert.strictEqual(typeof entry.response, 'string');
	assert.ok(entry.response.length < 2100);
	assert.match(entry.response, /\(\d+ chars\)$/);
});

test('a failing log store never changes the outcome of an outgoing call', async () => {
	const brokenLog = { add() { throw new Error('log store broken'); } };
	const ok = fakeAxios(() => ({ data: { status_code: '00' } }));
	const failing = fakeAxios(() => ({ status: 500 }));
	attachAxiosLogger(ok, brokenLog, { baseUrl: BASE });
	attachAxiosLogger(failing, brokenLog, { baseUrl: BASE });

	const res = await ok.post('/rest/transaction/process', {});

	assert.deepStrictEqual(res.data, { status_code: '00' });
	await assert.rejects(failing.get('/rest/transaction/get'), /status code 500/);
});

test('isLocalRequest allows only direct requests from a browser on this machine', () => {
	const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers: { host: 'localhost:5000', ...headers } });

	assert.strictEqual(isLocalRequest(req('127.0.0.1')), true);
	assert.strictEqual(isLocalRequest(req('::1')), true);
	assert.strictEqual(isLocalRequest(req('::ffff:127.0.0.1', { origin: 'http://localhost:5000' })), true);
	assert.strictEqual(isLocalRequest(req('192.168.1.20')), false, 'other machine on the LAN');
	assert.strictEqual(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), false, 'through the ngrok tunnel');
	assert.strictEqual(isLocalRequest(req('127.0.0.1', { origin: 'https://evil.example' })), false, 'another site in the browser');
	assert.strictEqual(isLocalRequest(req('127.0.0.1', { origin: 'null' })), false, 'sandboxed frame');
	assert.strictEqual(isLocalRequest(req('127.0.0.1', { host: 'evil.example:5000' })), false, 'DNS rebinding');
});

// Starts `app` on a free port, runs `fn(baseUrl)`, then shuts the server down.
async function withServer(app, fn) {
	const server = app.listen(0);
	await once(server, 'listening');
	try {
		return await fn(`http://127.0.0.1:${server.address().port}`);
	} finally {
		server.closeAllConnections();
		server.close();
	}
}

async function waitFor(check, timeoutMs = 2000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test('requestLogger keeps serving when the log store fails', async () => {
	const app = express();
	app.use(requestLogger({ add() { throw new Error('log store broken'); } }, { shouldLog: () => true }));
	app.get('/api/status', (req, res) => res.json({ ok: true }));

	const body = await withServer(app, async (base) => (await fetch(`${base}/api/status`)).json());

	assert.deepStrictEqual(body, { ok: true });
});

test('requestLogger records malformed JSON and requests the client gave up on', async () => {
	const log = createApiLog();
	const app = express();
	app.use(requestLogger(log, { shouldLog: () => true }));
	app.use(express.json());
	app.post('/webhook', (req, res) => res.json({ ok: true }));
	app.post('/hang', () => {}); // never answers, like a delivery stuck past the caller's timeout

	await withServer(app, async (base) => {
		await fetch(`${base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' });
		await fetch(`${base}/hang`, { method: 'POST', signal: AbortSignal.timeout(100) }).catch(() => {});
		await waitFor(() => log.list().items.length === 2);
	});

	const [hang, malformed] = log.list().items;
	assert.strictEqual(malformed.path, '/webhook');
	assert.strictEqual(malformed.status, 400);
	assert.strictEqual(hang.path, '/hang');
	assert.strictEqual(hang.status, null);
	assert.match(hang.error, /ditutup/);
});

test('requestLogger logs incoming hits with body and JSON response, skipping excluded paths', async () => {
	const log = createApiLog();
	const app = express();
	app.use(express.json());
	app.use(requestLogger(log, { shouldLog: (path) => path !== '/skip' }));
	app.post('/webhook', (req, res) => res.status(201).json({ ok: true }));
	app.get('/skip', (req, res) => res.json({}));
	const server = app.listen(0);
	await once(server, 'listening');
	const base = `http://127.0.0.1:${server.address().port}`;

	try {
		await (await fetch(`${base}/webhook?x=1`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ message_type: 2 }),
		})).json();
		await (await fetch(`${base}/skip`)).json();
		await new Promise((resolve) => setImmediate(resolve));
	} finally {
		server.closeAllConnections();
		server.close();
	}

	const { items } = log.list();
	assert.strictEqual(items.length, 1);
	const [entry] = items;
	assert.strictEqual(entry.direction, 'in');
	assert.strictEqual(entry.method, 'POST');
	assert.strictEqual(entry.path, '/webhook?x=1');
	assert.deepStrictEqual(entry.request, { message_type: 2 });
	assert.strictEqual(entry.status, 201);
	assert.deepStrictEqual(entry.response, { ok: true });
});
