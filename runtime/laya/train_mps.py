"""Fine-tune Laya on an arena dataset, locally on Apple silicon (MPS).

An adaptation of Laya's official recipe (notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb,
github.com/NandhaKishorM/laya), which is CUDA-only (2 x T4, DDP/nccl, fp16 autocast + GradScaler).
Here: one process, one device (mps, or cpu), fp32 by default, optional bf16 autocast. The
objective is the notebook's: the RLCD policy gradient with a proper scoring reward, plus a soft
cross-entropy term. Temperatures are fitted on items held out before training.

Also measures base Laya's accuracy on the validation set before training, for a before/after.

    .venv/bin/python train_mps.py --data data/pilot --out checkpoints/pilot \
        --epochs 2 --micro-batch 8 --grad-accum 4
"""
import argparse, json, math, os, random, time, hashlib
import numpy as np
import torch
from safetensors.torch import load_file, save_file
from transformers import AutoTokenizer
from laya.agent import _fix_tokenizer_config
from laya.common import build_model, build_sequence, proper_reward, QTYPES, ece_score

BASE = os.path.expanduser(
    "~/.cache/huggingface/hub/models--convaiinnovations--laya/snapshots/55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851")


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def load_items(path, tok, cfg, limit=None):
    items, dropped = [], 0
    with open(path) as f:
        for line in f:
            r = json.loads(line)
            q = r["question"]
            ids, markers = build_sequence(tok, r["state"], {"t": "choice", "ins": q["instructions"], "crit": q["criteria"]},
                                          cfg["max_len"], cfg["head_max_len"])
            if len(markers) != len(r["keys"]):
                dropped += 1  # an option fell outside the token budget
                continue
            t = r["target"]
            items.append({"ids": ids, "markers": markers, "qtype": QTYPES["choice"], "target": t,
                          "label": int(np.argmax(t)), "kind": r["kind"], "id": r["id"]})
            if limit and len(items) >= limit:
                break
    return items, dropped


def collate(items, pad_id):
    n, L = len(items), max(len(it["ids"]) for it in items)
    kmax = max(len(it["markers"]) for it in items)
    ids = torch.full((n, L), pad_id, dtype=torch.long)
    att = torch.zeros((n, L), dtype=torch.long)
    mpos = torch.zeros((n, kmax), dtype=torch.long)
    mmask = torch.zeros((n, kmax), dtype=torch.bool)
    target = torch.zeros((n, kmax), dtype=torch.float32)
    for i, it in enumerate(items):
        ids[i, :len(it["ids"])] = torch.tensor(it["ids"])
        att[i, :len(it["ids"])] = 1
        k = len(it["markers"])
        mpos[i, :k] = torch.tensor(it["markers"])
        mmask[i, :k] = True
        target[i, :k] = torch.tensor(it["target"], dtype=torch.float32)
    return {"input_ids": ids, "attention_mask": att, "marker_pos": mpos, "marker_mask": mmask, "target": target,
            "qtype": torch.tensor([it["qtype"] for it in items]), "label": torch.tensor([it["label"] for it in items])}


def forward(model, b, device, amp):
    ctx = torch.autocast(device.type, dtype=torch.bfloat16) if amp else torch.autocast(device.type, enabled=False)
    with ctx:
        logits, act = model(b["input_ids"].to(device), b["attention_mask"].to(device), b["marker_pos"].to(device),
                            b["marker_mask"].to(device), b["qtype"].to(device))
    return logits.float(), act


@torch.no_grad()
def evaluate(model, items, pad_id, device, amp, batch=16):
    """Accuracy against the labels, and raw logits for calibration."""
    model.eval()
    correct, out = 0, []
    for i in range(0, len(items), batch):
        chunk = items[i:i + batch]
        b = collate(chunk, pad_id)
        logits, _ = forward(model, b, device, amp)
        z = logits.cpu().numpy()
        for r, it in enumerate(chunk):
            k = len(it["markers"])
            zz = z[r, :k]
            correct += int(np.argmax(zz) == it["label"])
            out.append((zz, it["target"]))
    model.train()
    return correct / max(1, len(items)), out


def fit_one_temp(sel):
    """The notebook's per-type temperature fit (LBFGS on held-out logits)."""
    if len(sel) < 10:
        return 1.0
    kmax = max(len(z) for z, _ in sel)
    Z = torch.full((len(sel), kmax), -1e4)
    T = torch.zeros((len(sel), kmax))
    for i, (z, t) in enumerate(sel):
        Z[i, :len(z)] = torch.tensor(z)
        T[i, :len(t)] = torch.tensor(t, dtype=torch.float32)
    log_t = torch.zeros(1, requires_grad=True)
    opt = torch.optim.LBFGS([log_t], lr=0.1, max_iter=100)

    def closure():
        opt.zero_grad()
        loss = -(T * torch.log_softmax(Z / log_t.exp(), -1)).sum(-1).mean()
        loss.backward()
        return loss
    opt.step(closure)
    return float(torch.clamp(log_t.exp(), 0.5, 5.0).item())  # laya clamps to [0.5, 5] at load


