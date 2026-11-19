/**
 * The media type sniffer (src/core/media-type.js): every format a received file can be is told from hand-built bytes
 * shaped by its specification (no real media), including the ISO base media brands of the whole HEIF family, the
 * tracks of an MP4/MOV wherever its index sits, and sound files that a server labels as something else.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isoBrands, isoSampleEntries, sniffMedia, sniffMediaType } from "../../src/core/media-type.js";

const bytes = (...parts) =>
    Buffer.concat(
        parts.map((p) => (Buffer.isBuffer(p) ? p : typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))),
    );
const pad = (b, n = 64) => Buffer.concat([b, Buffer.alloc(Math.max(0, n - b.length))]);
const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
};
/** An ISO box: size, type, body. */
const box = (type, ...body) => {
    const inner = bytes(...body);
    return bytes(u32(8 + inner.length), type, inner);
};
/** A `ftyp` box: major brand, minor version 0, compatible brands. */
const ftyp = (major, ...compatible) => box("ftyp", major, u32(0), ...compatible);
/** A `moov` whose tracks carry these sample entry codes. */
const moov = (...codes) =>
    box(
        "moov",
        box("mvhd", Buffer.alloc(100)),
        ...codes.map((code) =>
            box(
                "trak",
                box(
                    "mdia",
                    box(
                        "minf",
                        box("stbl", box("stsd", u32(0), u32(1), box(code, Buffer.alloc(28))), box("stts", u32(0))),
                    ),
                ),
            ),
        ),
    );
const type = (b) => sniffMediaType(b)?.mime ?? null;

describe("sniffMediaType: pictures", () => {
    it("JPEG, whatever a server called it", () => {
        assert.deepEqual(sniffMediaType(pad(bytes([0xff, 0xd8, 0xff, 0xe0], "\0\x10JFIF\0"))), {
            mime: "image/jpeg",
            ext: "jpg",
        });
        assert.equal(type(pad(bytes([0xff, 0xd8, 0xff, 0xe1], "\0\x10Exif\0"))), "image/jpeg");
    });

    it("PNG, and an animated PNG (acTL before IDAT) is still image/png", () => {
        const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        assert.deepEqual(sniffMediaType(pad(bytes(sig, u32(13), "IHDR", Buffer.alloc(17), u32(0), "IDAT"))), {
            mime: "image/png",
            ext: "png",
        });
        const apng = sniffMediaType(
            pad(bytes(sig, u32(13), "IHDR", Buffer.alloc(17), u32(8), "acTL", Buffer.alloc(12), "IDAT")),
        );
        assert.deepEqual(apng, { mime: "image/png", ext: "png", animated: true });
        assert.equal(type(pad(bytes([0x89, 0x50, 0x4e, 0x47]))), null, "half a signature is not a PNG");
    });

    it("GIF 87a and 89a", () => {
        assert.equal(type(pad(bytes("GIF87a"))), "image/gif");
        assert.equal(type(pad(bytes("GIF89a"))), "image/gif");
        assert.equal(type(pad(bytes("GIF90a"))), null);
    });

    it("WebP: lossy, lossless, and animated (VP8X with the animation flag)", () => {
        assert.deepEqual(sniffMediaType(pad(bytes("RIFF", u32(100), "WEBPVP8 "))), { mime: "image/webp", ext: "webp" });
        assert.equal(type(pad(bytes("RIFF", u32(100), "WEBPVP8L"))), "image/webp");
        const animated = sniffMediaType(pad(bytes("RIFF", u32(100), "WEBPVP8X", u32(10), [0x12, 0, 0, 0])));
        assert.deepEqual(animated, { mime: "image/webp", ext: "webp", animated: true });
        const still = sniffMediaType(pad(bytes("RIFF", u32(100), "WEBPVP8X", u32(10), [0x10, 0, 0, 0])));
        assert.equal(still.animated, undefined, "VP8X without the animation flag is a still picture");
    });

    it("JPEG XL: a bare codestream and the ISO container", () => {
        assert.deepEqual(sniffMediaType(pad(bytes([0xff, 0x0a, 0x2a, 0x12]))), { mime: "image/jxl", ext: "jxl" });
        const container = [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a];
        assert.equal(type(pad(bytes(container))), "image/jxl");
    });

    it("the HEIF family by its ftyp brands, major and compatible", () => {
        const cases = [
            [["heic", "mif1", "heic"], "image/heic"],
            [["heix", "mif1", "heix"], "image/heic"],
            [["heim", "mif1"], "image/heic"],
            [["heis", "mif1"], "image/heic"],
            [["hevc", "msf1", "hevc"], "image/heic-sequence"],
            [["hevx", "msf1"], "image/heic-sequence"],
            [["mif1", "heic"], "image/heic"],
            [["mif1", "miaf"], "image/heif"],
            [["msf1", "iso8"], "image/heif-sequence"],
            [["msf1", "hevc"], "image/heic-sequence"],
            [["avif", "mif1", "miaf", "MA1B"], "image/avif"],
            [["mif1", "avif", "miaf"], "image/avif"],
            [["avis", "msf1", "miaf"], "image/avif"],
        ];
        for (const [[major, ...compatible], mime] of cases) {
            assert.equal(type(pad(bytes(ftyp(major, ...compatible)))), mime, `${major} + ${compatible.join(",")}`);
        }
        assert.equal(sniffMediaType(pad(bytes(ftyp("avis", "msf1")))).animated, true);
        assert.equal(sniffMediaType(pad(bytes(ftyp("hevc", "msf1")))).animated, true);
        assert.equal(sniffMediaType(pad(bytes(ftyp("heic", "mif1")))).ext, "heic");
    });
});

