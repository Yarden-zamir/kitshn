class KitshnError(Exception):
    """Base exception for expected KitSHn failures."""


class NoMatchingDeployment(KitshnError):
    """Raised when .kitshn.yaml has no entry for an event."""
