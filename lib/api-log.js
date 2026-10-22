// In-memory log of API hits for the control panel (local server.js only; Netlify functions
// do not share memory). Records incoming /webhook + /api/* hits and outgoing VCG API calls.

const DEFAULT_MAX_ENTRIES = 200;
const MAX_BODY_CHARS = 2000;
const VISIBLE_TOKEN_CHARS = 4; // enough to tell accounts apart without exposing the key
const SECRET_PARAMS = new Set(['access_token', 'sign']);

function createApiLog({ max = DEFAULT_MAX_ENTRIES, now = () => new Date() } = {}) {
	let entries = [];
	let lastId = 0;
	// Ids restart with the process; the page compares epochs to notice that and reload.
	const epoch = `${now().getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	return {
		add(entry) {
			lastId += 1;
			const stored = { id: lastId, ts: now().toISOString(), ...entry };
			entries = [stored, ...entries].slice(0, max);
			return stored;
		},
		// Newest first. `since` lets the page poll only what it has not seen yet.
		list({ since = 0 } = {}) {
			return { items: entries.filter((e) => e.id > since), lastId, epoch };
		},
		clear() {
			entries = [];
		},
	};
}

function isEmpty(value) {
	if (value === undefined || value === null || value === '') return true;
	return typeof value === 'object' && Object.keys(value).length === 0;
}

// Large payloads (e.g. /rest/transaction/all) are cut so 200 entries stay cheap to poll.
function clip(value) {
	if (isEmpty(value)) return null;
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	if (text.length <= MAX_BODY_CHARS) return value;
	return `${text.slice(0, MAX_BODY_CHARS)}… (${text.length} chars)`;
}

function parseBody(data) {
	if (typeof data !== 'string') return data;
	try {
		return JSON.parse(data);
	} catch (_) {
		return data;
	}
}

function maskSecrets(params) {
	if (isEmpty(params)) return null;
	return Object.fromEntries(Object.entries(params).map(([key, value]) => {
		if (!SECRET_PARAMS.has(key)) return [key, value];
		const visible = key === 'access_token' ? String(value).slice(0, VISIBLE_TOKEN_CHARS) : '';
		return [key, `${visible}***`];
	}));
}

// Logging is a side channel: it must never fail or alter the request it observes
// (a throw inside an axios interceptor would turn a delivered /process into a "failure").
function safeAdd(apiLog, entry) {
	try {
		apiLog.add(entry);
	} catch (err) {
		console.warn('[api-log] could not record entry:', err.message);
	}
}

function fullUrl(config) {
	const url = config.url || '';
	if (/^https?:\/\//i.test(url) || !config.baseURL) return url;
	return `${config.baseURL.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

/**
 * Records every call `instance` makes to `baseUrl`; other hosts (ngrok's local API) are ignored.
 * @param {import('axios').AxiosInstance} instance
 * @param {ReturnType<typeof createApiLog>} apiLog
 * @param {{ baseUrl: string }} options
 */
function attachAxiosLogger(instance, apiLog, { baseUrl }) {
	const base = baseUrl.replace(/\/+$/, '');
	const record = (config, response, error) => {
		if (!config) return;
		const url = fullUrl(config);
		if (!url.startsWith(base)) return;
		safeAdd(apiLog, {
			direction: 'out',
			method: String(config.method || 'get').toUpperCase(),
			path: `/${url.slice(base.length).replace(/^\/+/, '')}`,
			params: maskSecrets(config.params),
			request: clip(parseBody(config.data)),
			status: response?.status ?? null,
			code: response?.data?.status_code ?? null, // VCG puts its real outcome here, even on HTTP 200
			durationMs: config.startedAt ? Date.now() - config.startedAt : null,
			response: clip(response?.data),
			error: error ? error.message : null,
		});
	};
	instance.interceptors.request.use((config) => ({ ...config, startedAt: Date.now() }));
	const recordSafely = (config, response, error) => {
		try {
			record(config, response, error);
		} catch (err) {
			console.warn('[api-log] could not record outgoing call:', err.message);
		}
	};
	instance.interceptors.response.use(
		(response) => {
			recordSafely(response.config, response, null);
			return response;
		},
		(error) => {
			recordSafely(error.config, error.response, error);
			return Promise.reject(error);
		},
	);
}

/**
 * Express middleware recording incoming hits whose path passes `shouldLog`.
 * @param {ReturnType<typeof createApiLog>} apiLog
 * @param {{ shouldLog: (path: string) => boolean }} options
 */
function requestLogger(apiLog, { shouldLog }) {
	return (req, res, next) => {
		if (!shouldLog(req.path)) return next();
		const startedAt = Date.now();
		let responseBody;
		const sendJson = res.json.bind(res);
		res.json = (body) => {
			responseBody = body;
			return sendJson(body);
		};
		// 'close' also fires when the caller gives up first (e.g. VCG timing out a slow webhook);
		// whichever comes first records the hit, once.
		let recorded = false;
		const record = () => {
			if (recorded) return;
			recorded = true;
			const finished = res.writableFinished;
			safeAdd(apiLog, {
				direction: 'in',
				method: req.method,
				path: req.originalUrl,
				params: null,
				request: clip(req.body),
				status: finished ? res.statusCode : null,
				code: null,
				durationMs: Date.now() - startedAt,
				response: clip(responseBody),
				error: finished ? null : 'Koneksi ditutup sebelum respons selesai dikirim',
			});
		};
		res.on('finish', record);
		res.on('close', record);
		return next();
	};
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostName(hostHeader) {
	try {
		return new URL(`http://${hostHeader}`).hostname;
	} catch (_) {
		return '';
	}
}

/**
 * True only for a request made directly from this machine. The ngrok tunnel also connects from
 * 127.0.0.1 but adds X-Forwarded-For; another site open in the browser sends its own Origin;
 * a DNS-rebinding page arrives with a foreign Host.
 * @param {{ socket: { remoteAddress?: string }, headers: Record<string, string | undefined> }} req
 */
function isLocalRequest(req) {
	if (!LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress)) return false;
	if (req.headers['x-forwarded-for']) return false;
	if (!LOOPBACK_HOSTS.has(hostName(req.headers.host))) return false;
	const { origin } = req.headers;
	if (!origin) return true;
	try {
		return new URL(origin).host === req.headers.host;
	} catch (_) {
		return false; // "null" origin from sandboxed frames
	}
}

module.exports = { createApiLog, attachAxiosLogger, requestLogger, isLocalRequest };
