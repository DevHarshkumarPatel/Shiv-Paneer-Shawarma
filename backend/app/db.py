"""Google Cloud NDB client setup (emulator-aware).

In development we talk to the local Datastore emulator by setting
DATASTORE_EMULATOR_HOST before the ndb client is created. In production
leave that env var empty and rely on GOOGLE_APPLICATION_CREDENTIALS.

Every unit of work that touches NDB must run inside `client.context()`.
Use the `ndb_context` dependency in routers, or the `db_context()`
context manager in scripts (seed.py).
"""
import functools
import inspect
import os
from contextlib import contextmanager

from google.cloud import ndb

from .config import settings

# The emulator host must be present in the environment *before* the client
# is instantiated so the underlying gRPC channel points at the emulator.
if settings.datastore_emulator_host:
    os.environ["DATASTORE_EMULATOR_HOST"] = settings.datastore_emulator_host
    os.environ.setdefault("DATASTORE_PROJECT_ID", settings.gcp_project_id)
    os.environ.setdefault("GOOGLE_CLOUD_PROJECT", settings.gcp_project_id)
else:
    # In production the var may be *present but empty* (e.g. Cloud Run sets
    # DATASTORE_EMULATOR_HOST=""). Left in place, the datastore client treats
    # the empty string as an emulator target and builds a bogus ":443" host
    # (503 "host must not be empty"). Remove it so real Datastore is used.
    os.environ.pop("DATASTORE_EMULATOR_HOST", None)
    os.environ.setdefault("GOOGLE_CLOUD_PROJECT", settings.gcp_project_id)

# A single client is reused across the process; contexts are per-request.
# `database` selects a named Datastore database; None => the "(default)" one.
client = ndb.Client(
    project=settings.gcp_project_id,
    database=settings.datastore_database or None,
)


@contextmanager
def db_context():
    """Context manager for scripts and background tasks."""
    with client.context():
        yield


def with_ndb_context(fn):
    """Decorator: run a *synchronous* function inside a fresh NDB context.

    We wrap at the function level (not via a FastAPI dependency) because sync
    endpoints/deps run in a threadpool worker; a context opened in a separate
    dependency thread does not propagate. Opening it in the same call frame as
    the datastore operations is the reliable approach.
    """
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        with client.context():
            return fn(*args, **kwargs)
    return wrapper


def wrap_router_endpoints(app) -> None:
    """Wrap every sync APIRoute endpoint so it runs inside an NDB context."""
    from fastapi.routing import APIRoute

    for route in app.routes:
        if isinstance(route, APIRoute) and not inspect.iscoroutinefunction(route.endpoint):
            route.dependant.call = with_ndb_context(route.dependant.call)
