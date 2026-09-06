import os
import base64
import logging

from odoo import http
from odoo.http import request, Response
from odoo.tools import file_open
from odoo.addons.point_of_sale.controllers.main import PosController

_logger = logging.getLogger(__name__)


class QZTrayController(http.Controller):
    """
    Controller for QZ Tray certificate and signing endpoints.
    
    These endpoints are called by the QZ Tray JavaScript library:
    - /qz/certificate: Returns the public certificate for verification
    - /qz/sign: Signs a message using the private key for authentication
    """
    
    def _get_keys_dir(self):
        """Get the path to the keys directory."""
        module_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        return os.path.join(module_path, 'keys')
    
    @http.route('/qz/certificate', type='http', auth='public', methods=['GET'], cors='*', csrf=False)
    def get_certificate(self, **kwargs):
        """
        Return the public certificate for QZ Tray authentication.
        
        QZ Tray uses this certificate to verify that signed messages
        come from a trusted source.
        """
        keys_dir = self._get_keys_dir()
        cert_path = os.path.join(keys_dir, 'digital-certificate.txt')
        
        _logger.info(f"QZ Certificate requested. Looking for certificate at: {cert_path}")
        
        if not os.path.exists(cert_path):
            _logger.error(f"Certificate not found at {cert_path}. Please run generate_keys.py first.")
            return Response(
                "Certificate not found. Please run generate_keys.py to create certificates.",
                status=404,
                content_type='text/plain'
            )
        
        try:
            with open(cert_path, 'r') as f:
                certificate = f.read()
            _logger.info("Certificate loaded successfully")
            return Response(certificate, content_type='text/plain')
        except Exception as e:
            _logger.error(f"Error reading certificate: {e}")
            return Response(f"Error reading certificate: {e}", status=500, content_type='text/plain')
    
    @http.route('/qz/sign', type='http', auth='public', methods=['GET', 'POST'], cors='*', csrf=False)
    def sign_message(self, **kwargs):
        """
        Sign a message with the private key for QZ Tray authentication.
        
        QZ Tray sends a string (typically a timestamp) that needs to be signed
        with our private key. The signature proves we own the certificate.
        
        The message can come via:
        - GET parameter: ?request=<message>
        - POST body: The raw request body
        """
        try:
            from cryptography.hazmat.primitives import hashes, serialization
            from cryptography.hazmat.primitives.asymmetric import padding
            from cryptography.hazmat.backends import default_backend
        except ImportError as e:
            _logger.error(f"Cryptography library not available: {e}")
            return Response("Server error: cryptography library not installed", status=500, content_type='text/plain')
        
        keys_dir = self._get_keys_dir()
        key_path = os.path.join(keys_dir, 'private-key.pem')
        
        # Get the message to sign - check multiple sources
        message = None
        
        # Try POST body first
        if request.httprequest.method == 'POST':
            try:
                message = request.httprequest.get_data(as_text=True)
                _logger.info(f"Got message from POST body: '{message[:100] if message else 'empty'}...'")
            except Exception as e:
                _logger.warning(f"Failed to read POST body: {e}")
        
        # Fall back to GET parameter
        if not message:
            message = kwargs.get('request', '')
            if message:
                _logger.info(f"Got message from GET parameter: '{message[:100]}...'")
        
        # Also check the raw query string for 'request' param
        if not message and request.httprequest.query_string:
            query_string = request.httprequest.query_string.decode('utf-8')
            _logger.info(f"Query string: {query_string}")
            if 'request=' in query_string:
                # Extract the request parameter value
                import urllib.parse
                params = urllib.parse.parse_qs(query_string)
                message = params.get('request', [''])[0]
                _logger.info(f"Got message from query string parsing: '{message[:100] if message else 'empty'}...'")
        
        if not message:
            _logger.warning("No message provided for signing")
            _logger.warning(f"Method: {request.httprequest.method}")
            _logger.warning(f"Content-Type: {request.httprequest.content_type}")
            _logger.warning(f"kwargs: {kwargs}")
            return Response("No message provided", status=400, content_type='text/plain')
        
        if not os.path.exists(key_path):
            _logger.error(f"Private key not found at {key_path}. Please run generate_keys.py first.")
            return Response(
                "Private key not found. Please run generate_keys.py to create keys.",
                status=404,
                content_type='text/plain'
            )
        
        try:
            # Load the private key
            with open(key_path, 'rb') as f:
                key_data = f.read()
                private_key = serialization.load_pem_private_key(
                    key_data,
                    password=None,
                    backend=default_backend()
                )
            
            # Sign the message using SHA1 with PKCS1v15 padding (QZ Tray default)
            # Note: QZ Tray 2.2.x defaults to SHA1 algorithm
            # The message must be encoded as UTF-8 bytes
            message_bytes = message.encode('utf-8')
            _logger.info(f"Signing message of {len(message_bytes)} bytes with SHA1")
            
            signature = private_key.sign(
                message_bytes,
                padding.PKCS1v15(),
                hashes.SHA1()  # QZ Tray 2.2.x default algorithm
            )
            
            # Return the signature as base64
            signature_b64 = base64.b64encode(signature).decode('utf-8')
            _logger.info(f"Message signed successfully, signature length: {len(signature_b64)}")
            return Response(signature_b64, content_type='text/plain')
            
        except Exception as e:
            _logger.error(f"Error signing message: {e}", exc_info=True)
            return Response(f"Error signing message: {e}", status=500, content_type='text/plain')

    @http.route('/qz/private_key', type='http', auth='user', methods=['GET'], cors='*', csrf=False)
    def get_private_key(self, **kwargs):
        """
        Return the private key for local client-side signing.
        This is restricted to authenticated users.
        """
        try:
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.backends import default_backend
        except ImportError as e:
            _logger.error(f"Cryptography library not available: {e}")
            return Response("Server error: cryptography library not installed", status=500, content_type='text/plain')

        keys_dir = self._get_keys_dir()
        key_path = os.path.join(keys_dir, 'private-key.pem')

        if not os.path.exists(key_path):
            _logger.error(f"Private key not found at {key_path}.")
            return Response("Private key not found", status=404, content_type='text/plain')

        try:
            with open(key_path, 'rb') as f:
                key_data = f.read()
                private_key = serialization.load_pem_private_key(
                    key_data,
                    password=None,
                    backend=default_backend()
                )
            
            # Serialize the key to PKCS#8 PEM format dynamically
            pkcs8_pem = private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption()
            )
            _logger.info("Private key loaded and serialized to PKCS#8 successfully")
            return Response(pkcs8_pem, content_type='text/plain')
        except Exception as e:
            _logger.error(f"Error reading private key: {e}", exc_info=True)
            return Response(f"Error reading private key: {e}", status=500, content_type='text/plain')


class QZPosController(PosController):
    """
    Override PosController to serve the robust service worker from odoo_qz_print,
    preventing Service Worker Promise rejection errors on network issues.
    """

    @http.route('/pos/service-worker.js', type='http', auth='user')
    def pos_web_service_worker(self):
        return super().pos_web_service_worker()

    def _get_pos_service_worker(self):
        with file_open('odoo_qz_print/static/src/service_worker.js') as f:
            return f.read()