describe("sniffMediaType: movies and sound in the ISO family", () => {
    it("by brand: MP4, MOV, M4A, M4V, 3GP", () => {
        assert.deepEqual(sniffMediaType(pad(bytes(ftyp("isom", "isom", "iso2", "avc1", "mp41")))), {
            mime: "video/mp4",
            ext: "mp4",
        });
        assert.equal(type(pad(bytes(ftyp("mp42", "mp42", "isom")))), "video/mp4");
        assert.deepEqual(sniffMediaType(pad(bytes(ftyp("qt  ", "qt  ")))), { mime: "video/quicktime", ext: "mov" });
        assert.deepEqual(sniffMediaType(pad(bytes(ftyp("M4A ", "M4A ", "mp42", "isom")))), {
            mime: "audio/mp4",
            ext: "m4a",
        });
        assert.equal(type(pad(bytes(ftyp("M4V ", "M4V ", "mp42")))), "video/mp4");
        assert.equal(type(pad(bytes(ftyp("3gp4", "3gp4")))), "video/3gpp");
        assert.equal(type(pad(bytes(ftyp("3g2a", "3g2a")))), "video/3gpp2");
    });

    it("an MP4 that lists an image brand among movie brands is still a movie", () => {
        assert.equal(type(pad(bytes(ftyp("isom", "isom", "mif1")))), "video/mp4");
    });

    it("isoBrands reads the major and compatible brands, and nothing from a file without ftyp", () => {
        assert.deepEqual(isoBrands(bytes(ftyp("heic", "mif1", "heic"))), {
            major: "heic",
            compatible: ["mif1", "heic"],
        });
        assert.equal(isoBrands(pad(bytes("RIFF"))), null);
    });
});

