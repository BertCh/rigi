# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors

"""E4 features: frozen DINOv2 ViT-B/14 backbone from the local MoGe-2 ViT-B checkpoint (PROTOCOL section 5).

    fx = Features(); raw = fx(img_uint8 (H,W,3), cols, rows)  -> torch (rows, cols, 768) raw final-block patch tokens
Images are resized to (rows*14, cols*14) (antialiased bilinear), ImageNet-normalised. No downloads.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as Fnn

ROOT = Path(__file__).resolve().parents[4]
MAIN = Path("/Users/robertchristie/Documents/GitHub/mt-image")
for base in (ROOT, MAIN):
    p = base / "tools/research/tm/.pylib_x2"
    if p.exists():
        sys.path.insert(0, str(p))
        break
WEIGHTS = next(b for b in (ROOT, MAIN) if (b / "tools/research/tm/weights/x2/moge-2-vitb-normal/model.pt").exists()) / \
    "tools/research/tm/weights/x2/moge-2-vitb-normal/model.pt"
DEV = "mps" if torch.backends.mps.is_available() else "cpu"
MEAN = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1)
STD = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)


class Features:
    def __init__(self, dev: str = DEV):
        from moge.model.v2 import MoGeModel

        model = MoGeModel.from_pretrained(str(WEIGHTS))
        self.backbone = model.encoder.backbone.eval().to(dev)
        for p in self.backbone.parameters():
            p.requires_grad_(False)
        self.dev = dev
        self.last = len(self.backbone.blocks) - 1

    @torch.inference_mode()
    def __call__(self, img: np.ndarray, cols: int, rows: int) -> torch.Tensor:
        x = torch.from_numpy(img).permute(2, 0, 1)[None].float().div(255)
        x = Fnn.interpolate(x, (rows * 14, cols * 14), mode="bilinear", align_corners=False, antialias=True)
        x = ((x - MEAN) / STD).to(self.dev)
        tok = self.backbone.get_intermediate_layers(x, n=[self.last], norm=True)[0]  # (1, rows*cols, 768)
        return tok[0].reshape(rows, cols, -1).float().cpu()
