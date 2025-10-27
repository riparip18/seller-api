const crypto = require('crypto');
const axios = require('axios');
const { ACCESS_KEY, SECRET_KEY, BASE_URL } = require('../../config');

function generateSignature(pathStr) {
	const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
	const toSign = `${pathStr}${ACCESS_KEY}${timestamp}`;
	const hmac = crypto.createHmac('sha512', SECRET_KEY).update(toSign, 'utf8').digest('hex');
	const signature = Buffer.from(hmac, 'utf8').toString('base64');
	return { signature, timestamp };
}

async function getTransactionDetailIds(trxId) {
	const pathStr = '/rest/transaction/get';
	const { signature, timestamp } = generateSignature(pathStr);
	const url = `${BASE_URL}${pathStr}`;
	try {
		const res = await axios.get(url, {
			params: {
				access_token: ACCESS_KEY,
				timestamp,
				sign: signature,
				transaction_id: trxId
			}
		});
		const items = res.data?.data?.items || [];
		return items.map((it) => it?.id).filter(Boolean);
	} catch (_) {
		return [];
	}
}

async function processTransaction(detailId) {
	const pathStr = '/rest/transaction/process';
	const { signature, timestamp } = generateSignature(pathStr);
	const url = `${BASE_URL}${pathStr}`;
	try {
		const res = await axios.post(url, { delivery_data: ['Transaksi berhasil diproses'] }, {
			params: {
				access_token: ACCESS_KEY,
				timestamp,
				sign: signature,
				transaction_detail_id: detailId
			}
		});
		return res.status >= 200 && res.status < 300;
	} catch (_) {
		return false;
	}
}

exports.handler = async function handler(event) {
	if (event.httpMethod === 'GET') {
		return {
			statusCode: 200,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ message: 'Endpoint webhook tersedia' })
		};
	}

	if (event.httpMethod !== 'POST') {
		return { statusCode: 405, body: 'Method Not Allowed' };
	}

	try {
		const payload = event.body ? JSON.parse(event.body) : {};
		if (!payload || Object.keys(payload).length === 0) {
			return { statusCode: 400, body: JSON.stringify({ error: 'Payload kosong' }) };
		}
		if (payload.message_type === 2) {
			const trxId = payload.data?.transaction_id;
			const detailIds = await getTransactionDetailIds(trxId);
			if (!detailIds || detailIds.length === 0) return { statusCode: 404, body: JSON.stringify({ error: 'transaction_detail_id tidak ditemukan' }) };
			let failed = 0;
			for (const id of detailIds) {
				const ok = await processTransaction(id);
				if (!ok) failed++;
			}
			if (failed === 0) return { statusCode: 200, body: JSON.stringify({ status: 'Semua transaksi berhasil diproses', processed: detailIds.length }) };
			return { statusCode: 500, body: JSON.stringify({ error: 'Sebagian transaksi gagal diproses', processed: detailIds.length - failed, failed }) };
		}
		return { statusCode: 200, body: JSON.stringify({ status: 'Diabaikan (bukan transaksi)' }) };
	} catch (e) {
		return { statusCode: 500, body: JSON.stringify({ error: String(e.message || e) }) };
	}
}