describe("sniffMedia: an MP4's tracks", () => {
    it("names HEVC (hvc1, hev1) and H.264 video, in MP4 and MOV", () => {
        for (const [code, codec] of [
            ["hvc1", "hevc"],
            ["hev1", "hevc"],
            ["avc1", "h264"],
            ["av01", "av1"],
        ]) {
            const mp4 = bytes(ftyp("isom", "isom", "mp41"), moov(code, "mp4a"), box("mdat", Buffer.alloc(32)));
            const got = sniffMedia(mp4);
            assert.deepEqual([got.mime, got.videoCodec, got.audioCodec], ["video/mp4", codec, "aac"], code);
        }
        const mov = sniffMedia(bytes(ftyp("qt  ", "qt  "), moov("hvc1", "mp4a")));
        assert.deepEqual([mov.mime, mov.ext, mov.videoCodec], ["video/quicktime", "mov", "hevc"]);
    });

    it("an MP4 with only sound is audio/mp4, whatever its brand", () => {
        const voice = sniffMedia(bytes(ftyp("isom", "isom", "mp42"), moov("mp4a"), box("mdat", Buffer.alloc(16))));
        assert.deepEqual([voice.mime, voice.ext, voice.audioCodec], ["audio/mp4", "m4a", "aac"]);
        const movieInM4a = sniffMedia(bytes(ftyp("M4A ", "M4A "), moov("avc1", "mp4a")));
        assert.equal(movieInM4a.mime, "video/mp4", "an M4A brand with a picture track is a movie");
    });

    it("finds the index at the end of a file through a reader, reading only box headers and stsd", () => {
        const file = bytes(ftyp("isom", "isom"), box("mdat", Buffer.alloc(200_000, 7)), moov("hvc1", "mp4a"));
        const asked = [];
        const read = (start, end) => {
            asked.push([start, end]);
            return file.subarray(start, end);
        };
        const got = sniffMedia({ read, size: file.length });
        assert.equal(got.videoCodec, "hevc");
        const read200k = asked.reduce((sum, [s, e]) => sum + (e - s), 0);
        assert.ok(read200k < 10_000, `read ${read200k} bytes of ${file.length}`);
    });

    it("isoSampleEntries survives a damaged box size and a 64-bit size", () => {
        const damaged = bytes(ftyp("isom"), u32(3), "moov");
        assert.deepEqual(
            isoSampleEntries((s, e) => damaged.subarray(s, e), damaged.length),
            [],
        );
        const inner = moov("avc1");
        const big = Buffer.alloc(8);
        big.writeBigUInt64BE(BigInt(inner.length + 8));
        const large = bytes(ftyp("isom"), u32(1), "moov", big, inner.subarray(8));
        assert.deepEqual(
            isoSampleEntries((s, e) => large.subarray(s, e), large.length),
            ["avc1"],
        );
    });
});

