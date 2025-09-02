from flask import Flask, request, jsonify
import requests
from urllib.parse import urlencode
from datetime import datetime, timezone
import hmac
import hashlib
import base64

# ===== KONFIGURASI =====
ACCESS_KEY = "ulXzIoUbsIPPLptdAESv"
SECRET_KEY = "3452ed3b5ac6461a9d62be4ae4349eb7"
BASE_URL = "https://apis.vcg.my.id"

app = Flask(__name__)
processed_ids = set()

# ===== Fungsi untuk generate signature HMAC_SHA512 =====
def generate_signature(path: str):
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M")
    to_sign = f"{path}{ACCESS_KEY}{timestamp}"

    hmac_digest = hmac.new(
        key=SECRET_KEY.encode("utf-8"),
        msg=to_sign.encode("utf-8"),
        digestmod=hashlib.sha512
    ).hexdigest()

    signature = base64.b64encode(hmac_digest.encode("utf-8")).decode("utf-8")
    return signature, timestamp

# ===== Endpoint root untuk test koneksi =====
@app.route("/", methods=["GET", "POST"])
def home():
    if request.method == "POST":
        data = request.get_json(force=True)
        return jsonify({"message": "Pesanan diterima", "data": data})
    return jsonify({
        "message": "Seller API aktif", 
        "status": "ok",
        "webhook_url": "https://shining-stork-briefly.ngrok-free.app/webhook"
    })

# ===== Endpoint webhook untuk menerima transaksi dari VC Gamers =====
@app.route("/webhook", methods=["POST", "GET"])
def webhook():
    if request.method == "GET":
        return jsonify({"message": "Endpoint webhook tersedia"}), 200

    try:
        payload = request.get_json(force=True)
        if not payload:
            return jsonify({"error": "Payload kosong"}), 400

        if payload.get("message_type") == 2:
            trx_data = payload.get("data", {})
            trx_id = trx_data.get("transaction_id")

            detail_id = get_transaction_detail_id(trx_id)
            if not detail_id:
                return jsonify({"error": "transaction_detail_id tidak ditemukan"}), 404

            if detail_id in processed_ids:
                # Sudah pernah diproses, skip tanpa response
                return '', 204

            success = process_transaction(detail_id)
            if success:
                processed_ids.add(detail_id)
                return jsonify({"status": "Transaksi berhasil diproses"}), 200
            else:
                return jsonify({"error": "Gagal memproses transaksi"}), 500

        return jsonify({"status": "Diabaikan (bukan transaksi)"}), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ===== Ambil transaction_detail_id dari API =====
def get_transaction_detail_id(trx_id):
    path = "/rest/transaction/get"
    signature, timestamp = generate_signature(path)

    params = {
        "access_token": ACCESS_KEY,
        "timestamp": timestamp,
        "sign": signature,
        "transaction_id": trx_id
    }

    url = f"{BASE_URL}{path}?{urlencode(params)}"

    try:
        res = requests.get(url)
        if res.ok:
            data = res.json().get("data", {})
            items = data.get("items", [])
            if not items:
                return None
            return items[0].get("id")  # ID dari item pertama
    except:
        pass

    return None

# ===== Kirim data ke API untuk memproses transaksi =====
def process_transaction(detail_id):
    path = "/rest/transaction/process"
    signature, timestamp = generate_signature(path)

    params = {
        "access_token": ACCESS_KEY,
        "timestamp": timestamp,
        "sign": signature,
        "transaction_detail_id": detail_id
    }

    url = f"{BASE_URL}{path}?{urlencode(params)}"

    payload = {
        "delivery_data": ["Transaksi berhasil diproses"]
    }

    try:
        res = requests.post(url, json=payload)
        return res.ok
    except:
        return False

# ===== Menjalankan aplikasi tanpa ngrok integration =====
if __name__ == "__main__":
    app.run(host='0.0.0.0', port=5000, debug=False)
