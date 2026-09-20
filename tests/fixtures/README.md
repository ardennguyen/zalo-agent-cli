# Test fixtures

Real sample media, committed on purpose. ~15 KB total.

| File                                                | What it covers                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `image-64x48.png`                                   | PNG branch of `readImageMetadata()` (big-endian dims at fixed offsets)                 |
| `image-64x48.jpg`                                   | JPEG branch — segment-chain walk to the SOFn marker                                    |
| `image-200x120.jpg`                                 | A second JPEG, so a hard-coded 64×48 cannot pass by accident                           |
| `image-64x48.gif`                                   | GIF branch (little-endian dims) **and** zca-js's separate `getGifMetaData` upload path |
| `image-1x1.webp`                                    | WebP branch, lossy `VP8 ` variant                                                      |
| `notes.txt` `data.csv` `document.pdf` `archive.zip` | The zca-js `"others"` upload path — the one that needs a live WebSocket listener       |

`VP8L` and `VP8X` WebP variants are covered by synthetic headers built inside
`tests/unit/image-metadata.test.js`, since the function only reads the header.

## Why committed rather than generated at runtime

1. `readImageMetadata()` parses four formats with genuinely different code
   paths. Real encoder output exercises them; a hand-rolled 1×1 stub does not.
2. The live suite uploads these to Zalo, which rejects malformed media.
3. Byte-identical inputs every run mean a failure indicates Zalo changed, not
   that a runtime-generated stub came out wrong.

## Integrity

Every fixture has a recorded size + SHA-256 in `index.js`, checked by
`verifyFixtures()`. Tier 2 refuses to upload if anything drifted, and
`tests/unit/image-metadata.test.js` asserts it on every `npm test`.

This is not theoretical: `document.pdf` was silently rewritten on disk by a
PDF handler — a hand-written 453-byte PDF 1.4 became a 4674-byte linearized
PDF 1.6. Magic bytes alone would not have caught it.

**If `verifyFixtures()` fails, do not immediately regenerate the checksums.**
A mismatch you did not intend means something rewrote the file. Find out what
first.

## Regenerating

After a _deliberate_ change:

```bash
node tests/fixtures/checksums.js
```

Paste its output over the `EXPECTED` object in `index.js`.

To rebuild the raster images (Windows, no extra tooling — PowerShell's
`System.Drawing` writes PNG/JPEG/GIF but **not** WebP):

```powershell
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(64, 48)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(24, 90, 160))
$g.Dispose()
$bmp.Save("tests\fixtures\image-64x48.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
```

On Linux/macOS, ImageMagick is simpler:

```bash
magick -size 64x48 xc:'#185AA0' tests/fixtures/image-64x48.png
```

`image-1x1.webp` is the canonical 44-byte minimal lossy WebP test vector. It
is 1×1 only because no WebP encoder was available on the machine that built
these. If you have `cwebp`, a larger one is preferable:

```bash
cwebp -q 80 tests/fixtures/image-64x48.png -o tests/fixtures/image-64x48.webp
```

Update `IMAGES.webp` in `index.js` (name, width, height) and re-run
`checksums.js` if you do.