describe("sniffMediaType: sound", () => {
    it("AAC in ADTS, with and without an ID3 tag", () => {
        const adts = [0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc];
        assert.deepEqual(sniffMediaType(pad(bytes(adts))), { mime: "audio/aac", ext: "aac", audioCodec: "aac" });
        const id3 = bytes("ID3", [4, 0, 0, 0, 0, 0, 10], Buffer.alloc(10));
        assert.equal(type(pad(bytes(id3, adts))), "audio/aac");
    });

    it("MP3: a frame header, and an ID3 tag", () => {
        assert.deepEqual(sniffMediaType(pad(bytes([0xff, 0xfb, 0x90, 0x64]))), {
            mime: "audio/mpeg",
            ext: "mp3",
            audioCodec: "mp3",
        });
        assert.equal(type(pad(bytes("ID3", [3, 0, 0, 0, 0, 0, 4], "TIT2", [0xff, 0xfb, 0x90, 0x64]))), "audio/mpeg");
        assert.equal(type(pad(bytes([0xff, 0xfb, 0xf0, 0x64]))), null, "a bad bitrate index is not a frame");
        assert.equal(type(pad(bytes([0xff, 0xeb, 0x90, 0x64]))), null, "a reserved version is not a frame");
    });

    it("an ID3 tag longer than the head is looked past with a reader", () => {
        const art = Buffer.alloc(9000);
        const size = art.length;
        const id3 = bytes(
            "ID3",
            [4, 0, 0],
            [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f],
            art,
        );
        const aac = bytes(id3, [0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc], Buffer.alloc(32));
        assert.equal(sniffMedia(aac).mime, "audio/aac");
        const mp3 = bytes(id3, [0xff, 0xfb, 0x90, 0x64], Buffer.alloc(32));
        assert.equal(sniffMedia(mp3).mime, "audio/mpeg");
    });

    it("Ogg by its first packet: Opus, Vorbis, Theora", () => {
        const page = (packet) => pad(bytes("OggS", [0, 2], Buffer.alloc(20), [1, packet.length], packet), 80);
        assert.deepEqual(sniffMediaType(page(bytes("OpusHead", [1, 1]))), {
            mime: "audio/ogg",
            ext: "opus",
            audioCodec: "opus",
        });
        assert.equal(sniffMediaType(page(bytes("\x01vorbis", Buffer.alloc(4)))).audioCodec, "vorbis");
        assert.equal(type(page(bytes("\x80theora", Buffer.alloc(4)))), "video/ogg");
    });

    it("AMR and AMR-WB, WAV, FLAC", () => {
        assert.deepEqual(sniffMediaType(pad(bytes("#!AMR\n", [0x3c]))), {
            mime: "audio/amr",
            ext: "amr",
            audioCodec: "amr",
        });
        assert.equal(type(pad(bytes("#!AMR-WB\n", [0x04]))), "audio/amr-wb");
        assert.equal(type(pad(bytes("RIFF", u32(100), "WAVEfmt "))), "audio/wav");
        assert.equal(type(pad(bytes("fLaC", [0, 0, 0, 34]))), "audio/flac");
    });
});

describe("sniffMediaType: containers and documents", () => {
    const ebml = [0x1a, 0x45, 0xdf, 0xa3];
    it("WebM and Matroska by DocType, audio-only when the tracks name only sound", () => {
        const webm = sniffMedia(pad(bytes(ebml, [0x42, 0x82, 0x84], "webm", Buffer.alloc(20), "V_VP9", "A_OPUS"), 200));
        assert.deepEqual([webm.mime, webm.videoCodec, webm.audioCodec], ["video/webm", "vp9", "opus"]);
        const voice = sniffMedia(pad(bytes(ebml, [0x42, 0x82, 0x84], "webm", Buffer.alloc(20), "A_OPUS"), 200));
        assert.deepEqual([voice.mime, voice.ext], ["audio/webm", "weba"]);
        const mkv = sniffMedia(pad(bytes(ebml, [0x42, 0x82, 0x88], "matroska", "V_MPEGH/ISO/HEVC"), 200));
        assert.deepEqual([mkv.mime, mkv.videoCodec], ["video/x-matroska", "hevc"]);
    });

    it("PDF", () => {
        assert.deepEqual(sniffMediaType(pad(bytes("%PDF-1.7\n"))), { mime: "application/pdf", ext: "pdf" });
    });

    it("says nothing about bytes it does not know: text, JSON, an empty or tiny buffer", () => {
        assert.equal(sniffMediaType(pad(bytes('{"v":"5.7.4","layers":[]}'))), null);
        assert.equal(sniffMediaType(pad(bytes("JPEG-PLAINTEXT-BYTES"))), null);
        assert.equal(sniffMediaType(Buffer.alloc(0)), null);
        assert.equal(sniffMediaType(null), null);
        assert.equal(sniffMedia(Buffer.from([0xff])), null);
        assert.equal(type(pad(bytes("RIFF", u32(4), "XXXX"))), null);
    });

    it("takes a Uint8Array as well as a Buffer", () => {
        assert.equal(sniffMediaType(new Uint8Array(pad(bytes("GIF89a")))).mime, "image/gif");
        assert.equal(sniffMedia(new Uint8Array(pad(bytes("GIF89a")))).mime, "image/gif");
    });
});
