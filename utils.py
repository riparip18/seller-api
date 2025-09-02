import hmac
import hashlib
import base64
from datetime import datetime

from config import ACCESS_KEY, SECRET_KEY

def generate_signature(path):
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M")
    message = f"{path}{ACCESS_KEY}{timestamp}"
    digest = hmac.new(SECRET_KEY.encode(), msg=message.encode(), digestmod=hashlib.sha512).digest()
    signature = base64.b64encode(digest).decode()
    return signature, timestamp
