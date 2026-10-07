"""plur1bus-memory-client: the PLUR1BUS core RPC for host adapters (stdlib only, D88).

Modules import each other relatively only, so the package also works vendored under another
package (``plur1bus/_vendor/plur1bus_memory_client``, HM2-R4).
"""

from ._schema import METHODS, RPC_VERSION, SCHEMA_SHA256
from .client import (
    RECALL_QUERY_MAX_CHARS,
    RETRYABLE_METHODS,
    RPC_MAJOR,
    RPC_MIN_MINOR,
    Caller,
    MemoryClient,
)
from .paths import core_address, core_pid_path, core_token_path, default_home, is_absolute_home, run_dir
from .trust import UntrustedEndpoint, is_trust_refusal
from .protocol import (
    CLIENT_ERROR_CODES,
    MAX_LINE,
    TRANSPORT_CODES,
    RpcError,
    Stream,
    decode_line,
    encode_request,
    parse_rpc_version,
    read_response,
    result_of,
)

__version__ = "0.1.0"

__all__ = [
    "CLIENT_ERROR_CODES",
    "Caller",
    "MAX_LINE",
    "METHODS",
    "MemoryClient",
    "RECALL_QUERY_MAX_CHARS",
    "RETRYABLE_METHODS",
    "RPC_MAJOR",
    "RPC_MIN_MINOR",
    "RPC_VERSION",
    "RpcError",
    "SCHEMA_SHA256",
    "Stream",
    "TRANSPORT_CODES",
    "UntrustedEndpoint",
    "__version__",
    "core_address",
    "core_pid_path",
    "core_token_path",
    "decode_line",
    "default_home",
    "encode_request",
    "is_absolute_home",
    "is_trust_refusal",
    "parse_rpc_version",
    "read_response",
    "result_of",
    "run_dir",
]
