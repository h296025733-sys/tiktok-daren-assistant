from starlette.datastructures import Headers
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import Response


PRIVATE_NETWORK_REQUEST_HEADER = "access-control-request-private-network"
PRIVATE_NETWORK_RESPONSE_HEADER = "access-control-allow-private-network"


class PrivateNetworkCORSMiddleware(CORSMiddleware):
    """在通过常规 CORS 校验的预检上明确允许 Chrome 访问回环服务。"""

    def preflight_response(self, request_headers: Headers) -> Response:
        response = super().preflight_response(request_headers)
        private_network_requested = (
            request_headers.get(PRIVATE_NETWORK_REQUEST_HEADER, "").strip().lower()
            == "true"
        )
        if response.status_code < 400 and private_network_requested:
            response.headers[PRIVATE_NETWORK_RESPONSE_HEADER] = "true"
            response.headers.add_vary_header(
                "Access-Control-Request-Private-Network"
            )
        return response
