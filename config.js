// JavaScript configuration for Seller API credentials and base URL
// NOTE: Do not expose these values on the frontend. They are used server-side only.


const ACCESS_KEY = process.env.VC_ACCESS_KEY || "ulXzIoUbsIPPLptdAESv";
const SECRET_KEY = process.env.VC_SECRET_KEY || "3452ed3b5ac6461a9d62be4ae4349eb7";
const BASE_URL = process.env.VC_BASE_URL || "https://apis.vcg.my.id"; // staging default
const NGROK_STATIC_DOMAIN = process.env.NGROK_STATIC_DOMAIN || "shining-stork-briefly.ngrok-free.app";

module.exports = { ACCESS_KEY, SECRET_KEY, BASE_URL, NGROK_STATIC_DOMAIN };


