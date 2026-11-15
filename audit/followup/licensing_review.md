# Workstream B: Licensing Review of Converted ONNX Weights (Audit F-24)

**Status:** Complete (all upstream sources directly verified)  
**Confidence:** Verified (license texts, repository contents, and Zenodo/Hugging Face metadata inspected directly; see §6 for verification commands)  
**Disclaimer:** *This document is a technical and license-text analysis prepared as part of a pre-release engineering audit. It is not formal legal advice. Items requiring a maintainer or legal decision are explicitly flagged in §4.*

---

## 1. Executive Summary

Redistributing the converted ONNX weights (`ig2_unet_fp32.onnx` and `ig2_cpsam_fp16.onnx`) on Hugging Face (`inYourOwnBrowser/imagegrains-2.0-onnx`, pinned revision `7773328a544ac050b7820667e68cbfb02a2e954a`) under **CC BY 4.0** is **permitted and compatible** with every upstream license in the dependency chain:

| Component | Upstream Source | Verified License | Key Obligations |
| :--- | :--- | :--- | :--- |
| ImageGrains 2.0 pretrained weights | Zenodo [`10.5281/zenodo.15728186`](https://zenodo.org/records/15728186) | **CC BY 4.0** | Attribution, license link, indication of changes |
| ImageGrains 2.0 training/inference code | [`dmair1989/imagegrains`](https://github.com/dmair1989/imagegrains) | **BSD 3-Clause** (NOT GPL-3.0) | Retain copyright, conditions, disclaimer; no endorsement |
| Cellpose & Cellpose-SAM | [`MouseLand/cellpose`](https://github.com/MouseLand/cellpose) & [`mouseland/cellpose-sam`](https://huggingface.co/mouseland/cellpose-sam) | **BSD 3-Clause** *(note: training data is CC-BY-NC)* | Retain HHMI copyright, conditions, disclaimer; no endorsement |
| Segment Anything (SAM) ViT-L encoder | [`facebookresearch/segment-anything`](https://github.com/facebookresearch/segment-anything) | **Apache License 2.0** (no `NOTICE` file) | §4(a) license copy, §4(b) statement of changes, §4(c) Meta copyright; §4(d) N/A |
| ONNX Runtime Web (bundled in `dist/`) | [`microsoft/onnxruntime`](https://github.com/microsoft/onnxruntime) | **MIT License** | Retain Microsoft copyright & MIT notice (already present) |

**However, the current documentation has compliance and factual gaps** in both `THIRD_PARTY_NOTICES.md` (in `LukeAFullard/webGrainy`) and `README.md` on Hugging Face (`inYourOwnBrowser/imagegrains-2.0-onnx` at `7773328a544ac050b7820667e68cbfb02a2e954a`). Proposed drop-in replacements are provided in:
- `audit/followup/THIRD_PARTY_NOTICES_PROPOSED.md`
- `audit/followup/HF_MODEL_CARD_PROPOSED.md`

---

## 2. Verified Upstream License Citations

### 2.1 ImageGrains 2.0 Pretrained Weights (Zenodo)
- **Record:** `https://zenodo.org/records/15728186` (API: `https://zenodo.org/api/records/15728186`), DOI: `10.5281/zenodo.15728186`
- **Title:** `"ImageGrains 2.0 models"` (`publication_date`: `"2025-06-24"`, `modified`: `"2026-07-14T08:37:48.573258+00:00"`)
- **License (verbatim metadata):** `{"id": "cc-by-4.0"}` (`access_right`: `"open"`), Creative Commons Attribution 4.0 International (`https://creativecommons.org/licenses/by/4.0/`).
- **Creators (15):** Mair, David; Witz, Guillaume; do Prado, Ariel; Garefalakis, Philippos; Wild, Amanda Lily; Ville, Fanny; Schuster, Bennet; Horn, Michael; Österle, Jürgen; Fabbri, Stefano Claudio; Litty, Camille; Achleitner, Stefan; Leistner, Sebastian; Hiller, Clemens; Schlunegger, Fritz.
- **Files (6):** Includes `IG2_full_set.200525` (`26,557,120` B) and `IG2_full_set_cp_SAM` (`1,218,643,463` B), which are the direct upstream PyTorch checkpoints for `ig2_unet_fp32.onnx` and `ig2_cpsam_fp16.onnx`.

### 2.2 ImageGrains Code (`dmair1989/imagegrains`)
- **License file:** `https://raw.githubusercontent.com/dmair1989/imagegrains/main/LICENSE.md` (note: `LICENSE` without `.md` returns HTTP 404).
- **Verbatim header:**
  ```text
  BSD 3-Clause License

  Copyright (c) 2023, David Mair
  ```
- **Package metadata:** `https://raw.githubusercontent.com/dmair1989/imagegrains/main/pyproject.toml`
  - `license = { text = "BSD 3-Clause License" }`
  - `authors = [{ email = "david.mair@unibe.ch", name = "David Mair, Guillaume Witz" }]`
  - `dependencies = ["cellpose >= 4.0.9, < 4.3.0", ...]`

### 2.3 Cellpose & Cellpose-SAM (`MouseLand/cellpose` & `mouseland/cellpose-sam`)
- **License file:** `https://raw.githubusercontent.com/MouseLand/cellpose/main/LICENSE`
- **Verbatim header:**
  ```text
  Copyright © 2020 Howard Hughes Medical Institute
  ```
  Followed by the standard **BSD 3-Clause License** text.
- **SAM ViT wrapper (`cellpose/vit.py`, lines 1–6):** `https://raw.githubusercontent.com/MouseLand/cellpose/main/cellpose/vit.py`
  ```python
  """
  Copyright © 2025 Howard Hughes Medical Institute, Authored by Carsen Stringer and Marius Pachitariu.
  """
  ...
  from segment_anything import sam_model_registry
  ```
- **Hugging Face model card (`mouseland/cellpose-sam`):** `https://huggingface.co/api/models/mouseland/cellpose-sam`
  - `cardData`: `{'license': 'bsd-3-clause'}`
  - `tags`: `['license:bsd-3-clause', 'region:us']`
- **Training-data note (`MouseLand/cellpose/README.md`, line 37):**
  > `All Cellpose models are trained on data that is licensed under **CC-BY-NC**. The Cellpose annotated dataset is also CC-BY-NC.`
  *(Note: `README.md` line 11 also contains a stale shields.io badge `[![Licence: GPL v3](...)](.../LICENSE)` pointing to the BSD-3 `LICENSE` file.)*

### 2.4 Segment Anything (`facebookresearch/segment-anything`)
- **Repository root contents:** `https://api.github.com/repos/facebookresearch/segment-anything/contents/`
  - Root files: `.flake8`, `.gitignore`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `LICENSE`, `README.md`, `assets`, `demo`, `linter.sh`, `notebooks`, `scripts`, `segment_anything`, `setup.cfg`, `setup.py`.
  - **Confirmed: there is NO `NOTICE` file** in the repository root.
- **License file:** `https://raw.githubusercontent.com/facebookresearch/segment-anything/main/LICENSE`
  - **Apache License, Version 2.0, January 2004** (`http://www.apache.org/licenses/`).
- **Source copyright header (`segment_anything/modeling/image_encoder.py`, lines 1–5):**
  ```python
  # Copyright (c) Meta Platforms, Inc. and affiliates.
  # All rights reserved.
  ```

### 2.5 Hugging Face Distribution (`inYourOwnBrowser/imagegrains-2.0-onnx`)
- **Pinned revision in `webGrainy` (`src/modules/modelCache.ts:16-34`):**
  - `MODEL_REVISION = '7773328a544ac050b7820667e68cbfb02a2e954a'`
  - `ig2_unet_fp32.onnx`: `sha256: 5e692c5593ac15e614b77602e1d4f8c2f84dd939f4386b1f7e5641dbcd62053c`, `sizeBytes: 26489665` (`25.3 MiB` / `26.5 MB`)
  - `ig2_cpsam_fp16.onnx`: `sha256: 944a114a0cb1a3a215c11affefe7211caac6da2b74895c496d5a7b5a23b6230d`, `sizeBytes: 617364567` (`588.8 MiB` / `617.4 MB`)
- **Errors & gaps in `README.md` at `7773328a544ac050b7820667e68cbfb02a2e954a`:**
  1. **Wrong upstream software license:** Claims `Upstream imagegrains Software: GNU General Public License v3.0 (GPL-3.0)` with a broken 404 link `https://github.com/dmair1989/imagegrains/blob/main/LICENSE`. Actual license is **BSD 3-Clause** at `LICENSE.md`.
  2. **Missing Apache-2.0 compliance:** No copy or text of Apache-2.0 (§4(a)), no `Copyright (c) Meta Platforms, Inc. and affiliates.` notice (§4(c)), and no explicit modification notice in the License section (§4(b)).
  3. **Missing HHMI BSD-3 notice:** Lists `BSD-3-Clause` link only; omits `Copyright © 2020–2025 Howard Hughes Medical Institute` and BSD-3 disclaimer/no-endorsement notice.
  4. **Size typo:** States `≈ 588 MB` instead of `588.8 MiB (617.4 MB)` (and `25.3 MB` instead of `25.3 MiB (26.5 MB)`).
  5. **Citation omissions:** Omits Mair et al. (2026) ImageGrains 2.0 (`10.5194/esurf-14-527-2026`), Pachitariu et al. (2025) Cellpose-SAM (`10.1101/2025.04.28.651001`), Kirillov et al. (2023) SAM (`10.1109/ICCV51070.2023.00371` / `arXiv:2304.02643`), and truncates the 15 Zenodo creators to 4 in `@dataset{Mair2025ImageGrains2Weights}`.

### 2.6 Local `THIRD_PARTY_NOTICES.md` (`LukeAFullard/webGrainy`)
- **Lines 15–40:** Correctly includes `onnxruntime-web` / `onnxruntime-common` MIT License and Microsoft `ThirdPartyNotices.txt` link.
- **Lines 44–59:**
  - Row 2 says *"See the Zenodo record and the upstream repository"* instead of **CC BY 4.0** (Zenodo) and **BSD 3-Clause** (`dmair1989/imagegrains`).
  - Lines 56–59 retain the stale audit placeholder: *"The audit could not reach the upstream ImageGrains repository to confirm its license terms for the weights..."* (F-24).
  - Omits Meta's copyright notice, confirmation that `facebookresearch/segment-anything` has no `NOTICE` file, and a copy/full text of Apache-2.0 (§4(a)).
  - Omits HHMI's copyright notice and the Cellpose `CC-BY-NC` training-data note.
  - Gives only a brief one-line summary of ONNX conversion changes rather than the concrete per-model Statement of Changes.

---

## 3. License Compatibility Analysis

### 3.1 Apache-2.0 §4(a)–(d) & Final Paragraph (SAM ViT-L -> Cellpose-SAM -> ImageGrains 2.0 -> `ig2_cpsam_fp16.onnx`)
`ig2_cpsam_fp16.onnx` is a derivative work incorporating weights from SAM's ViT-L image encoder (`facebookresearch/segment-anything`, Apache-2.0). Apache-2.0 Section 4 permits redistribution of Derivative Works in Object/binary form under the following conditions:
- **§4(a):** *"You must give any other recipients of the Work or Derivative Works a copy of this License;"*  
  **Action:** Include the full Apache-2.0 license text (or a bundled `LICENSE-APACHE-2.0.txt` / full text section in `THIRD_PARTY_NOTICES.md` and on the HF model card).
- **§4(b):** *"You must cause any modified files to carry prominent notices stating that You changed the files;"*  
  **Action:** Provide an explicit, prominent Statement of Changes in both the HF model card and `THIRD_PARTY_NOTICES.md` detailing the fine-tuning lineage (SAM ViT-L → Cellpose-SAM → ImageGrains 2.0 `IG2_full_set_cp_SAM`) and the PyTorch → native FP16 ONNX opset 18 Dynamo conversion.
- **§4(c):** *"You must retain, in the Source form of any Derivative Works that You distribute, all copyright, patent, trademark, and attribution notices from the Source form of the Work..."*  
  **Action:** Retain `Copyright (c) Meta Platforms, Inc. and affiliates.` in documentation/notices.
- **§4(d):** *"If the Work includes a 'NOTICE' text file as part of its distribution, then any Derivative Works that You distribute must include a readable copy of the attribution notices contained within such NOTICE file..."*  
  **Status:** **Not applicable** — verified directly via GitHub API that `facebookresearch/segment-anything` has **no `NOTICE` file**. Document this explicitly so future audits do not flag it as missing.
- **§4 Final Paragraph:** *"You may add Your own copyright statement to Your modifications and may provide additional or different license terms and conditions for use, reproduction, or distribution of Your modifications, or for any such Derivative Works as a whole, provided Your use, reproduction, and distribution of the Work otherwise complies with the conditions stated in this License."*  
  **Conclusion:** Licensing the derivative `ig2_cpsam_fp16.onnx` artifact as a whole under **CC BY 4.0** is explicitly permitted by Apache-2.0 §4, provided §4(a)–(c) are satisfied.

### 3.2 BSD 3-Clause (ImageGrains & Cellpose / HHMI)
Both `dmair1989/imagegrains` (`Copyright (c) 2023, David Mair`) and `MouseLand/cellpose` (`Copyright © 2020–2025 Howard Hughes Medical Institute`) use the permissive BSD 3-Clause License:
- **§1–§2:** Redistributing in binary/model form requires reproducing the copyright notice, list of conditions, and disclaimer in documentation/accompanying materials.
- **§3:** Prohibits using the copyright holders' names or contributors for endorsement without prior written permission.
- **Compatibility:** BSD 3-Clause imposes no copyleft or share-alike restriction and is fully compatible with redistributing the derived ONNX weights under CC BY 4.0.

### 3.3 CC BY 4.0 (Zenodo `10.5281/zenodo.15728186`)
CC BY 4.0 permits copying, redistributing, and adapting (including format conversion to ONNX FP32/FP16) for any purpose, provided:
1. Appropriate credit is given (Mair et al., Zenodo `10.5281/zenodo.15728186`),
2. A link to the CC BY 4.0 license (`https://creativecommons.org/licenses/by/4.0/`) is provided, and
3. An indication of changes made is included.

### 3.4 Overall Compatibility Verdict
- **`ig2_unet_fp32.onnx`:** Zenodo (CC BY 4.0) + ImageGrains (BSD-3) + Cellpose (BSD-3) → **CC BY 4.0 redistribution is permitted and compatible.**
- **`ig2_cpsam_fp16.onnx`:** Zenodo (CC BY 4.0) + ImageGrains (BSD-3) + Cellpose-SAM (BSD-3) + SAM ViT-L (Apache-2.0, no `NOTICE`) → **CC BY 4.0 redistribution is permitted and compatible**, subject to satisfying Apache-2.0 §4(a)–(c) and BSD-3 attribution/disclaimer requirements.

---

## 4. Recommendations & Human-Decision Flags

### 4.1 Specific Changes Needed
1. **Replace `THIRD_PARTY_NOTICES.md` in `LukeAFullard/webGrainy`** using `audit/followup/THIRD_PARTY_NOTICES_PROPOSED.md`:
   - Remove the stale F-24 "could not reach upstream" paragraph.
   - Record verified licenses: Zenodo `10.5281/zenodo.15728186` (**CC BY 4.0**), `dmair1989/imagegrains` (**BSD 3-Clause**), Cellpose/HHMI (**BSD 3-Clause** + `CC-BY-NC` training-data note), SAM (**Apache-2.0**, no `NOTICE` file).
   - Include the full Apache-2.0 license text (satisfying §4(a) even in offline bundles) and a detailed per-model Statement of Changes (§4(b) & CC BY 4.0).
2. **Update `README.md` (and optionally add `LICENSE-APACHE-2.0.txt`) on Hugging Face (`inYourOwnBrowser/imagegrains-2.0-onnx`)** using `audit/followup/HF_MODEL_CARD_PROPOSED.md`:
   - Fix `GPL-3.0` → **BSD 3-Clause** (`LICENSE.md`).
   - Add Meta Apache-2.0 copyright/license text & Statement of Changes, plus HHMI BSD-3 copyright/disclaimer.
   - Fix `≈ 588 MB` → `588.8 MiB (617.4 MB)` and `25.3 MB` → `25.3 MiB (26.5 MB)`.
   - Add 2026/2025/2023 citations and full 15-author Zenodo BibTeX.
3. **Optional `webGrainy` UI/docs polish (if desired under a later release):**
   - `src/modules/provenance.ts` / `src/ui/modals.ts`: optionally note `Weights: CC BY 4.0 (doi:10.5281/zenodo.15728186)` in `CITATION_NOTICE` / "About & Citations" modal.

### 4.2 Flags Requiring a Human / Maintainer Decision
1. **Cellpose `CC-BY-NC` training data note:** `MouseLand/cellpose/README.md` (line 37) states that Cellpose's own training dataset is `CC-BY-NC`, even though HHMI licenses `MouseLand/cellpose` and `mouseland/cellpose-sam` weights under `bsd-3-clause` and Mair et al. license the fine-tuned ImageGrains 2.0 weights on Zenodo under `cc-by-4.0`. Maintainers should be aware of this upstream note if any commercial downstream use of `ig2_cpsam_fp16.onnx` or `ig2_unet_fp32.onnx` is contemplated, and consult legal counsel if formal commercial clearance is needed.
2. **Hugging Face repository ownership & pinned commit:** `inYourOwnBrowser/imagegrains-2.0-onnx` is external to `LukeAFullard/webGrainy`. If the `webGrainy` maintainer controls `inYourOwnBrowser`, they can push `HF_MODEL_CARD_PROPOSED.md` directly; otherwise, open a Community PR/discussion on Hugging Face. Note that pushing a commit to Hugging Face will create a new commit SHA; `MODEL_REVISION` in `src/modules/modelCache.ts:16` (`7773328a544ac050b7820667e68cbfb02a2e954a`) only needs updating if `webGrainy` is pointed to the new HF commit (the `.onnx` binary LFS OIDs themselves do not change).
3. **Courtesy email to Dr. David Mair:** Decide whether to send the draft courtesy email below to `david.mair@unibe.ch` to notify the ImageGrains authors and confirm they have no objections to the attribution/citation wording.
4. **Formal legal review:** If institutional or commercial compliance sign-off is required, have legal counsel review this technical analysis.

---

## 5. Draft Courtesy Email to ImageGrains Authors

**To:** `david.mair@unibe.ch`  
**Subject:** Courtesy notice & confirmation: ONNX conversion of ImageGrains 2.0 weights (`webGrainy`)

> Dear Dr. Mair and ImageGrains authors,
>
> We have developed an unofficial, client-side browser port of ImageGrains 2.0 (**webGrainy**, BSD 3-Clause, `https://github.com/LukeAFullard/webGrainy`) that runs ONNX-converted versions of your Zenodo pretrained weights (`doi:10.5281/zenodo.15728186`, specifically `IG2_full_set.200525` and `IG2_full_set_cp_SAM`).
>
> The converted ONNX weights are hosted separately on Hugging Face at `https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx` under **CC BY 4.0**, with attribution to all 15 Zenodo creators, full citations to ImageGrains 2.0 (Mair et al., 2026), ImageGrains 1.0 (Mair et al., 2023/2024), Cellpose / Cellpose-SAM, and Segment Anything (SAM), and an explicit statement of the PyTorch-to-ONNX (FP32 / FP16) conversion changes. We are also updating the Hugging Face model card to correct a prior misstatement of `dmair1989/imagegrains`'s software license (from GPL-3.0 to your actual BSD 3-Clause license) and to include all required Apache-2.0 and BSD-3 third-party notices.
>
> Could you please confirm that you have no objections to this CC BY 4.0 redistribution of the converted ONNX weights and our attribution/citation wording? We would also welcome any preferred phrasing if you have one.
>
> Best regards,  
> [Maintainer Name]  
> `webGrainy` Maintainer

---

## 6. Verification Commands

```bash
# 1. Zenodo 15728186 license, creators, files
curl -sL "https://zenodo.org/api/records/15728186" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["metadata"]["license"], len(d["metadata"]["creators"]), [f["key"] for f in d["files"]])'

# 2. dmair1989/imagegrains LICENSE.md
curl -sL "https://raw.githubusercontent.com/dmair1989/imagegrains/main/LICENSE.md" | head -n 5

# 3. MouseLand/cellpose LICENSE & mouseland/cellpose-sam HF license
curl -sL "https://raw.githubusercontent.com/MouseLand/cellpose/main/LICENSE" | head -n 5
curl -sL "https://huggingface.co/api/models/mouseland/cellpose-sam" | python3 -c 'import sys,json; print(json.load(sys.stdin)["cardData"])'

# 4. facebookresearch/segment-anything LICENSE & absence of NOTICE
curl -sL "https://api.github.com/repos/facebookresearch/segment-anything/contents/" | grep -i notice || echo "No NOTICE file"
curl -sL "https://raw.githubusercontent.com/facebookresearch/segment-anything/main/LICENSE" | head -n 5

# 5. HF model card at pinned revision
curl -sL "https://huggingface.co/inYourOwnBrowser/imagegrains-2.0-onnx/raw/7773328a544ac050b7820667e68cbfb02a2e954a/README.md" | tail -n 10
```
