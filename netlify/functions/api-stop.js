exports.handler = async function handler(event) {
	if (event.httpMethod !== 'POST') {
		return { statusCode: 405, body: 'Method Not Allowed' };
	}
	return {
		statusCode: 403,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ success: false, message: 'Controls disabled in production' })
	};
}
