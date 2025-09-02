import subprocess
import sys
import os
import time
import signal
from pathlib import Path

class SellerAPIService:
    def __init__(self):
        self.app_process = None
        self.ngrok_process = None
        self.running = True
        
    def start_ngrok(self):
        """Start ngrok with config file"""
        try:
            config_path = Path(__file__).parent / "ngrok.yml"
            cmd = f'ngrok start seller-api --config "{config_path}"'
            
            self.ngrok_process = subprocess.Popen(
                cmd, 
                shell=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            )
            print("✅ Ngrok started")
            return True
        except Exception as e:
            print(f"❌ Failed to start ngrok: {e}")
            return False
    
    def start_app(self):
        """Start Flask app without ngrok integration"""
        try:
            app_path = Path(__file__).parent / "app_service.py"
            
            self.app_process = subprocess.Popen(
                [sys.executable, str(app_path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            )
            print("✅ Flask app started")
            return True
        except Exception as e:
            print(f"❌ Failed to start Flask app: {e}")
            return False
    
    def cleanup(self):
        """Clean up processes"""
        try:
            if self.app_process:
                self.app_process.terminate()
                self.app_process.wait(timeout=5)
                print("✅ Flask app stopped")
        except:
            pass
            
        try:
            if self.ngrok_process:
                self.ngrok_process.terminate()
                self.ngrok_process.wait(timeout=5)
                print("✅ Ngrok stopped")
        except:
            pass
            
        # Force kill if needed
        try:
            if os.name == 'nt':
                subprocess.run(['taskkill', '/F', '/IM', 'python.exe'], 
                             capture_output=True, check=False)
                subprocess.run(['taskkill', '/F', '/IM', 'ngrok.exe'], 
                             capture_output=True, check=False)
        except:
            pass
    
    def signal_handler(self, signum, frame):
        """Handle shutdown signals"""
        print("\n🛑 Shutting down service...")
        self.running = False
        self.cleanup()
        sys.exit(0)
    
    def run(self):
        """Main service loop"""
        # Setup signal handlers
        signal.signal(signal.SIGINT, self.signal_handler)
        signal.signal(signal.SIGTERM, self.signal_handler)
        
        print("🚀 Starting Seller API Service...")
        
        # Cleanup any existing processes
        self.cleanup()
        time.sleep(2)
        
        # Start services
        if not self.start_ngrok():
            print("❌ Failed to start ngrok")
            return
            
        time.sleep(3)  # Wait for ngrok to establish tunnel
        
        if not self.start_app():
            print("❌ Failed to start Flask app")
            self.cleanup()
            return
        
        print("✅ Seller API Service is running!")
        print("📡 Webhook URL: https://shining-stork-briefly.ngrok-free.app/webhook")
        print("🔗 Status URL: https://shining-stork-briefly.ngrok-free.app/")
        print("Press Ctrl+C to stop...")
        
        # Keep service running
        try:
            while self.running:
                # Check if processes are still alive
                if self.app_process and self.app_process.poll() is not None:
                    print("❌ Flask app died, restarting...")
                    self.start_app()
                
                if self.ngrok_process and self.ngrok_process.poll() is not None:
                    print("❌ Ngrok died, restarting...")
                    self.start_ngrok()
                    time.sleep(3)
                
                time.sleep(10)  # Check every 10 seconds
                
        except KeyboardInterrupt:
            self.signal_handler(signal.SIGINT, None)

if __name__ == "__main__":
    service = SellerAPIService()
    service.run()
