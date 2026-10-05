// JavaScript configuration for Seller API credentials and base URL
// NOTE: Do not expose these values on the frontend. They are used server-side only.

// Credential profiles. Pick one with VC_PROFILE (default: "default").
const PROFILES = {
	default: {
		accessKey: "LpfAISsamBMqcZBHSrzI",
		secretKey: "3452ed3b5ac6461a9d62be4ae4349eb7",
	},
	secondary: {
		accessKey: "XHYglQagyPPMsQtIYNur",
		secretKey: "15b555c7b9204d629e0f650eeeabcfc1",
	},
};

const PROFILE_NAME = process.env.VC_PROFILE || "default";
const PROFILE = PROFILES[PROFILE_NAME];
if (!PROFILE) {
	throw new Error(`Unknown VC_PROFILE "${PROFILE_NAME}". Valid: ${Object.keys(PROFILES).join(", ")}`);
}

const ACCESS_KEY = process.env.VC_ACCESS_KEY || PROFILE.accessKey;
const SECRET_KEY = process.env.VC_SECRET_KEY || PROFILE.secretKey;
const BASE_URL = process.env.VC_BASE_URL || "https://apis.vcg.my.id"; // staging default
const NGROK_STATIC_DOMAIN = process.env.NGROK_STATIC_DOMAIN || "shining-stork-briefly.ngrok-free.app";

module.exports = { ACCESS_KEY, SECRET_KEY, BASE_URL, NGROK_STATIC_DOMAIN, PROFILES, PROFILE_NAME };
