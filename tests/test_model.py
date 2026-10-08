import numpy as np

from backend.model import MODEL_GSD, postprocess, preprocess


def test_preprocess_resamples_to_model_gsd_and_pads():
    rgb = np.zeros((100, 150, 3), np.uint8)
    x, (h, w) = preprocess(rgb, gsd_m=MODEL_GSD / 2)  # finer image -> halved
    assert (h, w) == (50, 75)
    assert x.shape == (1, 3, 64, 96)  # padded to multiples of 32
    assert x.dtype == np.float32


def test_postprocess_crops_and_restores_size():
    logits = np.zeros((1, 3, 64, 96), np.float32)
    logits[0, 2, :50, :75] = 1.0  # class 2 in the valid area
    mask = postprocess(logits, (50, 75), (100, 150))
    assert mask.shape == (100, 150)
    assert (mask == 2).all()
