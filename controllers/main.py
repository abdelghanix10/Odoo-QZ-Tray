import os
import base64
import logging
import urllib.parse

from odoo import http
from odoo.http import request, Response
from odoo.tools.misc import file_open
from odoo.addons.point_of_sale.controllers.main import PosController

_logger = logging.getLogger(__name__)


class QZTrayController(http.Controller):
    """
    Controller for QZ Tray certificate and signing endpoints.
    """

    def _get_keys_dir(self):
        """Get the path to the keys directory."""
        module_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        return os.path.join(module_path, 'keys')

    @http.route(
        '/qz/certificate',
        type='http',
        auth='public',
        methods=['GET'],
        cors='*',
        csrf=False,
        save_session=False,
    )
    def get_certificate(self, **kwargs):
        keys_dir = self._get_keys_dir()
        cert_path = os.path.join(keys_dir, 'digital-certificate.txt')

        if not os.path.exists(cert_path):
            _logger.error("Certificate not found at %s. Please run generate_keys.py first.", cert_path)
            return Response(
                "Certificate not found. Please run generate_keys.py to create certificates.",
                status=404,
                content_type='text/plain',
            )

        try:
            with open(cert_path, 'r', encoding='utf-8') as f:
                certificate = f.read()
            return Response(certificate, content_type='text/plain')
        except Exception as e:
            _logger.error("Error reading certificate: %s", e)
            return Response(f"Error reading certificate: {e}", status=500, content_type='text/plain')

    @http.route(
        '/qz/sign',
        type='http',
        auth='public',
        methods=['GET', 'POST'],
        cors='*',
        csrf=False,
        save_session=False,
    )
    def sign_message(self, **kwargs):
        try:
            from cryptography.hazmat.primitives import hashes, serialization
            from cryptography.hazmat.primitives.asymmetric import padding
        except ImportError as e:
            _logger.error("Cryptography library not available: %s", e)
            return Response("Server error: cryptography library not installed", status=500, content_type='text/plain')

        keys_dir = self._get_keys_dir()
        key_path = os.path.join(keys_dir, 'private-key.pem')

        message = None
        if request.httprequest.method == 'POST':
            try:
                message = request.httprequest.get_data(as_text=True)
            except Exception as e:
                _logger.warning("Failed to read POST body: %s", e)

        if not message:
            message = kwargs.get('request', '')

        if not message and request.httprequest.query_string:
            query_string = request.httprequest.query_string.decode('utf-8')
            if 'request=' in query_string:
                params = urllib.parse.parse_qs(query_string)
                message = params.get('request', [''])[0]

        if not message:
            return Response("No message provided", status=400, content_type='text/plain')

        if not os.path.exists(key_path):
            _logger.error("Private key not found at %s. Please run generate_keys.py first.", key_path)
            return Response(
                "Private key not found. Please run generate_keys.py to create keys.",
                status=404,
                content_type='text/plain',
            )

        try:
            with open(key_path, 'rb') as f:
                private_key = serialization.load_pem_private_key(f.read(), password=None)

            message_bytes = message.encode('utf-8')
            signature = private_key.sign(
                message_bytes,
                padding.PKCS1v15(),
                hashes.SHA1(),
            )
            signature_b64 = base64.b64encode(signature).decode('utf-8')
            return Response(signature_b64, content_type='text/plain')
        except Exception as e:
            _logger.error("Error signing message: %s", e, exc_info=True)
            return Response(f"Error signing message: {e}", status=500, content_type='text/plain')

    @http.route('/qz/private_key', type='http', auth='user', methods=['GET'], cors='*', csrf=False)
    def get_private_key(self, **kwargs):
        try:
            from cryptography.hazmat.primitives import serialization
        except ImportError as e:
            _logger.error("Cryptography library not available: %s", e)
            return Response("Server error: cryptography library not installed", status=500, content_type='text/plain')

        keys_dir = self._get_keys_dir()
        key_path = os.path.join(keys_dir, 'private-key.pem')

        if not os.path.exists(key_path):
            _logger.error("Private key not found at %s.", key_path)
            return Response("Private key not found", status=404, content_type='text/plain')

        try:
            with open(key_path, 'rb') as f:
                private_key = serialization.load_pem_private_key(f.read(), password=None)

            pkcs8_pem = private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            )
            return Response(pkcs8_pem, content_type='text/plain')
        except Exception as e:
            _logger.error("Error reading private key: %s", e, exc_info=True)
            return Response(f"Error reading private key: {e}", status=500, content_type='text/plain')


class QZPosController(PosController):
    """
    Override PosController to serve the robust service worker from odoo_qz_print.
    """

    @http.route('/pos/service-worker.js', type='http', auth='user')
    def pos_web_service_worker(self):
        return super().pos_web_service_worker()

    def _get_pos_service_worker(self):
        with file_open('odoo_qz_print/static/src/service_worker.js', 'r') as f:
            return f.read()