def ece_of(pairs, temp=1.0):
    conf, corr = [], []
    for z, t in pairs:
        p = np.exp((z - z.max()) / temp)
        p /= p.sum()
        conf.append(p.max())
        corr.append(float(np.argmax(p) == int(np.argmax(t))))
    return float(ece_score(np.array(conf), np.array(corr)))


def mem_gb(device):
    if device.type == "mps":
        return torch.mps.driver_allocated_memory() / 1e9
    return float("nan")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--base", default=BASE)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--micro-batch", type=int, default=8)
    ap.add_argument("--grad-accum", type=int, default=4)
    ap.add_argument("--lr-encoder", type=float, default=2.5e-5)
    ap.add_argument("--lr-head", type=float, default=1.0e-4)
    ap.add_argument("--bf16", action="store_true", help="bf16 autocast (default fp32)")
    ap.add_argument("--no-checkpointing", action="store_true")
    ap.add_argument("--limit", type=int, default=None, help="use at most this many training items")
    ap.add_argument("--max-steps", type=int, default=None, help="stop after this many micro-batches (smoke test)")
    ap.add_argument("--skip-base-eval", action="store_true")
    ap.add_argument("--device", default="mps" if torch.backends.mps.is_available() else "cpu")
    ap.add_argument("--seed", type=int, default=20260927)
    a = ap.parse_args()

    random.seed(a.seed); np.random.seed(a.seed); torch.manual_seed(a.seed)
    device = torch.device(a.device)
    _fix_tokenizer_config(a.base)
    tok = AutoTokenizer.from_pretrained(os.path.join(a.base, "tokenizer"))
    with open(os.path.join(a.base, "rl_agent_config.json")) as f:
        cfg = json.load(f)
    log(f"device {device} · torch {torch.__version__} · base {a.base.split('/')[-1][:7]} · max_len {cfg['max_len']} head_max_len {cfg['head_max_len']}")

    t0 = time.time()
    train_all, drop_tr = load_items(os.path.join(a.data, "train.jsonl"), tok, cfg, a.limit)
    val, drop_va = load_items(os.path.join(a.data, "val.jsonl"), tok, cfg)
    lens = [len(it["ids"]) for it in train_all]
    log(f"tokenized {len(train_all)} train / {len(val)} val items in {time.time() - t0:.1f}s · dropped {drop_tr}/{drop_va} over budget · tokens p50 {int(np.median(lens))} max {max(lens)}")

    # Calibration slice held out before training (as the notebook does).
    order = list(range(len(train_all)))
    random.Random(20260922).shuffle(order)
    n_cal = min(400, len(train_all) // 10)
    calib = [train_all[i] for i in sorted(order[:n_cal])]
    train = [train_all[i] for i in sorted(order[n_cal:])]

    model = build_model(cfg, encoder_dir=os.path.join(a.base, "encoder"))
    model.load_state_dict(load_file(os.path.join(a.base, "model.safetensors")), strict=True)
    model = model.float()
    if not a.no_checkpointing:
        model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        model.head_checkpointing = True
    model.to(device)
    model.train()
    log(f"model loaded · {sum(p.numel() for p in model.parameters()) / 1e6:.0f}M params · memory {mem_gb(device):.1f} GB")

    metrics = {"device": str(device), "torch": torch.__version__, "bf16": a.bf16, "checkpointing": not a.no_checkpointing,
               "train_items": len(train), "calib_items": len(calib), "val_items": len(val),
               "micro_batch": a.micro_batch, "grad_accum": a.grad_accum, "epochs": a.epochs}
    if not a.skip_base_eval:
        t1 = time.time()
        acc0, _ = evaluate(model, val, tok.pad_token_id, device, a.bf16)
        metrics["base_val_accuracy"] = acc0
        log(f"BASE Laya: val accuracy vs labels {acc0:.3f} ({time.time() - t1:.1f}s)")

    enc_p = [p for n, p in model.named_parameters() if n.startswith("encoder.")]
    head_p = [p for n, p in model.named_parameters() if not n.startswith("encoder.")]
    opt = torch.optim.AdamW([{"params": enc_p, "lr": a.lr_encoder}, {"params": head_p, "lr": a.lr_head}], weight_decay=0.01)
    total_updates = max(1, (len(train) // (a.micro_batch * a.grad_accum)) * a.epochs)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=total_updates, eta_min=1e-6)
    GROUP, S0, S1 = 4, 0.4, 0.1
    step, peak = 0, 0.0
    metrics["epochs_log"] = []
    t_train = time.time()
    for epoch in range(a.epochs):
        random.Random(42 + epoch).shuffle(train)
        sigma = S0 + (S1 - S0) * (epoch / max(1, a.epochs - 1))
        opt.zero_grad(set_to_none=True)
        te, tot, nb = time.time(), 0.0, 0
        for bi in range(0, len(train), a.micro_batch):
            chunk = train[bi:bi + a.micro_batch]
            b = collate(chunk, tok.pad_token_id)
            logits, act = forward(model, b, device, a.bf16)
            mask = b["marker_mask"].to(device)
            k = mask.sum(-1, keepdim=True).float()
            target = b["target"].to(device)
            eps = torch.randn((GROUP,) + logits.shape, device=device) * sigma * mask
            eps = (eps - eps.sum(-1, keepdim=True) / k) * mask
            z = logits.detach().unsqueeze(0) + eps
            q = torch.softmax(z.masked_fill(~mask, -1e4), -1)
            with torch.no_grad():
                r = proper_reward(q, target.unsqueeze(0), b["qtype"].to(device), mask, w_sph=0.75, w_rps=1.0)
                adv = (r - r.mean(0, keepdim=True)) / (r.std() + 1e-6)
            logp = -(((z - logits.unsqueeze(0)) ** 2) * mask).sum(-1) / (2 * sigma ** 2)
            loss_rl = -(adv * logp).mean()
            loss_ce = -(target * torch.log_softmax(logits.masked_fill(~mask, -1e4), -1)).sum(-1).mean()
            loss = (loss_rl + loss_ce) / a.grad_accum + 0.0 * act.sum()
            loss.backward()
            nb += 1
            tot += loss.item() * a.grad_accum
            if nb % a.grad_accum == 0 or bi + a.micro_batch >= len(train):
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                opt.step()
                sched.step()
                opt.zero_grad(set_to_none=True)
            step += 1
            peak = max(peak, mem_gb(device))
            if nb % 50 == 0:
                done = (bi + a.micro_batch) / len(train)
                rate = (bi + a.micro_batch) / (time.time() - te)
                log(f"  epoch {epoch + 1}/{a.epochs} · {done * 100:.0f}% · loss {tot / nb:.4f} · reward {r.mean().item():.3f} · {rate:.1f} items/s · memory {mem_gb(device):.1f} GB")
            if a.max_steps and step >= a.max_steps:
                break
        acc, _ = evaluate(model, val, tok.pad_token_id, device, a.bf16)
        ep = {"epoch": epoch + 1, "loss": tot / max(1, nb), "val_accuracy": acc, "seconds": time.time() - te, "items_per_s": (nb * a.micro_batch) / (time.time() - te)}
        metrics["epochs_log"].append(ep)
        log(f"=== epoch {epoch + 1} · loss {ep['loss']:.4f} · val accuracy {acc:.3f} · {ep['seconds']:.0f}s ({ep['items_per_s']:.1f} items/s)")
        if a.max_steps and step >= a.max_steps:
            break
    metrics["train_seconds"] = time.time() - t_train
    metrics["peak_memory_gb"] = peak

    # Calibration on the held-out slice, then the same on validation for ECE before/after.
    _, cal = evaluate(model, calib, tok.pad_token_id, device, a.bf16)
    temp = fit_one_temp(cal)
    acc, val_pairs = evaluate(model, val, tok.pad_token_id, device, a.bf16)
    metrics.update({"val_accuracy": acc, "temperature_choice": temp, "val_ece_t1": ece_of(val_pairs, 1.0), "val_ece_fitted": ece_of(val_pairs, temp)})
    log(f"final val accuracy {acc:.3f} · temperature {temp:.3f} · ECE {metrics['val_ece_t1']:.3f} → {metrics['val_ece_fitted']:.3f}")

    # Save in the layout laya.Agent(path) loads.
    os.makedirs(a.out, exist_ok=True)
    sd = {k: v.half().contiguous().cpu() for k, v in model.state_dict().items()}
    save_file(sd, os.path.join(a.out, "model.safetensors"))
    model.encoder.config.save_pretrained(os.path.join(a.out, "encoder"))
    tok.save_pretrained(os.path.join(a.out, "tokenizer"))
    base_t = cfg.get("temperature", [1.0, 1.0, 1.0])
    cfg.update({"fine_tuned": True, "model_name": "laya-arena-" + os.path.basename(a.out.rstrip("/")),
                "temperature": [temp, base_t[1], base_t[2]]})
    cfg.pop("temperature_by_options", None)  # the per-type fit replaces the shipped buckets (F008)
    data_hash = hashlib.sha256(open(os.path.join(a.data, "train.jsonl"), "rb").read()).hexdigest()[:12]
    cfg["arena"] = {"dataset": a.data, "train_sha256": data_hash, "base": "convaiinnovations/laya@55cf4c4", "metrics": metrics}
    with open(os.path.join(a.out, "rl_agent_config.json"), "w") as f:
        json.dump(cfg, f, indent=2)
    with open(os.path.join(a.out, "metrics.json"), "w") as f:
        json.dump(metrics, f, indent=2)
    log(f"saved to {a.out}")


if __name__ == "__main__":
    main()
