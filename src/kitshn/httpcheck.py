"""One HTTP GET with the fields deploy verification needs."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import http.client
import urllib.error
import urllib.parse
import urllib.request

from .errors import KitshnError

BODY_LIMIT = 65536


@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    content_type: str
    body: str

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300


Fetch = Callable[[str], HttpResponse]


def fetch_url(url: str) -> HttpResponse:
    if urllib.parse.urlsplit(url).scheme not in {"http", "https"}:
        msg = f"URL must start with http:// or https://: {url!r}"
        raise KitshnError(msg)
    request = urllib.request.Request(url, headers={"User-Agent": "kitshn"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return HttpResponse(
                status=response.status,
                content_type=response.headers.get("Content-Type", ""),
                body=response.read(BODY_LIMIT).decode("utf-8", errors="replace"),
            )
    except urllib.error.HTTPError as error:
        return HttpResponse(
            status=error.code,
            content_type=error.headers.get("Content-Type", ""),
            body=error.read(BODY_LIMIT).decode("utf-8", errors="replace"),
        )
    except urllib.error.URLError as error:
        msg = f"{error.reason}"
        raise KitshnError(msg) from error
    except (OSError, http.client.HTTPException) as error:
        msg = f"{error.__class__.__name__}: {error}"
        raise KitshnError(msg) from error
