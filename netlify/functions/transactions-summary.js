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
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const pathStr = '/rest/transaction/all';
    const { signature, timestamp } = generateSignature(pathStr);
    const url = `${BASE_URL}${pathStr}`;

    const qs = event.queryStringParameters || {};
    const { date_start, date_end, status, limit = 100 } = qs;

    const baseParams = { access_token: ACCESS_KEY, timestamp, sign: signature, limit };
    if (date_start) baseParams.date_start = date_start;
    if (date_end) baseParams.date_end = date_end;
    if (status) baseParams.status = status;

    let pendapatanTotal = 0;
    let potonganTotal = 0;
    let nextCursor;

    for (let i = 0; i < 10; i++) {
      const params = nextCursor ? { ...baseParams, next_cursor: nextCursor } : baseParams;
      const apiRes = await axios.get(url, { params });
      const payload = apiRes.data?.data || {};
      const items = payload.items || [];
      for (const item of items) {
        const income = Number(item?.amount) || 0;
        const fee = Number(item?.fee || item?.platform_fee || item?.service_fee || 0);
        pendapatanTotal += income;
        potonganTotal += fee;
      }
      nextCursor = payload.next_cursor;
      if (!nextCursor) break;
    }

    const labaBersih = pendapatanTotal - potonganTotal;

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ success: true, data: { pendapatan: pendapatanTotal, potongan: potonganTotal, laba_bersih: labaBersih } })
    };
  } catch (e) {
    return { statusCode: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ success: false, error: String(e.message || e) }) };
  }
}


