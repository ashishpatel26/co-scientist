import sys


def main() -> None:
    """CLI: `co-scientist ask "question"` or `co-scientist serve`."""
    if len(sys.argv) >= 2 and sys.argv[1] == "serve":
        import uvicorn

        uvicorn.run("co_scientist.api:app", host="127.0.0.1", port=8000)
        return
    if len(sys.argv) < 3 or sys.argv[1] != "ask":
        print('usage: co-scientist ask "research question" | co-scientist serve')
        raise SystemExit(2)

    import uuid

    from .schemas import Session
    from .workflow import run_session

    s = run_session(Session(id=uuid.uuid4().hex[:12], question=sys.argv[2]),
                    on_update=lambda s: print(f"... {s.status} (iteration {s.iteration})", file=sys.stderr))
    print(s.model_dump_json(indent=2, exclude={"evidence"}))
