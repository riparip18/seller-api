const axios = require('axios');
const { ACCESS_KEY, SECRET_KEY, BASE_URL } = require('../../config');
const crypto = require('crypto');

function generateSignature(pathStr) {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
  const toSign = `${pathStr}${ACCESS_KEY}${timestamp}`;
  const hmac = crypto.createHmac('sha512', SECRET_KEY).update(toSign, 'utf8').digest('hex');
  const signature = Buffer.from(hmac, 'utf8').toString('base64');
  return { signature, timestamp };
}

exports.handler = async function handler(event) {
  try {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    const pathStr = '/rest/product/categories';
    const { signature, timestamp } = generateSignature(pathStr);
    const url = `${BASE_URL}${pathStr}`;
    const params = { access_token: ACCESS_KEY, timestamp, sign: signature };
    const apiRes = await axios.get(url, { params });
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ success: true, data: apiRes.data?.data || [] }) };
  } catch (e) {
    return { statusCode: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ success: false, error: String(e.message || e) }) };
  }
}
