"""sRGB <-> linear and the app's haze (src/lib/materials.ts: out_lin = mix(base_lin, toLinear(hazeLin), min(f, .85)),
f = 1 - exp(-range * uHazeDensity * uHaze), uHazeDensity 1.8e-5, uHaze 0.6 for the cached renders (FORMAT.md),
hazeLin = THREE.Color(0xb9cde0) (sRGB->linear) then toLinear = pow 2.2 again, output encoded sRGB)."""
import numpy as np

def s2l(x):
    x = np.asarray(x, np.float32) / 255.0
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4).astype(np.float32)

def l2s(x):
    x = np.clip(x, 0, 1)
    y = np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)
    return np.clip(np.round(y * 255), 0, 255).astype(np.uint8)

HAZE_LIN = s2l(np.array([0xb9, 0xcd, 0xe0])) ** 2.2
HAZE_K = 1.8e-5 * 0.6
HAZE_MAX = 0.85

def app_haze_f(d):
    return np.clip(1 - np.exp(-np.nan_to_num(d, nan=0.0) * HAZE_K), 0, HAZE_MAX)

def remove_app_haze(rgb, d):
    f = app_haze_f(d)[..., None]
    return np.clip((s2l(rgb) - HAZE_LIN * f) / (1 - f), 0, 1)

def add_app_haze(lin, d):
    f = app_haze_f(d)[..., None]
    return lin * (1 - f) + HAZE_LIN * f

def lum(lin):
    return lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722
