"""Shared panoptic-quality (PQ) metric for the parity scripts."""
import numpy as np


def pq(gt, pred):
    gt_ids = np.unique(gt); gt_ids = gt_ids[gt_ids > 0]
    pr_ids = np.unique(pred); pr_ids = pr_ids[pr_ids > 0]
    if len(gt_ids) == 0 and len(pr_ids) == 0: return 1.0
    m = (gt > 0) | (pred > 0)
    pairs, counts = np.unique(np.stack([gt[m], pred[m]]), axis=1, return_counts=True)
    ga = dict(zip(*np.unique(gt[gt > 0], return_counts=True)))
    pa = dict(zip(*np.unique(pred[pred > 0], return_counts=True)))
    ious = []; matched_g = set(); matched_p = set()
    for (g, p), inter in zip(pairs.T, counts):
        if g == 0 or p == 0: continue
        iou = inter / (ga[g] + pa[p] - inter)
        if iou > 0.5: ious.append(iou); matched_g.add(g); matched_p.add(p)
    tp = len(ious); fp = len(pr_ids) - len(matched_p); fn = len(gt_ids) - len(matched_g)
    return float(sum(ious) / (tp + 0.5 * fp + 0.5 * fn)) if (tp + fp + fn) else 1.0
