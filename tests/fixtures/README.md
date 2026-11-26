# Synthetic media fixtures

`case-loop.webm` is a 0.6-second, 64×48, silent VP8 test pattern generated locally with FFmpeg's `testsrc` filter at 10 fps (no third-party footage). It is about 3 KB and exists only to exercise real browser decoding and native looping without contacting the owner's R2 bucket. Browser tests fulfill requests at the media boundary; these fixture files are not on either public server allowlist.

Example regeneration with an available FFmpeg build:

```sh
ffmpeg -f lavfi -i testsrc=size=64x48:rate=10 -t 0.6 -an -c:v libvpx -threads 1 -pix_fmt yuv420p -b:v 32k tests/fixtures/case-loop.webm
```
