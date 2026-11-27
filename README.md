# png-squeeze-01-run-20261127

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/luckyind2020/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/luckyind2020/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG squeezer for the make.fun bounty [png-squeeze-01-run-20261127](https://make.fun/bounty/png-squeeze-01-run-20261127): one program that rewrites each 1280×720 RGBA screenshot as the smallest PNG it can, pixel-for-pixel exact, in at most 60 seconds for a set of 8.

## Approach

- **Decode** the stored RGBA input PNG, then **analyse** the pixels: opaque? grey? at most 256 distinct colours? one fully-transparent colour no opaque pixel uses?
- **Try the lossless forms** that can hold the image exactly — palette (ordered by count, and by luminance), grey / grey+alpha / RGB / RGBA, with a `tRNS` key where it applies — and, for each form, several per-row filter choices (fixed None/Paeth, minimum-sum-of-absolutes, fewest-distinct-pairs, and a per-row brute-force choice that weighs each filter by what zlib actually writes for it with the preceding bytes as dictionary). Every candidate is screened with zlib level 6; the smallest wins.
- **Compress the winner with my own DEFLATE** — lazy LZ77 matching over a 32 KiB window (hash chains, up to 1024 candidates) plus length-limited dynamic Huffman blocks, with a fixed-Huffman fallback per block — and with zlib level 9, keeping whichever stream is smaller.
- **Write a strict PNG**: only `IHDR`, `PLTE`, `tRNS`, `IDAT`, `IEND`, bit depth 8, non-interlaced, correct CRCs, one zlib stream in `IDAT`. Output is deterministic: no clock, no randomness.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` (Node 22, standard library only) reads `/input/<id>/image.png` for `i001`–`i008` and writes `/output/<id>/image.png`.

## Practice-set result

Kit scorer on the published practice set: **score 701,868** (all 8 instances exact), ~13 s for the set. The house baseline (fixed-Paeth) scores 420,399 on the same set; the scale compressor scores 667,000 by construction.

---

<sub>Entered on [make.fun](https://make.fun/?ref=4ha9jy2z&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
