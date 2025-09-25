const { NGROK_STATIC_DOMAIN } = require('../../config');

exports.handler = async function handler(event, context) {
	try {
		const hostHeader = event.headers['x-forwarded-host'] || event.headers.host || '';
		const protoHeader = event.headers['x-forwarded-proto'] || 'https';
		const baseUrl = `${protoHeader}://${hostHeader}`;

		const data = {
			tunnel_running: true, // Always "running" on hosting to display webhook URL
			tunnel_pid: null,
			webhook_url: `${baseUrl}/webhook`,
			status_url: `${baseUrl}/`,
			last_check: new Date(),
			controls_enabled: false // Disable Start/Stop in hosting
		};

		return {
			statusCode: 200,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ success: true, data })
		};
	} catch (e) {
		return { statusCode: 500, body: JSON.stringify({ success: false, error: String(e.message || e) }) };
	}
}
