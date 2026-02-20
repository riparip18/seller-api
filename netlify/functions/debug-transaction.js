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

exports.handler = async function handler(event) {
	if (event.httpMethod !== 'GET') {
		return { statusCode: 405, body: 'Method Not Allowed' };
	}

	const trxId = event.queryStringParameters?.trx_id;
	if (!trxId) {
		return {
			statusCode: 400,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ error: 'Wajib menyertakan query param: ?trx_id=...' })
		};
	}

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

		return {
			statusCode: 200,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				debug: true,
				trxId,
				httpStatus: res.status,
				rawResponse: res.data
			}, null, 2)
		};
	} catch (err) {
		return {
			statusCode: 500,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				debug: true,
				trxId,
				error: err.message,
				apiStatus: err.response?.status,
				apiResponse: err.response?.data
			}, null, 2)
		};
	}
};
