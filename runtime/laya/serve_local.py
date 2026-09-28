"""Serve a local (fine-tuned) Laya checkpoint on the System One protocol, privately.

laya-serve only loads the published checkpoints by name, so this small server loads a local
directory with laya.Agent(path) and answers the same POST /v1/systemone request shape. It binds
127.0.0.1 only and requires the same bearer key as laya-serve (LAYA_API_KEY), and it has real
argument parsing (see F007: laya-serve --help starts an open server).

GET /health reports what is loaded, including a SHA-256 of the checkpoint's weights and config,
so the arena runner can pin exactly which fine-tune answered.

    .venv/bin/python serve_local.py --checkpoint checkpoints/pilot-imitation-enc3 --encoding 3 --port 8001
"""
import argparse, hashlib, json, os, time

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse


def sha_of(path, chunk=1 << 20):
    h = hashlib.sha256()
    for name in ("model.safetensors", "rl_agent_config.json"):
        with open(os.path.join(path, name), "rb") as f:
            while True:
                b = f.read(chunk)
                if not b:
                    break
                h.update(b)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--checkpoint", required=True, help="directory written by train_mps.py")
    ap.add_argument("--encoding", type=int, required=True, choices=[1, 2, 3], help="encoding the checkpoint was trained on")
    ap.add_argument("--port", type=int, default=8001)
    ap.add_argument("--device", default="mps")
    a = ap.parse_args()

    key = os.environ.get("LAYA_API_KEY")
    if not key:
        raise SystemExit("LAYA_API_KEY is not set: refusing to serve without a key")
    path = os.path.abspath(a.checkpoint)
    import laya  # imported after argument parsing, so --help is fast and harmless

    t0 = time.time()
    agent = laya.Agent(path, device=a.device)
    cfg = json.load(open(os.path.join(path, "rl_agent_config.json")))
    identity = {
        "status": "ok",
        "checkpoint": os.path.basename(path.rstrip("/")),
        "sha256": sha_of(path),
        "base": cfg.get("arena", {}).get("base"),
        "train_sha256": cfg.get("arena", {}).get("train_sha256"),
        "encoding": a.encoding,
        "device": a.device,
        "val_accuracy": cfg.get("arena", {}).get("metrics", {}).get("val_accuracy"),
        "loaded_in_s": round(time.time() - t0, 1),
    }
    app = FastAPI()

    def auth(authorization):
        if authorization != f"Bearer {key}":
            raise HTTPException(status_code=401, detail="unauthorized")

    @app.get("/health")
    def health(authorization: str = Header(default=None)):
        auth(authorization)
        return identity

    @app.post("/v1/systemone")
    async def systemone(request: Request, authorization: str = Header(default=None)):
        auth(authorization)
        body = await request.json()
        if not isinstance(body, dict) or "questions" not in body:
            raise HTTPException(status_code=400, detail="request body must be an object with a 'questions' field")
        t = time.perf_counter()
        try:
            result = agent.predict(body.get("state"), body["questions"])
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))
        ms = (time.perf_counter() - t) * 1000
        result["model"] = f"laya-ft/{identity['checkpoint']}@{identity['sha256'][:12]}"
        return JSONResponse(content=result, headers={"X-Inference-Time-Ms": f"{ms:.2f}"})

    print(f"serving {identity['checkpoint']} @ {identity['sha256'][:12]} on http://127.0.0.1:{a.port} (key required)", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
